import type { RoutingConfig } from './routing-config.js';

// This is session history, not an affinity override: route priority always wins.
const keys = new Map<string, Map<string, { channelId: string; fingerprint: string; at: number }>>();
let limit = 100;
let matches = 0;
let switches = 0;
let evictions = 0;
let generation = 0;

export function configureCacheKeyHistory(size: number, config: RoutingConfig): void {
  limit = size;
  generation += 1;
  for (const routes of keys.values()) {
    for (const [route, entry] of routes) {
      if (config.channelsById.get(entry.channelId)?.fingerprint !== entry.fingerprint) routes.delete(route);
    }
  }
  while (keys.size > limit) { keys.delete(keys.keys().next().value!); evictions += 1; }
}

export function trackCacheKey(key: unknown, route: string) {
  if (typeof key !== 'string' || !key.trim()) return undefined;
  const existing = keys.get(key);
  if (existing) matches += 1;
  const routes = existing ?? new Map();
  const startedGeneration = generation;
  keys.delete(key);
  keys.set(key, routes);
  while (keys.size > limit) { keys.delete(keys.keys().next().value!); evictions += 1; }
  return (channel: { id: string; fingerprint: string }) => {
    if (keys.get(key) !== routes || startedGeneration !== generation) return;
    const previous = routes.get(route);
    if (previous && previous.channelId !== channel.id) switches += 1;
    routes.set(route, { channelId: channel.id, fingerprint: channel.fingerprint, at: Date.now() });
  };
}

export function cacheKeyHistoryStats() {
  return { size: keys.size, limit, matches, switches, evictions };
}
