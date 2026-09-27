import assert from 'node:assert/strict';

import type { RoutingConfig } from '../src/routing-config.js';
import { parseRoutingConfig } from '../src/routing-config.js';
import {
  buildConfiguredModelsResponse,
  resolveModelRoute,
  type ModelResolutionError,
  type ResolvedModelRoute,
} from '../src/model-router.js';
import {
  CANONICAL_GPT_52,
  CANONICAL_GPT_54,
  CHANNEL_A_ID,
  CHANNEL_B_ID,
  LATEST_ALIAS,
  TEST_ROUTING_PATH,
  createValidRoutingDocument,
} from './helpers/test-routing-config.js';

function createConfig(): RoutingConfig {
  return parseRoutingConfig(createValidRoutingDocument(), TEST_ROUTING_PATH);
}

function createAliasDefaultConfig(): RoutingConfig {
  return parseRoutingConfig(
    { ...createValidRoutingDocument(), default_model: LATEST_ALIAS },
    TEST_ROUTING_PATH,
  );
}

function expectResolvedRoute(result: ResolvedModelRoute | ModelResolutionError): ResolvedModelRoute {
  if ('code' in result) {
    throw new Error(`expected resolved route, got ${result.code} for ${result.requestedModel}`);
  }

  return result;
}

function assertCanonicalModelResolvesWithChannelIds(): void {
  // Given
  const config = createConfig();

  // When
  const result = resolveModelRoute(CANONICAL_GPT_54, config);

  // Then
  const resolved = expectResolvedRoute(result);
  assert.deepEqual(resolved, {
    requestedModel: CANONICAL_GPT_54,
    canonicalModel: CANONICAL_GPT_54,
    channelIds: [CHANNEL_A_ID, CHANNEL_B_ID],
  });
}

function assertAliasResolvesToCanonicalRoute(): void {
  // Given
  const config = createConfig();

  // When
  const result = resolveModelRoute(LATEST_ALIAS, config);

  // Then
  const resolved = expectResolvedRoute(result);
  assert.deepEqual(resolved.channelIds, [CHANNEL_A_ID, CHANNEL_B_ID]);
  assert.equal(resolved.canonicalModel, CANONICAL_GPT_54);
}

function assertOmittedModelUsesDefaultModel(): void {
  // Given
  const canonicalDefaultConfig = createConfig();
  const aliasDefaultConfig = createAliasDefaultConfig();
  const inputs = [undefined, null, ''];

  // When / Then
  for (const input of inputs) {
    const canonicalResult = expectResolvedRoute(resolveModelRoute(input, canonicalDefaultConfig));
    assert.deepEqual(canonicalResult, {
      requestedModel: CANONICAL_GPT_54,
      canonicalModel: CANONICAL_GPT_54,
      channelIds: [CHANNEL_A_ID, CHANNEL_B_ID],
    });

    const aliasResult = expectResolvedRoute(resolveModelRoute(input, aliasDefaultConfig));
    assert.deepEqual(aliasResult, {
      requestedModel: CANONICAL_GPT_54,
      canonicalModel: CANONICAL_GPT_54,
      channelIds: [CHANNEL_A_ID, CHANNEL_B_ID],
    });
  }
}

function assertDefaultModelIsCanonical(): void {
  // Given
  const config = createAliasDefaultConfig();

  // Then
  assert.equal(config.defaultModel, CANONICAL_GPT_54);
  const resolved = expectResolvedRoute(resolveModelRoute(undefined, config));
  assert.equal(resolved.requestedModel, CANONICAL_GPT_54);
  assert.equal(resolved.canonicalModel, CANONICAL_GPT_54);
}

function assertUnknownModelReturnsError(): void {
  // Given
  const config = createConfig();

  // When
  const result = resolveModelRoute('unknown-model', config);

  // Then
  if (!('code' in result)) {
    throw new Error(`expected model resolution error for ${result.requestedModel}`);
  }
  assert.deepEqual(result, {
    code: 'model_not_configured',
    requestedModel: 'unknown-model',
  });
}

function assertAliasSharesCanonicalRoute(): void {
  // Given
  const config = createConfig();

  // When
  const aliasResult = expectResolvedRoute(resolveModelRoute(LATEST_ALIAS, config));
  const canonicalResult = expectResolvedRoute(resolveModelRoute(CANONICAL_GPT_54, config));

  // Then
  assert.deepEqual(aliasResult.channelIds, canonicalResult.channelIds);
  assert.equal(aliasResult.canonicalModel, canonicalResult.canonicalModel);
}

function assertRequestedModelPreservesOriginalClientString(): void {
  // Given
  const config = createConfig();

  // When
  const result = resolveModelRoute(LATEST_ALIAS, config);

  // Then
  const resolved = expectResolvedRoute(result);
  assert.equal(resolved.requestedModel, LATEST_ALIAS);
  assert.equal(resolved.canonicalModel, CANONICAL_GPT_54);
}

function assertConfiguredModelsResponseIncludesAllEntries(): void {
  // Given
  const config = createConfig();

  // When
  const response = buildConfiguredModelsResponse(config);

  // Then
  assert.equal(response.object, 'list');
  assert.deepEqual(response.data.map(entry => entry.id), [CANONICAL_GPT_52, CANONICAL_GPT_54, LATEST_ALIAS]);

  for (const entry of response.data) {
    assert.deepEqual(entry, {
      id: entry.id,
      object: 'model',
      created: 0,
      owned_by: 'proxy',
    });
  }
}

function assertConfiguredModelsResponseDeduplicatesSharedIds(): void {
  // Given
  const config: RoutingConfig = {
    path: TEST_ROUTING_PATH,
    defaultModel: CANONICAL_GPT_54,
    channelsById: new Map([
      [CHANNEL_A_ID, { id: CHANNEL_A_ID, name: CHANNEL_A_ID, baseUrl: 'https://channel-a.example', responsesUrl: 'https://channel-a.example/v1/responses', apiKey: 'key-a', fingerprint: 'fingerprint-a' }],
    ]),
    modelRoutes: new Map([
      [CANONICAL_GPT_54, { canonicalModel: CANONICAL_GPT_54, channelIds: [CHANNEL_A_ID] }],
      [CANONICAL_GPT_52, { canonicalModel: CANONICAL_GPT_52, channelIds: [CHANNEL_A_ID] }],
    ]),
    aliases: {
      [CANONICAL_GPT_54]: CANONICAL_GPT_52,
      [LATEST_ALIAS]: CANONICAL_GPT_54,
    },
  };

  // When
  const response = buildConfiguredModelsResponse(config);

  // Then
  const ids = response.data.map(entry => entry.id);
  assert.deepEqual(ids, [CANONICAL_GPT_52, CANONICAL_GPT_54, LATEST_ALIAS]);
  assert.equal(new Set(ids).size, ids.length);
}

function main(): void {
  assertCanonicalModelResolvesWithChannelIds();
  assertAliasResolvesToCanonicalRoute();
  assertOmittedModelUsesDefaultModel();
  assertDefaultModelIsCanonical();
  assertUnknownModelReturnsError();
  assertAliasSharesCanonicalRoute();
  assertRequestedModelPreservesOriginalClientString();
  assertConfiguredModelsResponseIncludesAllEntries();
  assertConfiguredModelsResponseDeduplicatesSharedIds();

  console.log('Model routing checks passed.');
}

main();
