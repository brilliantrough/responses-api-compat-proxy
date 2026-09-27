import assert from 'node:assert/strict';

import { createHealthRegistry } from '../src/channel-health.js';
import { createCompactDetectionService } from '../src/compact-support.js';
import { isJsonRecord } from '../src/responses-input-normalization.js';
import type { ChannelConfig } from '../src/routing-config.js';

type FakeSpec = Readonly<{
  status?: number;
  body?: unknown;
  timeout?: boolean;
  networkError?: boolean;
}>;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolver: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: value => {
      if (resolver === undefined) {
        throw new Error('deferred resolver unavailable');
      }
      resolver(value);
    },
  };
}

const apiKey = 'detection-secret';
const specs = new Map<string, FakeSpec>([
  ['supported', { status: 200, body: { object: 'response.compaction', output: [] } }],
  ['unexpected', { status: 200, body: { object: 'response' } }],
  ['route', { status: 404, body: { error: { message: 'missing route' } } }],
  ['auth', { status: 401, body: { error: { message: `invalid key ${apiKey}` } } }],
  ['model', { status: 400, body: { error: { message: 'model does not support compact' } } }],
  ['client', { status: 400, body: { error: { message: 'bad input' } } }],
  ['server', { status: 503, body: { error: { message: 'temporarily unavailable' } } }],
  ['timeout', { timeout: true }],
  ['network', { networkError: true }],
]);

function v2Sse(compaction: boolean): string {
  const item = compaction
    ? { type: 'compaction', encrypted_content: 'encrypted-probe' }
    : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] };
  return [
    'event: response.output_item.done',
    `data: ${JSON.stringify({ type: 'response.output_item.done', item })}`,
    '',
    'event: response.completed',
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: { object: compaction ? 'response.compaction' : 'response', output: [item] },
    })}`,
    '',
  ].join('\n');
}

function assertV2Request(init: RequestInit): void {
  assert.equal(new Headers(init.headers).get('x-codex-beta-features'), 'remote_compaction_v2');
  assert.equal(typeof init.body, 'string');
  const parsed: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  assert.ok(isJsonRecord(parsed));
  assert.equal(parsed.stream, true);
  assert.equal(parsed.store, false);
  assert.ok(Array.isArray(parsed.input));
  const last = parsed.input.at(-1);
  assert.ok(isJsonRecord(last));
  assert.equal(last.type, 'compaction_trigger');
}

function probeResponse(url: string): Response {
  return url.endsWith('/responses/compact')
    ? new Response(JSON.stringify({ object: 'response.compaction' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    : new Response(v2Sse(true), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
}

function channel(id: string, fingerprint = `fingerprint-${id}`): ChannelConfig {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example`,
    responsesUrl: `https://${id}.example/v1/responses`,
    apiKey,
    fingerprint,
    disableCooldown: false,
  };
}

