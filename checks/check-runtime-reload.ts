import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHealthRegistry, type HealthRegistry, type HealthSnapshot } from '../src/channel-health.js';
import {
  buildHealthTopology,
  createRuntimeConfigStore,
  createEndpointStateKey,
  type RuntimeConfigStore,
} from '../src/runtime-config.js';
import type { ChannelConfig, RoutingConfig } from '../src/routing-config.js';

// allow: SIZE_OK - this executable check intentionally keeps runtime reload sections 1-13 together.

const CHANNEL_A_ID = 'channel-a';
const CHANNEL_B_ID = 'channel-b';
const MODEL_A = 'gpt-5.4';
const MODEL_B = 'gpt-5.2';
const MODEL_ALIAS = 'gpt-latest';
const CHANNEL_A_KEY = 'channel-a-key';
const CHANNEL_A_ROTATED_KEY = 'channel-a-key-rotated';
const CHANNEL_B_KEY = 'channel-b-key';

type RoutingDocument = Readonly<{
  default_model: string;
  channels: readonly Readonly<{
    id: string;
    name?: string;
    base_url: string;
    api_key: string;
  }>[];
  models: Readonly<Record<string, Readonly<{ channel_ids: readonly string[] }>>>;
  aliases: Readonly<Record<string, string>>;
}>;

type FakeClock = Readonly<{
  now(): number;
  advance(ms: number): void;
}>;

const allTempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'responses-runtime-'));
  allTempDirs.push(dir);
  return dir;
}

function writeDotEnv(dir: string, lines: string[]) {
  const envPath = path.join(dir, '.env');
  const fallbackPath = path.join(dir, 'fallback.json');
  const full = [
    ...lines,
    `FALLBACK_CONFIG_PATH=${fallbackPath}`,
  ].join('\n');
  writeFileSync(envPath, full, 'utf8');
}

function writeFallbackJson(dir: string, content: unknown) {
  writeFileSync(path.join(dir, 'fallback.json'), JSON.stringify(content, null, 2), 'utf8');
}

