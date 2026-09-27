import assert from 'node:assert/strict';
import { createHealthRegistry } from '../src/channel-health.js';
import { parseRoutingConfig } from '../src/routing-config.js';
import { resolveModelRoute } from '../src/model-router.js';
import { createChannelAttempts, hasAvailableChannel, isModelChannelsUnavailable, reportChannelFailure, reportChannelSuccess, selectNextChannel } from '../src/upstream-router.js';
import { buildHealthTopology } from '../src/runtime-config.js';
import { cacheKeyHistoryStats, configureCacheKeyHistory, trackCacheKey } from '../src/cache-key-history.js';

let now = 1000;
const config = parseRoutingConfig({ default_model: 'm', channels: ['a', 'b', 'c'].map(id => ({ id, base_url: `https://${id}.example`, api_key: 'test' })), models: { m: { channel_ids: ['a', 'b', 'c'] }, n: { channel_ids: ['b', 'a'] } }, aliases: { latest: 'm' } }, 'check');
const route = resolveModelRoute('latest', config);
assert.ok(!('code' in route));
const health = createHealthRegistry({ now: () => now });
health.reconcile(buildHealthTopology(config));
const attempts = createChannelAttempts();
for (const expected of ['a', 'a', 'a', 'b', 'b', 'b', 'c', 'c', 'c']) {
  const selected = selectNextChannel(route, config, health, attempts);
  assert.equal(selected.ok, true);
  assert.equal(selected.channel.id, expected);
  reportChannelFailure(selected.lease, health, { status: 503, upstreamResponseObserved: true });
}
assert.equal(hasAvailableChannel(route, config, health, attempts), false);
assert.equal(selectNextChannel(route, config, health, attempts).ok, false);
assert.equal(attempts.attemptedChannelIds.size, 3);

const nextRequest = createChannelAttempts();
const first = selectNextChannel(route, config, health, nextRequest);
assert.equal(first.ok, true);
assert.equal(first.channel.id, 'a', 'each new request returns to top priority with fresh budget');
reportChannelFailure(first.lease, health, { status: 403, payload: { error: { code: 'insufficient_quota' } }, upstreamResponseObserved: true });
const second = selectNextChannel(route, config, health, nextRequest);
assert.equal(second.ok, true);
assert.equal(second.channel.id, 'b', 'quota skips the remaining attempts');
health.control('a', 'close');
reportChannelFailure(second.lease, health, { status: 503, upstreamResponseObserved: true });
const third = selectNextChannel(route, config, health, nextRequest);
assert.equal(third.ok, true);
assert.equal(third.channel.id, 'b', 'an in-progress request never jumps back up');
reportChannelSuccess(third.lease, health);
const recovered = selectNextChannel(route, config, health, createChannelAttempts());
assert.equal(recovered.ok, true);
assert.equal(recovered.channel.id, 'a');

for (const id of ['a', 'b', 'c']) health.control(id, 'open');
const blocked = createChannelAttempts();
const selection = selectNextChannel(route, config, health, blocked);
assert.equal(isModelChannelsUnavailable(selection, blocked.attemptedChannelIds), true);
assert.equal(isModelChannelsUnavailable(selection, nextRequest.attemptedChannelIds), false);
now += 600000;
assert.equal(hasAvailableChannel(route, config, health, createChannelAttempts()), true);

configureCacheKeyHistory(100, config);
const a = config.channelsById.get('a')!, b = config.channelsById.get('b')!;
trackCacheKey('session', 'm')!(a);
trackCacheKey('session', 'm')!(b);
assert.equal(cacheKeyHistoryStats().switches, 1);
for (let i = 0; i < 99; i++) trackCacheKey(`key-${i}`, 'm');
trackCacheKey('session', 'm'); // refresh LRU order
trackCacheKey('new', 'm');
trackCacheKey('session', 'm')!(a);
assert.equal(cacheKeyHistoryStats().size, 100);
assert.equal(cacheKeyHistoryStats().evictions, 1);
assert.equal(cacheKeyHistoryStats().switches, 2, 'recently touched session survives eviction');
console.log('Route selection checks passed: three attempts, quota priority, recovery, request-local cursor and 100-key LRU history.');
