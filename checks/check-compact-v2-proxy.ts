import assert from 'node:assert/strict';

import { isJsonRecord } from '../src/responses-input-normalization.js';
import {
  startV2ProxyHarness,
  V2_TEST_MODEL,
  type V2ProxyHarness,
} from './helpers/compact-v2-test-harness.js';
import type { V2UpstreamMode } from './helpers/compact-v2-test-upstreams.js';

function count(harness: V2ProxyHarness, mode: V2UpstreamMode, trigger = true): number {
  return harness.upstreams.observations.filter(item => item.mode === mode && item.trigger === trigger).length;
}

function findModelHealth(stats: unknown, canonicalModel: string, channelId: string): string | undefined {
  if (!isJsonRecord(stats) || !isJsonRecord(stats.healthSnapshot) || !Array.isArray(stats.healthSnapshot.modelChannels)) {
    return undefined;
  }
  for (const item of stats.healthSnapshot.modelChannels) {
    if (isJsonRecord(item) && item.canonicalModel === canonicalModel && item.channelId === channelId) {
      return typeof item.state === 'string' ? item.state : undefined;
    }
  }
  return undefined;
}

function readStat(stats: unknown, key: string): number | undefined {
  if (!isJsonRecord(stats) || !isJsonRecord(stats.stats)) {
    return undefined;
  }
  const value = stats.stats[key];
  return typeof value === 'number' ? value : undefined;
}

async function assertTrueCompactionAndHeaders(harness: V2ProxyHarness): Promise<void> {
  const response = await harness.requestV2();
  assert.equal(response.status, 200);
  assert.match(response.text, /"type":"compaction"/);
  assert.match(response.text, /encrypted-v2-content/);
  assert.match(response.text, /"object":"response\.compaction"/);
  assert.equal(count(harness, 'reject'), 3);
  assert.equal(count(harness, 'true'), 1);
  const triggerObservations = harness.upstreams.observations.filter(item => item.trigger);
  assert.equal(triggerObservations[0]?.mode, 'reject');
  assert.equal(triggerObservations[3]?.mode, 'true');
  assert.equal(triggerObservations[0]?.betaHeader, 'remote_compaction_v2');
  assert.equal(triggerObservations[1]?.betaHeader, 'remote_compaction_v2');
  assert.equal(triggerObservations[1]?.body.model, V2_TEST_MODEL);

  const preserved = await harness.requestV2('custom-feature, remote_compaction_v2');
  assert.equal(preserved.status, 200);
  assert.equal(harness.upstreams.observations.at(-1)?.betaHeader, 'custom-feature, remote_compaction_v2');
}

async function assertHealthIsolationAndStats(harness: V2ProxyHarness): Promise<void> {
  const stats = await harness.stats();
  assert.equal(findModelHealth(stats, `compact-v2:${V2_TEST_MODEL}`, 'reject'), 'open');
  assert.equal(findModelHealth(stats, V2_TEST_MODEL, 'reject'), 'closed');
  assert.equal(findModelHealth(stats, `compact:${V2_TEST_MODEL}`, 'reject'), 'closed');
  assert.equal(readStat(stats, 'compactV2RequestsTotal'), 2);
  assert.equal(readStat(stats, 'compactV2Fallbacks'), 1);
}

async function assertTimeoutFallback(harness: V2ProxyHarness): Promise<void> {
  await harness.reload({ normal: ['true'], v1: ['true'], v2: ['hang', 'true'] });
  const trueCalls = count(harness, 'true');
  const response = await harness.requestV2();
  assert.equal(response.status, 200);
  assert.match(response.text, /encrypted-v2-content/);
  assert.equal(count(harness, 'hang'), 3);
  assert.equal(count(harness, 'true'), trueCalls + 1);
}

async function assertClientErrorStopsFallback(harness: V2ProxyHarness): Promise<void> {
  await harness.reload({ normal: ['true'], v1: ['true'], v2: ['client', 'true'] });
  const trueCalls = count(harness, 'true');
  const response = await harness.requestV2();
  assert.equal(response.status, 400);
  assert.match(response.text, /maximum context length exceeded/);
  assert.equal(count(harness, 'true'), trueCalls);
}

async function assertBlockedV2Route(harness: V2ProxyHarness): Promise<void> {
  await harness.reload({ normal: ['true', 'reject'], v1: ['true', 'reject'], v2: ['reject'] });
  const first = await harness.requestV2();
  assert.equal(first.status, 404);
  const blocked = await harness.requestV2();
  assert.equal(blocked.status, 503);
  assert.match(blocked.text, /compact_v2_channels_unavailable/);
  assert.ok(blocked.headers.get('retry-after'));
}

async function assertNormalAndUnroutedRequests(harness: V2ProxyHarness): Promise<void> {
  await harness.reload({ normal: ['bridge', 'true'], v1: ['true'] });
  const rejectCalls = count(harness, 'reject');
  const trigger = await harness.requestV2();
  assert.equal(trigger.status, 200);
  assert.match(trigger.text, /normal text/);
  assert.equal(count(harness, 'bridge'), 1, 'missing v2 route should use the normal route');

  const normal = await harness.requestNormal();
  assert.equal(normal.status, 200);
  assert.match(normal.text, /normal text/);
  assert.equal(count(harness, 'bridge', false), 3);
  assert.equal(count(harness, 'true', false), 1, 'normal first-text timeout should still fall back');
  assert.equal(count(harness, 'reject'), rejectCalls);
}

async function main(): Promise<void> {
  const harness = await startV2ProxyHarness({
    normal: ['true', 'reject'],
    v1: ['true', 'reject'],
    v2: ['reject', 'true'],
  });
  try {
    await assertTrueCompactionAndHeaders(harness);
    await assertHealthIsolationAndStats(harness);
    await assertTimeoutFallback(harness);
    await assertClientErrorStopsFallback(harness);
    await assertBlockedV2Route(harness);
    await assertNormalAndUnroutedRequests(harness);
    console.log('Compact v2 proxy checks passed.');
  } finally {
    await harness.close();
  }
}

await main();
