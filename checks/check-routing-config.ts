import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  compactHealthKey,
  listConfiguredModels,
  loadRoutingConfig,
  parseRoutingConfig,
} from '../src/routing-config.js';
import {
  CANONICAL_GPT_52,
  CANONICAL_GPT_54,
  CHANNEL_A_ID,
  CHANNEL_A_KEY,
  CHANNEL_B_ID,
  CHANNEL_B_KEY,
  LATEST_ALIAS,
  TEST_ROUTING_PATH,
  UNUSED_CHANNEL_ID,
  createChannelA,
  createChannelB,
  createRoutingDocumentWithUnusedChannel,
  createUnusedChannel,
  createValidCompactSection,
  createValidRoutingDocument,
} from './helpers/test-routing-config.js';
import { assertCompactV2OnlyChannelsDoNotWarn, assertCompactV2RoutingConfig, assertCompactV2Validation } from './helpers/check-routing-compact-v2.js';

type RejectCase = Readonly<{
  name: string;
  value: unknown;
  messagePattern: RegExp;
}>;

const SECRET_URL = 'https://user:pass@secret.example///';
const SECRET_KEY = 'key-secret-000';
const FORBIDDEN_ERROR_SNIPPETS = [
  CHANNEL_A_KEY,
  CHANNEL_B_KEY,
  SECRET_KEY,
  SECRET_URL,
  `${CHANNEL_A_ID}|https://channel-a.example|${CHANNEL_A_KEY}`,
] as const;

function expectedFingerprint(id: string, baseUrl: string, apiKey: string): string {
  return createHash('sha256').update(`${id}|${baseUrl}|${apiKey}`).digest('hex');
}

function captureError(action: () => void): Error {
  let captured: Error | undefined;

  try {
    action();
  } catch (error) {
    if (error instanceof Error) {
      captured = error;
    } else {
      throw new Error('expected parser to throw an Error instance');
    }
  }

  assert.ok(captured, 'expected parser to reject the document');
  return captured;
}

function assertSecretSafe(message: string): void {
  for (const snippet of FORBIDDEN_ERROR_SNIPPETS) {
    assert.equal(message.includes(snippet), false, `message leaked ${snippet}`);
  }
}

function captureWarnings(action: () => void): readonly string[] {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...values: unknown[]) => {
    warnings.push(values.map(value => String(value)).join(' '));
  };

  try {
    action();
  } finally {
    console.warn = originalWarn;
  }

  return warnings;
}

function assertValidDocumentParses(): void {
  const config = parseRoutingConfig(createValidRoutingDocument(), TEST_ROUTING_PATH);

  assert.equal(config.path, TEST_ROUTING_PATH);
  assert.equal(config.defaultModel, CANONICAL_GPT_54);
  assert.deepEqual(listConfiguredModels(config), [CANONICAL_GPT_52, CANONICAL_GPT_54]);
  assert.deepEqual(config.aliases, { [LATEST_ALIAS]: CANONICAL_GPT_54 });

  const channelA = config.channelsById.get(CHANNEL_A_ID);
  assert.ok(channelA, 'channel-a should parse');
  assert.equal(channelA.id, CHANNEL_A_ID);
  assert.equal(channelA.name, 'Channel A');
  assert.equal(channelA.baseUrl, 'https://channel-a.example');
  assert.equal(channelA.responsesUrl, 'https://channel-a.example/v1/responses');
  assert.equal(channelA.apiKey, CHANNEL_A_KEY);
  assert.equal(
    channelA.fingerprint,
    expectedFingerprint(CHANNEL_A_ID, 'https://channel-a.example', CHANNEL_A_KEY),
  );
  assert.match(channelA.fingerprint, /^[a-f0-9]{64}$/);

  const channelB = config.channelsById.get(CHANNEL_B_ID);
  assert.ok(channelB, 'channel-b should parse');
  assert.equal(channelB.name, CHANNEL_B_ID, 'channel name defaults to id');
  assert.equal(channelB.responsesUrl, 'https://channel-b.example/v1/responses');

  const gpt54 = config.modelRoutes.get(CANONICAL_GPT_54);
  assert.ok(gpt54, 'gpt-5.4 route should parse');
  assert.equal(gpt54.canonicalModel, CANONICAL_GPT_54);
  assert.deepEqual(gpt54.channelIds, [CHANNEL_A_ID, CHANNEL_B_ID]);
}

function assertDefaultAliasCanonicalizes(): void {
  const config = parseRoutingConfig(
    { ...createValidRoutingDocument(), default_model: LATEST_ALIAS },
    TEST_ROUTING_PATH,
  );

  assert.equal(config.defaultModel, CANONICAL_GPT_54);
}

