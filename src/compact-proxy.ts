import type { FailureEvidence } from './channel-health.js';
import type { ResolvedModelRoute } from './model-router.js';
import { getUpstreamFallbackReason, normalizeErrorPayload, parseBestEffortErrorPayload } from './responses-errors.js';
import { isJsonRecord, type JsonRecord } from './responses-input-normalization.js';
import { compactHealthKey, type ChannelConfig } from './routing-config.js';
import { extractUsageMetrics } from './responses-sse.js';
import { createChannelAttempts, nextAvailableChannel, selectNextChannel } from './upstream-router.js';
import { setTimeout as delay } from 'node:timers/promises';
import { beginUsageAttempt } from './usage-tracking.js';
import { trackCacheKey } from './cache-key-history.js';
import { isQuotaExhaustedEvidence } from './channel-health.js';
import {
  clientErrorMatches,
  compactFallbackDetails,
  completeCompactFailure,
  normalizeCompactBody,
  redactCompactDetails,
  readCompactAbortReason,
  toJsonValue,
  type CompactProxyDependencies,
  type CompactProxyResult,
  type TimeoutAbortReason,
} from './compact-proxy-support.js';

export function createCompactProxy(dependencies: CompactProxyDependencies) {
  const { getConfig, healthRegistry, fetchWithTimeout, createLinkedAbortController, closeResponseBody } = dependencies;

  return async function executeCompactProxy(
    requestBody: JsonRecord,
    parentSignal: AbortSignal,
  ): Promise<CompactProxyResult> {
    const config = getConfig();
    const compactRoute = config.routingConfig.compactRoute;
    if (compactRoute === undefined) {
      return {
        kind: 'fallback_exhausted',
        status: 502,
        attempts: 0,
        details: compactFallbackDetails(undefined, 'compact route not configured', 0),
      };
    }

    const requestedModel = typeof requestBody.model === 'string'
      ? requestBody.model
      : compactRoute.canonicalModel;
    const route: ResolvedModelRoute = {
      requestedModel,
      canonicalModel: compactHealthKey(compactRoute.canonicalModel),
      channelIds: compactRoute.channelIds,
    };
    const upstreamBody = normalizeCompactBody(requestBody, compactRoute.canonicalModel, config);
    const rememberChannel = trackCacheKey(upstreamBody.prompt_cache_key, route.canonicalModel);
    const attempts = createChannelAttempts(config.channelMaxAttempts);
    const { attemptedChannelIds } = attempts;
    let attemptCount = 0;
    let lastChannel: ChannelConfig | undefined;
    let lastReason = 'unknown_upstream_error';
    let lastDetails: unknown;
    let lastTimedOut = false;

    while (true) {
      const next = nextAvailableChannel(route, config.routingConfig, healthRegistry, attempts);
      if (next && attempts.counts.has(next.id) && config.channelRetryDelayMs > 0 && !parentSignal.aborted) {
        try { await delay(config.channelRetryDelayMs, undefined, { signal: parentSignal }); } catch { /* handled below */ }
      }
      if (parentSignal.aborted) {
        const reason = readCompactAbortReason(parentSignal);
        if (reason?.kind === 'client_disconnect') return { kind: 'client_disconnect', source: reason.source };
        return { kind: 'fallback_exhausted', status: 504, attempts: attemptCount, details: compactFallbackDetails(lastChannel, 'timeout', attemptCount) };
      }
      const selection = selectNextChannel(route, config.routingConfig, healthRegistry, attempts);
      if (!selection.ok) {
        if (selection.code === 'all_unavailable' && attemptedChannelIds.size === 0) {
          return { kind: 'all_unavailable', retryAfterMs: selection.retryAfterMs };
        }
        return {
          kind: 'fallback_exhausted',
          status: lastTimedOut ? 504 : 502,
          attempts: attemptCount,
          details: compactFallbackDetails(lastChannel, lastReason, attemptCount, lastDetails),
        };
      }

      const { channel, lease } = selection;
      attemptCount += 1;
      lastChannel = channel;
      const linked = createLinkedAbortController(parentSignal);
      const usageAttempt = beginUsageAttempt(channel, compactRoute.canonicalModel, 'compact', linked.controller.signal);
      const totalTimeout = setTimeout(() => {
        linked.controller.abort({ kind: 'timeout', phase: 'total' } satisfies TimeoutAbortReason);
      }, Math.max(1, config.compactTimeoutMs));

      try {
        let response: Response;
        try {
          response = await fetchWithTimeout(
            `${channel.baseUrl}/v1/responses/compact`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${channel.apiKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: JSON.stringify(upstreamBody),
            },
            linked.controller,
            config.upstreamTimeoutMs,
          );
        } catch (error) {
          const abortReason = readCompactAbortReason(linked.controller.signal) ?? readCompactAbortReason(parentSignal);
          if (abortReason?.kind === 'client_disconnect') {
            completeCompactFailure(healthRegistry, lease, {
              error,
              abortReason,
              fallbackReason: 'connect_error',
              upstreamResponseObserved: false,
            });
            return { kind: 'client_disconnect', source: abortReason.source };
          }

          lastTimedOut = abortReason?.kind === 'timeout';
          lastReason = lastTimedOut ? 'timeout' : 'connect_error';
          lastDetails = redactCompactDetails(error instanceof Error ? error.message : String(error), channel.apiKey);
          completeCompactFailure(healthRegistry, lease, {
            error,
            abortReason,
            fallbackReason: lastTimedOut ? 'headers_only_timeout' : 'connect_error',
            upstreamResponseObserved: false,
          });
          continue;
        }

        usageAttempt.row.status = response.status;
        let responseText: string;
        try {
          responseText = await response.text();
        } catch (error) {
          const abortReason = readCompactAbortReason(linked.controller.signal) ?? readCompactAbortReason(parentSignal);
          await closeResponseBody(response);
          if (abortReason?.kind === 'client_disconnect') {
            completeCompactFailure(healthRegistry, lease, {
              error,
              abortReason,
              fallbackReason: 'unknown_upstream_error',
              upstreamResponseObserved: true,
            });
            return { kind: 'client_disconnect', source: abortReason.source };
          }

          lastTimedOut = abortReason?.kind === 'timeout';
          lastReason = lastTimedOut ? 'timeout' : 'body_error';
          lastDetails = redactCompactDetails(error instanceof Error ? error.message : String(error), channel.apiKey);
          completeCompactFailure(healthRegistry, lease, {
            error,
            abortReason,
            fallbackReason: lastTimedOut ? 'headers_only_timeout' : 'unknown_upstream_error',
            upstreamResponseObserved: true,
          });
          continue;
        }

        const contentType = response.headers.get('content-type') ?? '';
        let payload: unknown;
        try {
          payload = responseText.trim().length > 0 ? JSON.parse(responseText) : undefined;
        } catch {
          payload = undefined;
        }

        const usage = isJsonRecord(payload) ? extractUsageMetrics(payload) : undefined;
        if (response.ok && isJsonRecord(payload) && Array.isArray(payload.output) && !payload.error && payload.status !== 'failed' && payload.status !== 'incomplete') {
          usageAttempt.result('success');
          healthRegistry.complete(lease, {
            scope: 'model_channel',
            success: true,
            reason: 'ok',
            channelReachabilityProven: true,
          });
          rememberChannel?.(channel);
          return {
            kind: 'success',
            body: payload,
            status: response.status,
            ...(usage === undefined ? {} : { usage }),
            attempts: attemptCount,
            channel,
          };
        }

        if (response.ok) {
          lastTimedOut = false;
          lastReason = 'invalid_compact_response';
          lastDetails = redactCompactDetails(responseText, channel.apiKey);
          completeCompactFailure(healthRegistry, lease, {
            payload,
            status: response.status,
            fallbackReason: 'empty_response',
            upstreamResponseObserved: true,
          });
          continue;
        }

        const errorPayload = payload ?? parseBestEffortErrorPayload(responseText, contentType);
        const fallbackReason = getUpstreamFallbackReason(response.status, errorPayload, {
          fallbackOnRetryable4xx: config.fallbackOnRetryable4xx,
          fallbackOnCompat4xx: config.fallbackOnCompat4xx,
          compatFallbackPatterns: config.compatFallbackPatterns,
          clientErrorPatterns: config.clientErrorPatterns,
        });
        const evidence: FailureEvidence = {
          status: response.status,
          payload: errorPayload,
          fallbackReason,
          upstreamResponseObserved: true,
        };

        if (response.status === 401 || response.status === 403) {
          completeCompactFailure(healthRegistry, lease, evidence, {
            scope: 'channel',
            reason: 'auth',
            channelReachabilityProven: true,
          });
        } else if (response.status === 404 || response.status === 405) {
          completeCompactFailure(healthRegistry, lease, evidence, {
            scope: 'model_channel',
            reason: 'compact_unsupported',
            channelReachabilityProven: true,
          });
        } else if (response.status >= 400 && response.status < 500 && clientErrorMatches(errorPayload, config.clientErrorPatterns)) {
          completeCompactFailure(healthRegistry, lease, evidence, {
            scope: 'none',
            reason: 'client_error',
            channelReachabilityProven: true,
          });
        } else {
          completeCompactFailure(healthRegistry, lease, evidence);
        }

        const compactRouteFailure = response.status === 401 || response.status === 403 || response.status === 404 || response.status === 405;
        const shouldFallback = isQuotaExhaustedEvidence(evidence) || compactRouteFailure || response.status >= 500 || fallbackReason !== undefined;
        if (!shouldFallback) {
          return {
            kind: 'upstream_error',
            status: response.status,
            body: toJsonValue(normalizeErrorPayload(response.status, redactCompactDetails(errorPayload, channel.apiKey))),
            attempts: attemptCount,
            channel,
          };
        }

        lastTimedOut = false;
        lastReason = response.status === 401 || response.status === 403
          ? 'auth'
          : response.status === 404 || response.status === 405
          ? 'compact_unsupported'
          : fallbackReason ?? 'upstream_error';
        lastDetails = errorPayload === undefined
          ? redactCompactDetails(responseText, channel.apiKey)
          : redactCompactDetails(errorPayload, channel.apiKey);
      } finally {
        if (usageAttempt.row.outcome !== 'success') usageAttempt.result('failed', lastReason);
        usageAttempt.finish();
        clearTimeout(totalTimeout);
        linked.dispose();
      }
    }
  };
}
