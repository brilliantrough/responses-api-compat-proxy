import assert from 'node:assert/strict';
import { createHealthRegistry, type HealthOutcome } from '../src/channel-health.js';

let now = 1000;
const health = createHealthRegistry({ now: () => now });
const topology = { channels: [{ channelId: 'a', fingerprint: 'key' }], modelChannels: ['m', 'n', 'compact:m', 'compact-v2:m'].map(canonicalModel => ({ channelId: 'a', canonicalModel })) };
health.reconcile(topology);
const input = (model = 'm', disableCooldown = false) => ({ channelId: 'a', channelFingerprint: 'key', canonicalModel: model, disableCooldown });
const acquire = (model = 'm', disableCooldown = false) => {
  const acquired = health.acquire(input(model, disableCooldown));
  assert.equal(acquired.ok, true);
  return acquired.lease;
};
const outcome = (success: boolean, reason = 'timeout'): HealthOutcome => ({ success, reason, scope: 'model_channel', channelReachabilityProven: true });
const finish = (success: boolean, model = 'm', disableCooldown = false) => health.complete(acquire(model, disableCooldown), outcome(success));
const channel = () => health.snapshot().channels[0];

// The window includes individual attempts from all ordinary models, not consecutive failures.
for (let i = 0; i < 15; i++) finish(true, 'n');
for (let i = 0; i < 15; i++) finish(false);
assert.equal(health.snapshot().modelChannels.find(row => row.canonicalModel === 'm')!.modelWindowFailures, 15);
assert.equal(health.snapshot().modelChannels.find(row => row.canonicalModel === 'n')!.modelWindowFailures, 0, 'uptime observations are model-isolated');
assert.equal(health.snapshot().modelChannels.find(row => row.canonicalModel === 'n')!.modelWindowSuccesses, 15);
assert.equal(channel().windowFailureRate, 0.5);
assert.equal(health.availability(input()).ok, true, 'exactly 50% must not open');
const lateSuccess = acquire('n');
finish(false);
assert.equal(channel().windowFailures, 16);
assert.equal(health.availability(input('n')).ok, false, 'ordinary models share a breaker');
assert.equal(health.availability(input('compact:m')).ok, true, 'ordinary failures do not block compact');
const until = channel().cooldownUntil;
health.complete(lateSuccess, outcome(true));
assert.equal(channel().cooldownUntil, until, 'late success cannot clear or extend a breaker');
health.reconcile(topology);
assert.equal(channel().cooldownUntil, until, 'reload preserves cooldown');
now += 600000;
assert.equal(health.availability(input()).ok, true);
finish(false);
assert.equal(channel().windowFailures, 1, 'recovery starts a fresh window without one-failure half-open policy');
assert.equal(channel().state, 'closed');
now += 180000;
assert.equal(channel().windowFailures, 0, 'exact window boundary expires');

// Compact has independent per-protocol scopes, even for auth/transport classifications.
health.configure({ healthFailureThreshold: 2 });
health.complete(acquire('compact:m'), { ...outcome(false, 'auth'), scope: 'channel' });
health.complete(acquire('compact:m'), { ...outcome(false, 'auth'), scope: 'channel' });
assert.equal(health.availability(input('compact:m')).ok, false);
assert.equal(health.availability(input('compact-v2:m')).ok, true);
assert.equal(health.availability(input()).ok, true);

// No breaker bypasses ordinary windows, but not quota or administrator actions.
for (let i = 0; i < 20; i++) finish(false, 'm', true);
assert.equal(health.availability(input('n', true)).ok, true);
const oldSuccess = acquire('m', true);
health.complete(acquire('m', true), { ...outcome(false, 'quota_exhausted'), scope: 'channel' });
health.complete(oldSuccess, outcome(true));
assert.equal(channel().quotaFailureCount, 1);
for (const model of ['m', 'n', 'compact:m', 'compact-v2:m']) assert.equal(health.availability(input(model, true)).ok, false);
const oldQuotaUntil = channel().quotaCooldownUntil;
assert.equal(health.control('a', 'close'), true);
assert.equal(channel().quotaCooldownUntil, 0);
assert.equal(channel().windowFailures, 0);
assert.equal(health.availability(input('compact:m')).ok, true);

const staleQuota = acquire();
const staleFailure = acquire();
health.control('a', 'open');
assert.equal(health.availability(input('m', true)).ok, false);
health.control('a', 'close');
health.complete(staleQuota, { ...outcome(false, 'quota_exhausted'), scope: 'channel' });
health.complete(staleFailure, outcome(false));
assert.equal(channel().quotaCooldownUntil, 0, 'pre-admin quota result cannot undo restore');
assert.equal(channel().windowFailures, 0, 'pre-admin failures do not enter the new window');
health.complete(acquire(), { ...outcome(false, 'quota_exhausted'), scope: 'channel' });
assert.ok(channel().quotaCooldownUntil >= oldQuotaUntil, 'new quota failure still opens');
health.control('a', 'close');
health.control('a', 'open');
now += 600000;
assert.equal(health.availability(input('m', true)).ok, true, 'manual cooldown expires automatically');

// Duplicate/neutral results and stale leases cannot mutate a reloaded topology.
health.configure({ healthFailureThreshold: 15 });
const lease = acquire();
health.complete(lease, outcome(false));
health.complete(lease, outcome(false));
assert.equal(channel().windowFailures, 1);
health.complete(acquire(), { ...outcome(false), scope: 'none' });
assert.equal(channel().windowFailures, 1);
const stale = acquire();
health.reconcile({ channels: [{ channelId: 'a', fingerprint: 'rotated' }], modelChannels: topology.modelChannels });
health.complete(stale, outcome(false));
assert.equal(channel().totalFailures, 0);
assert.equal(health.acquire(input()).ok, false, 'old config cannot resurrect rotated credentials');
assert.equal(channel().fingerprint, 'rotated');
assert.equal(health.control('missing', 'close'), false);
console.log('Channel health checks passed: rolling boundaries, scopes, quota, manual races, no-breaker, reload and duplicate completion.');