function assertLoadRoutingConfigReadsFile(): void {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'responses-routing-config-'));
  const routingPath = path.join(tempDir, 'fallback.json');

  try {
    writeFileSync(routingPath, JSON.stringify(createValidRoutingDocument(), null, 2), 'utf8');
    const config = loadRoutingConfig(routingPath);

    assert.equal(config.path, routingPath);
    assert.deepEqual(listConfiguredModels(config), [CANONICAL_GPT_52, CANONICAL_GPT_54]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertUnusedChannelsWarn(): void {
  const warnings = captureWarnings(() => {
    parseRoutingConfig(createRoutingDocumentWithUnusedChannel(), TEST_ROUTING_PATH);
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', new RegExp(`unused channel.*${UNUSED_CHANNEL_ID}`));
  assertSecretSafe(warnings.join('\n'));
}

function assertFingerprintsAreStable(): void {
  const first = parseRoutingConfig(createValidRoutingDocument(), TEST_ROUTING_PATH);
  const second = parseRoutingConfig(createValidRoutingDocument(), TEST_ROUTING_PATH);
  const firstChannel = first.channelsById.get(CHANNEL_A_ID);
  const secondChannel = second.channelsById.get(CHANNEL_A_ID);

  assert.ok(firstChannel, 'first channel should parse');
  assert.ok(secondChannel, 'second channel should parse');
  assert.equal(firstChannel.fingerprint, secondChannel.fingerprint);
}

function assertCompactRouteParses(): void {
  const config = parseRoutingConfig(
    { ...createValidRoutingDocument(), compact: createValidCompactSection() },
    TEST_ROUTING_PATH,
  );

  assert.ok(config.compactRoute, 'compact route should parse');
  assert.equal(config.compactRoute.canonicalModel, CANONICAL_GPT_54);
  assert.deepEqual(config.compactRoute.channelIds, [CHANNEL_B_ID, CHANNEL_A_ID]);
  assert.equal(compactHealthKey(CANONICAL_GPT_54), `compact:${CANONICAL_GPT_54}`);
}

function assertCompactAbsentWhenOmitted(): void {
  const config = parseRoutingConfig(createValidRoutingDocument(), TEST_ROUTING_PATH);
  assert.equal(config.compactRoute, undefined, 'compact route should be optional');
}

function assertCompactAliasCanonicalizes(): void {
  const config = parseRoutingConfig(
    { ...createValidRoutingDocument(), compact: { model: LATEST_ALIAS, channel_ids: [CHANNEL_A_ID] } },
    TEST_ROUTING_PATH,
  );

  assert.ok(config.compactRoute, 'compact route should parse via alias');
  assert.equal(config.compactRoute.canonicalModel, CANONICAL_GPT_54);
}

function assertCompactOnlyChannelsDoNotWarn(): void {
  const doc = createRoutingDocumentWithUnusedChannel();
  const warnings = captureWarnings(() => {
    parseRoutingConfig(
      { ...doc, compact: { model: CANONICAL_GPT_54, channel_ids: [UNUSED_CHANNEL_ID] } },
      TEST_ROUTING_PATH,
    );
  });

  assert.equal(warnings.length, 0, 'compact-only channels should count as used');
}

function rejectionCases(): readonly RejectCase[] {
  return [
    { name: 'root null', value: null, messagePattern: /root/ },
    { name: 'root array', value: [], messagePattern: /root/ },
    {
      name: 'old fallback_api_config root',
      value: { ...createValidRoutingDocument(), fallback_api_config: [] },
      messagePattern: /fallback_api_config/,
    },
    {
      name: 'missing default_model',
      value: { channels: [createChannelA()], models: { [CANONICAL_GPT_54]: { channel_ids: [CHANNEL_A_ID] } }, aliases: {} },
      messagePattern: /default_model/,
    },
    { name: 'empty default_model', value: { ...createValidRoutingDocument(), default_model: '   ' }, messagePattern: /default_model/ },
    { name: 'unknown default_model', value: { ...createValidRoutingDocument(), default_model: 'unknown-model' }, messagePattern: /default_model/ },
    { name: 'channels not array', value: { ...createValidRoutingDocument(), channels: {} }, messagePattern: /channels/ },
    { name: 'channels empty', value: { ...createValidRoutingDocument(), channels: [] }, messagePattern: /channels/ },
    { name: 'channel empty id', value: { ...createValidRoutingDocument(), channels: [{ ...createChannelA(), id: ' ' }] }, messagePattern: /channels\[0\]\.id/ },
    { name: 'channel duplicate id', value: { ...createValidRoutingDocument(), channels: [createChannelA(), { ...createChannelB(), id: CHANNEL_A_ID }] }, messagePattern: /duplicate/ },
    { name: 'channel empty base_url', value: { ...createValidRoutingDocument(), channels: [{ ...createChannelA(), base_url: ' ' }] }, messagePattern: /base_url/ },
    { name: 'channel empty api_key', value: { ...createValidRoutingDocument(), channels: [{ ...createChannelA(), api_key: '' }] }, messagePattern: /api_key/ },
    { name: 'channel api_key_env', value: { ...createValidRoutingDocument(), channels: [{ ...createChannelA(), api_key_env: 'KEY_ENV' }] }, messagePattern: /api_key_env/ },
    { name: 'channel disable_cooldown not boolean', value: { ...createValidRoutingDocument(), channels: [{ ...createChannelA(), disable_cooldown: 'yes' }] }, messagePattern: /disable_cooldown.*boolean/ },
    { name: 'models missing', value: { default_model: CANONICAL_GPT_54, channels: [createChannelA()], aliases: {} }, messagePattern: /models/ },
    { name: 'models not object', value: { ...createValidRoutingDocument(), models: [] }, messagePattern: /models/ },
    { name: 'empty canonical model', value: { ...createValidRoutingDocument(), default_model: CANONICAL_GPT_54, models: { '': { channel_ids: [CHANNEL_A_ID] } } }, messagePattern: /models\[''\]/ },
    { name: 'route not object', value: { ...createValidRoutingDocument(), models: { [CANONICAL_GPT_54]: [] } }, messagePattern: /models\['gpt-5\.4'\]/ },
    { name: 'route empty', value: { ...createValidRoutingDocument(), models: { [CANONICAL_GPT_54]: { channel_ids: [] } } }, messagePattern: /channel_ids/ },
    { name: 'route repeats channel', value: { ...createValidRoutingDocument(), models: { [CANONICAL_GPT_54]: { channel_ids: [CHANNEL_A_ID, CHANNEL_A_ID] } } }, messagePattern: /duplicate/ },
    { name: 'route unknown channel', value: { ...createValidRoutingDocument(), models: { [CANONICAL_GPT_54]: { channel_ids: [CHANNEL_A_ID, 'missing-channel'] } } }, messagePattern: /unknown channel/ },
    { name: 'aliases not object', value: { ...createValidRoutingDocument(), aliases: [] }, messagePattern: /aliases/ },
    { name: 'alias empty name', value: { ...createValidRoutingDocument(), aliases: { '': CANONICAL_GPT_54 } }, messagePattern: /aliases\[''\]/ },
    { name: 'alias empty target', value: { ...createValidRoutingDocument(), aliases: { [LATEST_ALIAS]: '' } }, messagePattern: /aliases\['gpt-latest'\]/ },
    { name: 'alias collides with canonical', value: { ...createValidRoutingDocument(), aliases: { [CANONICAL_GPT_54]: CANONICAL_GPT_52 } }, messagePattern: /collides/ },
    { name: 'alias chains', value: { ...createValidRoutingDocument(), aliases: { [LATEST_ALIAS]: 'nested-alias', 'nested-alias': CANONICAL_GPT_54 } }, messagePattern: /another alias/ },
    { name: 'alias unknown canonical', value: { ...createValidRoutingDocument(), aliases: { [LATEST_ALIAS]: 'unknown-model' } }, messagePattern: /unknown canonical model/ },
    {
      name: 'credentialed base url does not leak',
      value: { ...createValidRoutingDocument(), channels: [{ id: 'secret-channel', base_url: SECRET_URL, api_key: SECRET_KEY }] },
      messagePattern: /unknown channel/,
    },
    { name: 'compact not object', value: { ...createValidRoutingDocument(), compact: [] }, messagePattern: /compact/ },
    { name: 'compact missing model', value: { ...createValidRoutingDocument(), compact: { channel_ids: [CHANNEL_A_ID] } }, messagePattern: /compact\.model/ },
    { name: 'compact unknown model', value: { ...createValidRoutingDocument(), compact: { model: 'unknown-model', channel_ids: [CHANNEL_A_ID] } }, messagePattern: /compact\.model/ },
    { name: 'compact empty channel_ids', value: { ...createValidRoutingDocument(), compact: { model: CANONICAL_GPT_54, channel_ids: [] } }, messagePattern: /compact\.channel_ids/ },
    { name: 'compact repeats channel', value: { ...createValidRoutingDocument(), compact: { model: CANONICAL_GPT_54, channel_ids: [CHANNEL_A_ID, CHANNEL_A_ID] } }, messagePattern: /compact\.channel_ids\[1\].*duplicate/ },
    { name: 'compact unknown channel', value: { ...createValidRoutingDocument(), compact: { model: CANONICAL_GPT_54, channel_ids: ['missing-channel'] } }, messagePattern: /compact\.channel_ids\[0\].*unknown channel/ },
  ];
}

function assertRejectionRules(): void {
  for (const rejectCase of rejectionCases()) {
    const error = captureError(() => {
      parseRoutingConfig(rejectCase.value, TEST_ROUTING_PATH);
    });

    assert.match(error.message, rejectCase.messagePattern, rejectCase.name);
    assertSecretSafe(error.message);
  }
}

function main(): void {
  assertValidDocumentParses();
  assertDefaultAliasCanonicalizes();
  assertLoadRoutingConfigReadsFile();
  assertUnusedChannelsWarn();
  assertFingerprintsAreStable();
  assertCompactRouteParses();
  assertCompactAbsentWhenOmitted();
  assertCompactAliasCanonicalizes();
  assertCompactOnlyChannelsDoNotWarn();
  assertCompactV2RoutingConfig();
  assertCompactV2Validation();
  assertCompactV2OnlyChannelsDoNotWarn();
  assertRejectionRules();

  console.log('Routing config checks passed.');
}

main();