async function main(): Promise<void> {
  const calls = new Map<string, number>();
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const id = new URL(url).hostname.split('.')[0] ?? '';
    const protocol = url.endsWith('/responses/compact') ? 'v1' : 'v2';
    const callKey = `${id}:${protocol}`;
    calls.set(callKey, (calls.get(callKey) ?? 0) + 1);
    const spec = specs.get(id);
    assert.ok(spec, `missing fake spec for ${id}`);

    if (protocol === 'v2') {
      assertV2Request(init);
      if (id === 'timeout') {
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true });
        });
      }
      if (id === 'supported') {
        return new Response(v2Sse(true), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (id === 'unexpected') {
        return new Response(v2Sse(false), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ error: { message: 'missing v2 route' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (spec.timeout) {
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true });
      });
    }
    if (spec.networkError) {
      throw new TypeError('network failed');
    }
    return new Response(JSON.stringify(spec.body), {
      status: spec.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  const channels = Array.from(specs.keys()).map(id => channel(id));
  const health = createHealthRegistry();
  health.reconcile({
    channels: channels.map(item => ({ channelId: item.id, fingerprint: item.fingerprint })),
    modelChannels: channels.map(item => ({ channelId: item.id, canonicalModel: 'compact:model-a' })),
  });
  const healthBefore = health.snapshot();
  const detection = createCompactDetectionService({ fetchImpl, timeoutMs: 10 });

  console.log('=== 1. classify compact support probe responses ===');
  const first = await detection.detectAll(channels, 'model-a');
  assert.equal(first.inProgress, false);
  assert.equal(first.model, 'model-a');
  assert.equal(typeof first.lastCompletedAt, 'number');
  assert.deepEqual(
    first.results.map(item => `${item.channelId}:${item.protocol}`),
    [...specs.keys()].sort().flatMap(channelId => [`${channelId}:v1`, `${channelId}:v2`]),
    'results should be sorted by channel id then protocol',
  );
  const statuses = Object.fromEntries(first.results.map(item => [`${item.channelId}:${item.protocol}`, item.status]));
  assert.equal(statuses['supported:v1'], 'supported');
  assert.equal(statuses['supported:v2'], 'supported');
  assert.equal(statuses['unexpected:v1'], 'error');
  assert.equal(statuses['unexpected:v2'], 'bridge_only');
  assert.equal(statuses['route:v1'], 'unsupported_route');
  assert.equal(statuses['route:v2'], 'unsupported_route');
  assert.equal(statuses['auth:v1'], 'auth_failed');
  assert.equal(statuses['model:v1'], 'model_unsupported');
  assert.equal(statuses['client:v1'], 'error');
  assert.equal(statuses['server:v1'], 'error');
  assert.equal(statuses['timeout:v1'], 'timeout');
  assert.equal(statuses['timeout:v2'], 'timeout');
  assert.equal(statuses['network:v1'], 'error');
  assert.equal(JSON.stringify(first).includes(apiKey), false, 'detection details must redact API keys');

  console.log('=== 2. cached fingerprints skip probes unless forced ===');
  const callsAfterFirst = new Map(calls);
  await detection.detectAll(channels, 'model-a');
  assert.deepEqual(calls, callsAfterFirst);
  await detection.detectAll(channels, 'model-a', { force: true });
  for (const item of channels) {
    assert.equal(calls.get(`${item.id}:v1`), 2);
    assert.equal(calls.get(`${item.id}:v2`), 2);
  }

  console.log('=== 3. model and fingerprint changes create cache misses ===');
  await detection.detectAll(channels, 'model-b');
  for (const item of channels) {
    assert.equal(calls.get(`${item.id}:v1`), 3);
    assert.equal(calls.get(`${item.id}:v2`), 3);
  }
  const rotated = channels.map(item => item.id === 'supported' ? channel(item.id, 'rotated-fingerprint') : item);
  await detection.detectAll(rotated, 'model-b');
  assert.equal(calls.get('supported:v1'), 4);
  assert.equal(calls.get('supported:v2'), 4);
  assert.equal(calls.get('route:v1'), 3);
  assert.equal(calls.get('route:v2'), 3);
  assert.equal(detection.getResults().results.length, channels.length * 2);

  console.log('=== 4. detection leaves health state untouched ===');
  assert.deepEqual(health.snapshot(), healthBefore);
  assert.equal(detection.getRunCount(), 5);

  console.log('=== 5. reset during detection does not restore stale results ===');
  const probeStarted = deferred<void>();
  const probeRelease = deferred<void>();
  const resetDetection = createCompactDetectionService({
    fetchImpl: async url => {
      probeStarted.resolve();
      await probeRelease.promise;
      return probeResponse(url);
    },
  });
  const resetRun = resetDetection.detectAll([channel('supported')], 'model-a');
  await probeStarted.promise;
  resetDetection.reset();
  probeRelease.resolve();
  await resetRun;
  assert.equal(resetDetection.getResults().model, null);
  assert.deepEqual(resetDetection.getResults().results, []);

  console.log('=== 6. concurrent forced detection runs after the active probe ===');
  const firstStarted = deferred<void>();
  const firstRelease = deferred<void>();
  let concurrentCalls = 0;
  const concurrentDetection = createCompactDetectionService({
    fetchImpl: async url => {
      concurrentCalls += 1;
      if (concurrentCalls <= 2) {
        firstStarted.resolve();
        await firstRelease.promise;
      }
      return probeResponse(url);
    },
  });
  const firstRun = concurrentDetection.detectAll([channel('supported')], 'model-a');
  await firstStarted.promise;
  const forcedRun = concurrentDetection.detectAll([channel('supported')], 'model-a', { force: true });
  firstRelease.resolve();
  await Promise.all([firstRun, forcedRun]);
  assert.equal(concurrentCalls, 4);

  console.log('Compact detection checks passed.');
}

await main();