function createFakeClock(startedAt = 1_000): FakeClock {
  let current = startedAt;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function createRoutingDocument(channelAApiKey = CHANNEL_A_KEY): RoutingDocument {
  return {
    default_model: MODEL_A,
    channels: [
      { id: CHANNEL_A_ID, name: 'Channel A', base_url: 'https://channel-a.example', api_key: channelAApiKey },
      { id: CHANNEL_B_ID, base_url: 'https://channel-b.example', api_key: CHANNEL_B_KEY },
    ],
    models: {
      [MODEL_A]: { channel_ids: [CHANNEL_A_ID, CHANNEL_B_ID] },
      [MODEL_B]: { channel_ids: [CHANNEL_B_ID, CHANNEL_A_ID] },
    },
    aliases: {
      [MODEL_ALIAS]: MODEL_A,
    },
  };
}

function createRoutingDocumentWithoutModelB(): RoutingDocument {
  const base = createRoutingDocument();
  return {
    ...base,
    models: {
      [MODEL_A]: { channel_ids: [CHANNEL_A_ID, CHANNEL_B_ID] },
    },
  };
}

function routingConfigPath(dir: string): string {
  return path.join(dir, 'fallback.json');
}

function writeRuntimeFiles(dir: string, routingDocument: RoutingDocument): string {
  writeFallbackJson(dir, routingDocument);
  writeDotEnv(dir, []);

  return path.join(dir, '.env');
}

function registerHealthRegistry(store: RuntimeConfigStore, registry: HealthRegistry): void {
  assert.ok(store.registerHealthRegistry, 'runtime store should expose health registry registration');
  store.registerHealthRegistry(registry);
}

function createStoreWithHealth(clock: FakeClock): Readonly<{
  dir: string;
  store: RuntimeConfigStore;
  registry: HealthRegistry;
}> {
  const dir = makeTempDir();
  const envPath = writeRuntimeFiles(dir, createRoutingDocument());
  const registry = createHealthRegistry({ now: clock.now });
  const store = createRuntimeConfigStore({ envPath, routingConfigPath: routingConfigPath(dir) });
  registerHealthRegistry(store, registry);

  return { dir, store, registry };
}

function getRoutingConfig(store: RuntimeConfigStore): RoutingConfig {
  const routingConfig = store.getSnapshot().routingConfig;
  assert.ok(routingConfig, 'expected routing config in runtime snapshot');
  return routingConfig;
}

function getRoutingChannel(config: RoutingConfig, channelId: string): ChannelConfig {
  const channel = config.channelsById.get(channelId);
  assert.ok(channel, `expected routing channel ${channelId}`);
  return channel;
}

function acquireChannelALease(registry: HealthRegistry, channelFingerprint: string) {
  const lease = registry.acquire({ channelId: CHANNEL_A_ID, channelFingerprint, canonicalModel: MODEL_A });
  assert.equal(lease.ok, true, 'expected health lease acquire to succeed');
  return lease.lease;
}

function openChannelACircuit(registry: HealthRegistry, channelFingerprint: string): void {
  for (let i = 0; i < 15; i++) {
  registry.complete(acquireChannelALease(registry, channelFingerprint), {
    scope: 'channel',
    success: false,
    reason: 'auth',
    channelReachabilityProven: true,
  });
  }
}

function getChannel(snapshot: HealthSnapshot, channelId: string) {
  const record = snapshot.channels.find(entry => entry.channelId === channelId);
  assert.ok(record, `expected channel ${channelId} in health snapshot`);
  return record;
}

function findModelChannel(snapshot: HealthSnapshot, canonicalModel: string, channelId: string) {
  return snapshot.modelChannels.find(entry => entry.channelId === channelId && entry.canonicalModel === canonicalModel);
}

function getModelChannel(snapshot: HealthSnapshot, canonicalModel: string, channelId: string) {
  const record = findModelChannel(snapshot, canonicalModel, channelId);
  assert.ok(record, `expected model-channel ${channelId}/${canonicalModel} in health snapshot`);
  return record;
}

function restoreEnvPermissions(dir: string): void {
  const envPath = path.join(dir, '.env');
  if (existsSync(envPath)) {
    chmodSync(envPath, 0o644);
  }
}

function main() {
  try {
    // === 1. Initial runtimeVersion 1 and routing config from env file ===
    console.log('=== 1. Initial runtimeVersion 1 and routing config ===');
    const dir1 = makeTempDir();
    writeFallbackJson(dir1, createRoutingDocument());
    writeDotEnv(dir1, [
      'PORT=8080',
      'HOST=0.0.0.0',
    ]);

    const store1 = createRuntimeConfigStore({ envPath: path.join(dir1, '.env'), routingConfigPath: routingConfigPath(dir1) });
    const snap1 = store1.getSnapshot();

    assert.equal(snap1.runtimeVersion, 1, 'initial runtimeVersion should be 1');
    assert.equal(snap1.config.routingConfig.defaultModel, MODEL_A, 'default model from routing config');
    assert.equal(snap1.config.port, 8080, 'port from env');
    assert.equal(snap1.envPath, path.join(dir1, '.env'), 'envPath in snapshot');
    assert.deepEqual(snap1.restartRequiredFields, [], 'no restart required on initial load');
    assert.equal(snap1.config.routingConfig.channelsById.size, 2, 'routing channels loaded');
    assert.ok(snap1.routingConfig, 'routing config present with routingConfigPath');

    // === 2. Successful reload increments version and changes config values ===
    console.log('=== 2. Successful reload increments version ===');
    writeDotEnv(dir1, [
      'PROXY_HEALTH_COOLDOWN_MS=111',
      'PORT=8080',
      'HOST=0.0.0.0',
    ]);

    const result2 = store1.reloadFromFiles();
    assert.equal(result2.ok, true, 'reload should succeed');
    const snap2 = store1.getSnapshot();
    assert.equal(snap2.runtimeVersion, 2, 'version incremented after reload');
    assert.equal(snap2.config.healthCooldownMs, 111, 'channel cooldown updated after reload');

    // === 3. Changing PORT reports restartRequiredFields ["PORT"] ===
    console.log('=== 3. PORT change reports restartRequiredFields ===');
    writeDotEnv(dir1, [
      'PORT=9090',
      'HOST=0.0.0.0',
    ]);

    const result3 = store1.reloadFromFiles();
    assert.equal(result3.ok, true, 'reload with port change should succeed');
    const snap3 = store1.getSnapshot();
    assert.ok(snap3.restartRequiredFields.includes('PORT'), 'PORT should be in restartRequiredFields');

    // === 3b. Changing HOST reports restartRequiredFields ["HOST"] ===
    console.log('=== 3b. HOST change reports restartRequiredFields ===');
    writeDotEnv(dir1, [
      'PORT=9090',
      'HOST=127.0.0.1',
    ]);

    const result3b = store1.reloadFromFiles();
    assert.equal(result3b.ok, true);
    const snap3b = store1.getSnapshot();
    assert.ok(snap3b.restartRequiredFields.includes('HOST'), 'HOST should be in restartRequiredFields');

    // === 4. Failed reload keeps prior snapshot/version ===
    console.log('=== 4. Failed reload keeps prior snapshot ===');
    writeFallbackJson(dir1, { default_model: MODEL_A });

    const result4 = store1.reloadFromFiles();
    assert.equal(result4.ok, false, 'reload with invalid routing config should fail');
    if (!result4.ok) {
      assert.ok(result4.error, 'should have error message');
    }
    const snap4 = store1.getSnapshot();
    assert.equal(snap4.runtimeVersion, snap3b.runtimeVersion, 'version unchanged after failed reload');
    assert.equal(snap4.config.host, '127.0.0.1', 'config unchanged after failed reload');
    assert.equal(snap4.config.port, 9090, 'port unchanged after failed reload');

    // === 5. createEndpointStateKey stability ===
    console.log('=== 5. createEndpointStateKey ===');
    const key1 = createEndpointStateKey({ name: 'primary', url: 'https://api.example/v1/responses' });
    const key2 = createEndpointStateKey({ name: 'primary', url: 'https://api.example/v1/responses' });
    assert.equal(key1, key2, 'same name+url produces same key');

    const key3 = createEndpointStateKey({ name: 'primary', url: 'https://other.example/v1/responses' });
    assert.notEqual(key1, key3, 'different url produces different key');

    writeFallbackJson(dir1, createRoutingDocument());

    // === 6. Routing config loaded from files ===
    console.log('=== 6. Routing config loaded from temp files ===');
    const dir6 = makeTempDir();
    writeFallbackJson(dir6, createRoutingDocument());
    writeDotEnv(dir6, []);

    const store6 = createRuntimeConfigStore({ envPath: path.join(dir6, '.env'), routingConfigPath: routingConfigPath(dir6) });
    const snap6 = store6.getSnapshot();

    assert.equal(snap6.config.routingConfig.channelsById.size, 2, 'two routing channels loaded');
    assert.equal(snap6.config.routingConfig.aliases[MODEL_ALIAS], MODEL_A, 'routing alias loaded');

    // === 7. Unreadable env file causes reload to fail ===
    console.log('=== 7. Unreadable env file fails reload ===');
    const dir7 = makeTempDir();
    writeFallbackJson(dir7, createRoutingDocument());
    writeDotEnv(dir7, [
      'PORT=8080',
      'HOST=0.0.0.0',
    ]);

    const store7 = createRuntimeConfigStore({ envPath: path.join(dir7, '.env'), routingConfigPath: routingConfigPath(dir7) });
    assert.equal(store7.getSnapshot().runtimeVersion, 1, 'initial version');

    chmodSync(path.join(dir7, '.env'), 0o000);
    const result7 = store7.reloadFromFiles();
    assert.equal(result7.ok, false, 'reload should fail on unreadable env file');
    if (!result7.ok) {
      assert.ok(result7.error.length > 0, 'error message present');
    }
    assert.equal(store7.getSnapshot().runtimeVersion, 1, 'version preserved after read failure');
    chmodSync(path.join(dir7, '.env'), 0o644);

    // === 8. Routing config loaded alongside env ===
    console.log('=== 8. Routing config loaded alongside env ===');
    const dir8 = makeTempDir();
    const envPath8 = writeRuntimeFiles(dir8, createRoutingDocument());
    const store8 = createRuntimeConfigStore({ envPath: envPath8, routingConfigPath: routingConfigPath(dir8) });
    const routing8 = getRoutingConfig(store8);
    const topology8 = buildHealthTopology(routing8);

    assert.equal(routing8.channelsById.size, 2, 'routing config should load two channels');
    assert.deepEqual(Array.from(routing8.modelRoutes.keys()), [MODEL_A, MODEL_B], 'routing config should load canonical models');
    assert.equal(routing8.aliases[MODEL_ALIAS], MODEL_A, 'routing config should load aliases');
    assert.deepEqual(topology8.channels.map(channel => channel.channelId), [CHANNEL_A_ID, CHANNEL_B_ID], 'topology channels should follow routing channels');
    assert.deepEqual(
      topology8.modelChannels.map(pair => `${pair.channelId}/${pair.canonicalModel}`),
      [`${CHANNEL_A_ID}/${MODEL_A}`, `${CHANNEL_B_ID}/${MODEL_A}`, `${CHANNEL_B_ID}/${MODEL_B}`, `${CHANNEL_A_ID}/${MODEL_B}`],
      'topology should contain every configured model-channel pair',
    );

    // === 9. Health reconcile on reload preserves matching fingerprint ===
    console.log('=== 9. Health reconcile on reload preserves matching fingerprint ===');
    const clock9 = createFakeClock();
    const harness9 = createStoreWithHealth(clock9);
    const fingerprint9 = getRoutingChannel(getRoutingConfig(harness9.store), CHANNEL_A_ID).fingerprint;
    openChannelACircuit(harness9.registry, fingerprint9);

    writeFallbackJson(harness9.dir, createRoutingDocument());
    const result9 = harness9.store.reloadFromFiles();

    assert.equal(result9.ok, true, 'reload with identical routing config should succeed');
    assert.equal(getChannel(harness9.registry.snapshot(), CHANNEL_A_ID).state, 'open', 'matching channel fingerprint should preserve circuit state');

    // === 10. Health reconcile on reload prunes removed model ===
    console.log('=== 10. Health reconcile on reload prunes removed model ===');
    const clock10 = createFakeClock();
    const harness10 = createStoreWithHealth(clock10);
    assert.ok(
      harness10.registry.snapshot().modelChannels.some(entry => entry.canonicalModel === MODEL_B),
      'precondition: model B health records should exist before reload',
    );

    writeFallbackJson(harness10.dir, createRoutingDocumentWithoutModelB());
    const result10 = harness10.store.reloadFromFiles();
    const health10 = harness10.registry.snapshot();

    assert.equal(result10.ok, true, 'reload after removing a model should succeed');
    assert.equal(health10.modelChannels.some(entry => entry.canonicalModel === MODEL_B), false, 'removed model-channel records should be pruned');
    assert.equal(getChannel(health10, CHANNEL_A_ID).channelId, CHANNEL_A_ID, 'channel record should remain after model removal');

    // === 11. Health reconcile on reload resets changed fingerprint ===
    console.log('=== 11. Health reconcile on reload resets changed fingerprint ===');
    const clock11 = createFakeClock();
    const harness11 = createStoreWithHealth(clock11);
    const fingerprint11 = getRoutingChannel(getRoutingConfig(harness11.store), CHANNEL_A_ID).fingerprint;
    openChannelACircuit(harness11.registry, fingerprint11);

    writeFallbackJson(harness11.dir, createRoutingDocument(CHANNEL_A_ROTATED_KEY));
    const result11 = harness11.store.reloadFromFiles();
    const health11 = harness11.registry.snapshot();
    const channel11 = getChannel(health11, CHANNEL_A_ID);

    assert.equal(result11.ok, true, 'reload after changing a channel api key should succeed');
    assert.notEqual(channel11.fingerprint, fingerprint11, 'channel fingerprint should change after api key rotation');
    assert.equal(channel11.state, 'closed', 'changed channel fingerprint should reset circuit state');
    assert.equal(channel11.failureCount, 0, 'changed channel fingerprint should reset failures');

    // === 12. Failed reload preserves old snapshot and health ===
    console.log('=== 12. Failed reload preserves old snapshot and health ===');
    const clock12 = createFakeClock();
    const harness12 = createStoreWithHealth(clock12);
    const snapshot12Before = harness12.store.getSnapshot();
    const fingerprint12 = getRoutingChannel(getRoutingConfig(harness12.store), CHANNEL_A_ID).fingerprint;
    openChannelACircuit(harness12.registry, fingerprint12);
    const health12Before = harness12.registry.snapshot();

    writeFallbackJson(harness12.dir, { default_model: MODEL_A });
    const result12 = harness12.store.reloadFromFiles();
    const snapshot12After = harness12.store.getSnapshot();
    const health12After = harness12.registry.snapshot();

    assert.equal(result12.ok, false, 'reload with invalid routing config should fail');
    assert.equal(snapshot12After, snapshot12Before, 'failed reload should preserve prior snapshot object');
    assert.equal(health12After.topologyGeneration, health12Before.topologyGeneration, 'failed reload should not reconcile health');
    assert.equal(getChannel(health12After, CHANNEL_A_ID).state, 'open', 'failed reload should preserve health circuit state');

    // === 13. Stale lease cannot mutate after reload ===
    console.log('=== 13. Stale lease cannot mutate after reload ===');
    const clock13 = createFakeClock();
    const harness13 = createStoreWithHealth(clock13);
    const fingerprint13 = getRoutingChannel(getRoutingConfig(harness13.store), CHANNEL_A_ID).fingerprint;
    const staleLease = acquireChannelALease(harness13.registry, fingerprint13);

    writeFallbackJson(harness13.dir, createRoutingDocument(CHANNEL_A_ROTATED_KEY));
    const result13 = harness13.store.reloadFromFiles();
    assert.equal(result13.ok, true, 'reload with changed topology should succeed');
    const generation13 = harness13.registry.snapshot().topologyGeneration;

    harness13.registry.complete(staleLease, {
      scope: 'model_channel',
      success: false,
      reason: 'stale',
      channelReachabilityProven: true,
    });
    const health13 = harness13.registry.snapshot();

    assert.equal(health13.topologyGeneration, generation13, 'stale completion should not create another generation');
    assert.equal(getChannel(health13, CHANNEL_A_ID).state, 'closed', 'stale completion should not mutate new channel record');
    assert.equal(getModelChannel(health13, MODEL_A, CHANNEL_A_ID).state, 'closed', 'stale completion should not mutate new model-channel record');

    console.log('=== 14. Reload updates live health settings atomically ===');
    const clock14 = createFakeClock();
    const harness14 = createStoreWithHealth(clock14);
    const envOnlyStore = createRuntimeConfigStore({ envPath: path.join(harness14.dir, '.env') });
    const envOnlyRegistry = createHealthRegistry();
    envOnlyStore.registerHealthRegistry?.(envOnlyRegistry);
    assert.equal(envOnlyRegistry.snapshot().channels.length, 2, 'env-only launch must initialize every configured channel, before any traffic');
    assert.equal(envOnlyStore.getSnapshot().routingConfig, envOnlyStore.getSnapshot().config.routingConfig, 'routing and health share one parsed config');
    const fingerprint14 = getRoutingChannel(getRoutingConfig(harness14.store), CHANNEL_A_ID).fingerprint;
    const fail14 = () => harness14.registry.complete(acquireChannelALease(harness14.registry, fingerprint14), { scope: 'model_channel', success: false, reason: 'timeout', channelReachabilityProven: false });
    fail14();
    writeDotEnv(harness14.dir, ['PROXY_HEALTH_FAILURE_THRESHOLD=2', 'PROXY_HEALTH_COOLDOWN_MS=1111']);
    assert.equal(harness14.store.reloadFromFiles().ok, true);
    fail14();
    assert.equal(getChannel(harness14.registry.snapshot(), CHANNEL_A_ID).remainingMs, 1111);
    writeDotEnv(harness14.dir, ['PROXY_HEALTH_FAILURE_THRESHOLD=not-a-number']);
    assert.equal(harness14.store.reloadFromFiles().ok, false);
    assert.equal(getChannel(harness14.registry.snapshot(), CHANNEL_A_ID).remainingMs, 1111);

    console.log('\nAll runtime-reload checks passed.');
  } finally {
    for (const d of allTempDirs) {
      restoreEnvPermissions(d);
      rmSync(d, { recursive: true, force: true });
    }
  }
}

main();
