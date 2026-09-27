import assert from 'node:assert/strict';

import { resolveModelRoute } from '../src/model-router.js';
import type { RoutingConfig } from '../src/routing-config.js';

const ALIAS_MODEL = 'gpt-5.1-codex-mini';
const CANONICAL_MODEL = 'gpt-5.4';

const routingConfig = {
  path: 'synthetic-routing-config.json',
  defaultModel: CANONICAL_MODEL,
  channelsById: new Map([
    [
      'primary',
      {
        id: 'primary',
        name: 'mapped-primary',
        baseUrl: 'https://primary.example',
        responsesUrl: 'https://primary.example/v1/responses',
        apiKey: 'primary-key',
        fingerprint: 'primary-fingerprint',
      },
    ],
  ]),
  modelRoutes: new Map([
    [
      CANONICAL_MODEL,
      {
        canonicalModel: CANONICAL_MODEL,
        channelIds: ['primary'],
      },
    ],
  ]),
  aliases: {
    [ALIAS_MODEL]: CANONICAL_MODEL,
  },
} satisfies RoutingConfig;

const resolved = resolveModelRoute(ALIAS_MODEL, routingConfig);

if ('code' in resolved) {
  assert.fail(`Expected alias ${ALIAS_MODEL} to resolve to ${CANONICAL_MODEL}`);
}

assert.equal(resolved.requestedModel, ALIAS_MODEL);
assert.equal(resolved.canonicalModel, CANONICAL_MODEL);
assert.deepEqual(resolved.channelIds, ['primary']);

console.log('Model mapping checks passed.');
