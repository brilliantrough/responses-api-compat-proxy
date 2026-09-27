import type { HealthLease, HealthRegistry, FailureEvidence } from './channel-health.js';
import { classifyHealthDecision } from './channel-health.js';
import type { ResolvedModelRoute } from './model-router.js';
import type { ChannelConfig, RoutingConfig } from './routing-config.js';

export type ChannelAttempts = {
  attemptedChannelIds: Set<string>;
  counts: Map<string, number>;
  cursor: number;
  maxAttempts: number;
};

export const routingAttemptStats = { upstreamAttempts: 0, sameChannelRetries: 0, channelSwitches: 0 };

export function createChannelAttempts(maxAttempts = 3): ChannelAttempts {
  return { attemptedChannelIds: new Set(), counts: new Map(), cursor: 0, maxAttempts };
}

export function nextAvailableChannel(route: ResolvedModelRoute, config: RoutingConfig, health: HealthRegistry, attempts: ChannelAttempts): ChannelConfig | undefined {
  const id = route.channelIds.slice(attempts.cursor).find(id => {
    const channel = config.channelsById.get(id);
    return channel !== undefined && (attempts.counts.get(id) ?? 0) < attempts.maxAttempts && health.availability({
      channelId: id, channelFingerprint: channel.fingerprint, canonicalModel: route.canonicalModel, disableCooldown: channel.disableCooldown,
    }).ok;
  });
  return id === undefined ? undefined : config.channelsById.get(id);
}

export function hasAvailableChannel(route: ResolvedModelRoute, config: RoutingConfig, health: HealthRegistry, attempts: ChannelAttempts): boolean {
  return nextAvailableChannel(route, config, health, attempts) !== undefined;
}

export type ChannelSelection =
  | Readonly<{ ok: true; channel: ChannelConfig; channelIndex: number; lease: HealthLease }>
  | Readonly<{ ok: false; code: 'all_attempted'; attemptedChannelIds: readonly string[] }>
  | Readonly<{ ok: false; code: 'all_unavailable'; retryAfterMs: number; attemptedChannelIds: readonly string[] }>;

function attemptedIds(attemptedChannelIds: ReadonlySet<string>): readonly string[] {
  return Array.from(attemptedChannelIds);
}

export function selectNextChannel(
  route: ResolvedModelRoute,
  config: RoutingConfig,
  health: HealthRegistry,
  attempts: ChannelAttempts,
): ChannelSelection {
  const { attemptedChannelIds } = attempts;
  let maxRetryAfterMs = 0;
  let unavailableCandidateCount = 0;

  for (let channelIndex = attempts.cursor; channelIndex < route.channelIds.length; channelIndex += 1) {
    const channelId = route.channelIds[channelIndex];
    if ((attempts.counts.get(channelId) ?? 0) >= attempts.maxAttempts) {
      continue;
    }

    const channel = config.channelsById.get(channelId);
    if (channel === undefined) {
      continue;
    }

    const acquisition = health.acquire({
      channelId: channel.id,
      channelFingerprint: channel.fingerprint,
      canonicalModel: route.canonicalModel,
      disableCooldown: channel.disableCooldown,
    });

    if (acquisition.ok) {
      routingAttemptStats.upstreamAttempts += 1;
      if (attempts.counts.has(channelId)) routingAttemptStats.sameChannelRetries += 1;
      else if (attemptedChannelIds.size > 0) routingAttemptStats.channelSwitches += 1;
      attempts.cursor = channelIndex;
      attempts.counts.set(channelId, (attempts.counts.get(channelId) ?? 0) + 1);
      attemptedChannelIds.add(channelId);
      return {
        ok: true,
        channel,
        channelIndex,
        lease: acquisition.lease,
      };
    }

    unavailableCandidateCount += 1;
    maxRetryAfterMs = Math.max(maxRetryAfterMs, acquisition.retryAfterMs);
  }

  if (unavailableCandidateCount > 0) {
    return {
      ok: false,
      code: 'all_unavailable',
      retryAfterMs: maxRetryAfterMs,
      attemptedChannelIds: attemptedIds(attemptedChannelIds),
    };
  }

  return {
    ok: false,
    code: 'all_attempted',
    attemptedChannelIds: attemptedIds(attemptedChannelIds),
  };
}

export function reportChannelSuccess(
  lease: HealthLease,
  health: HealthRegistry,
): void {
  health.complete(lease, {
    scope: 'model_channel',
    success: true,
    reason: 'ok',
    channelReachabilityProven: true,
  });
}

export function reportChannelFailure(
  lease: HealthLease,
  health: HealthRegistry,
  evidence: FailureEvidence,
): void {
  const decision = classifyHealthDecision(evidence);
  health.complete(lease, {
    scope: decision.scope,
    success: false,
    reason: decision.reason,
    channelReachabilityProven: decision.channelReachabilityProven,
  });
}

export function isModelChannelsUnavailable(
  selection: ChannelSelection,
  attemptedChannelIds: ReadonlySet<string>,
): selection is Readonly<{ ok: false; code: 'all_unavailable'; retryAfterMs: number; attemptedChannelIds: readonly string[] }> {
  return !selection.ok && selection.code === 'all_unavailable' && attemptedChannelIds.size === 0;
}
