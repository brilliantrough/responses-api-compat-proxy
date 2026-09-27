import assert from 'node:assert/strict';

import { buildHealthTopology } from '../../src/runtime-config.js';
import {
  compactV2HealthKey,
  parseRoutingConfig,
} from '../../src/routing-config.js';
import {
  CANONICAL_GPT_54,
  CHANNEL_A_ID,
  CHANNEL_B_ID,
  LATEST_ALIAS,
  TEST_ROUTING_PATH,
  UNUSED_CHANNEL_ID,
  createRoutingDocumentWithUnusedChannel,
  createValidRoutingDocument,
} from './test-routing-config.js';

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

function captureError(value: unknown): Error {
  try {
    parseRoutingConfig(value, TEST_ROUTING_PATH);
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('expected routing config rejection');
}

export function assertCompactV2RoutingConfig(): void {
  const parsed = parseRoutingConfig(
    {
      ...createValidRoutingDocument(),
      compact: {
        model: LATEST_ALIAS,
        channel_ids: [CHANNEL_A_ID],
        v2_channel_ids: [CHANNEL_B_ID],
      },
    },
    TEST_ROUTING_PATH,
  );
  assert.ok(parsed.compactRoute);
  assert.equal(parsed.compactRoute.canonicalModel, CANONICAL_GPT_54);
  assert.deepEqual(parsed.compactRoute.v2ChannelIds, [CHANNEL_B_ID]);
  assert.equal(compactV2HealthKey(CANONICAL_GPT_54), `compact-v2:${CANONICAL_GPT_54}`);

  const topology = buildHealthTopology(parsed);
  assert.equal(
    topology.modelChannels.some(
      pair => pair.channelId === CHANNEL_B_ID && pair.canonicalModel === `compact-v2:${CANONICAL_GPT_54}`,
    ),
    true,
  );

  const omitted = parseRoutingConfig(
    {
      ...createValidRoutingDocument(),
      compact: { model: CANONICAL_GPT_54, channel_ids: [CHANNEL_A_ID] },
    },
    TEST_ROUTING_PATH,
  );
  assert.deepEqual(omitted.compactRoute?.v2ChannelIds, []);
}

export function assertCompactV2Validation(): void {
  const base = createValidRoutingDocument();
  const duplicate = captureError({
    ...base,
    compact: {
      model: CANONICAL_GPT_54,
      channel_ids: [CHANNEL_A_ID],
      v2_channel_ids: [CHANNEL_B_ID, CHANNEL_B_ID],
    },
  });
  assert.match(duplicate.message, /compact\.v2_channel_ids\[1\].*duplicate/);

  const unknown = captureError({
    ...base,
    compact: {
      model: CANONICAL_GPT_54,
      channel_ids: [CHANNEL_A_ID],
      v2_channel_ids: ['missing-channel'],
    },
  });
  assert.match(unknown.message, /compact\.v2_channel_ids\[0\].*unknown channel/);

  const empty = captureError({
    ...base,
    compact: {
      model: CANONICAL_GPT_54,
      channel_ids: [CHANNEL_A_ID],
      v2_channel_ids: [],
    },
  });
  assert.match(empty.message, /compact\.v2_channel_ids.*non-empty array/);
}

export function assertCompactV2OnlyChannelsDoNotWarn(): void {
  const document = createRoutingDocumentWithUnusedChannel();
  const warnings = captureWarnings(() => {
    parseRoutingConfig(
      {
        ...document,
        compact: {
          model: CANONICAL_GPT_54,
          channel_ids: [CHANNEL_A_ID],
          v2_channel_ids: [UNUSED_CHANNEL_ID],
        },
      },
      TEST_ROUTING_PATH,
    );
  });
  assert.equal(warnings.length, 0);
}
