import 'dotenv/config';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';

import { isJsonRecord, normalizeInput, type JsonRecord, type JsonValue } from './responses-input-normalization.js';
import { type StreamMode, type UpstreamEndpoint, type ProxyRuntimeConfig } from './proxy-config.js';
import {
  extractErrorMessage,
  getUpstreamFallbackReason,
  normalizeErrorPayload,
  parseBestEffortErrorPayload,
  type FallbackReason,
} from './responses-errors.js';
import {
  coerceResponseObject,
  extractUsageFromStreamPayload,
  extractUsageMetrics,
  formatSseEvent,
  isResponsesStyleEventStream,
  makeResponsesStreamErrorEvent,
  normalizeResponseObject,
  normalizeStreamEventPayload,
  parseSse,
  parseSseChunk,
  parseStreamPayload,
  sendResponsesStreamError,
  synthesizeResponseFromEvents,
  writeBufferedResponsesSse,
} from './responses-sse.js';
import { createAdminHandler } from './admin-api.js';
import { createConfigFileStoreFromPaths } from './config-files.js';
import { createRuntimeConfigStore, createEndpointStateKey, type RuntimeSnapshot } from './runtime-config.js';

const _envPath = process.env.PROXY_ENV_PATH ?? resolve('.env');
const runtimeStore = createRuntimeConfigStore({ envPath: _envPath });

const _adminConfigStore = createConfigFileStoreFromPaths({
  envPath: _envPath,
  fallbackPath: runtimeStore.getSnapshot().config.fallbackConfigPath,
  modelMapPath: runtimeStore.getSnapshot().config.modelMappingPath,
});
const _adminHandler = createAdminHandler({
  configStore: _adminConfigStore,
  runtimeStore,
  getAdminStats: () => getAdminStats(),
  clearResponseCache: () => clearResponseCache(),
  responseCacheSize: () => responseCache.size,
});

const _initialSnapshot = runtimeStore.getSnapshot();
const _requestContext = new AsyncLocalStorage<RuntimeSnapshot>();

function getConfig(): ProxyRuntimeConfig {
  const snap = _requestContext.getStore();
  return snap ? snap.config : _initialSnapshot.config;
}

type UpstreamAttempt = {
  endpoint: UpstreamEndpoint;
  endpointIndex: number;
  response: Response;
  controller: AbortController;
  dispose: () => void;
};

type AbortReason =
  | { kind: 'timeout'; phase: 'connect' | 'first-byte' | 'first-text' | 'idle' | 'total' }
  | { kind: 'client_disconnect'; source: 'request' | 'response' };

type StreamOutcome =
  | {
      kind: 'completed';
      chunkCount: number;
      totalBytes: number;
      usage?: JsonRecord;
      startedStreaming: boolean;
      wroteAnyEvent: boolean;
      wroteTextContent: boolean;
      textCharCount: number;
      fallbackReason?: FallbackReason;
    }
  | {
      kind: 'timeout';
      phase: 'first-byte' | 'first-text' | 'idle' | 'total';
      chunkCount: number;
      totalBytes: number;
      startedStreaming: boolean;
      wroteAnyEvent: boolean;
      wroteTextContent: boolean;
      textCharCount: number;
      fallbackReason?: FallbackReason;
    }
  | {
      kind: 'client_disconnect';
      source: 'request' | 'response';
      chunkCount: number;
      totalBytes: number;
      startedStreaming: boolean;
      wroteAnyEvent: boolean;
      wroteTextContent: boolean;
      textCharCount: number;
    };

type StreamProbeOutcome =
  | StreamOutcome
  | {
      kind: 'buffered_text';
      text: string;
      chunkCount: number;
      totalBytes: number;
      streamEventCount: number;
      wroteAnyEvent: boolean;
      wroteTextContent: boolean;
      textCharCount: number;
    };

type EndpointCircuitState = 'closed' | 'open' | 'half_open';

type EndpointHealthRecord = {
  state: EndpointCircuitState;
  failureCount: number;
  successCount: number;
  cooldownUntil: number;
  lastFailureReason: FallbackReason | 'connect_timeout' | 'body_timeout' | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  halfOpenProbeInFlight: number;
};

type FallbackBudget = {
  startedAt: number;
  attemptsUsed: number;
};

type StreamObservation = {
  startedStreaming: boolean;
  wroteAnyEvent: boolean;
  wroteTextContent: boolean;
  textCharCount: number;
  usage?: JsonRecord;
};

let activeRequests = 0;
let requestCounter = 0;
const responseCache = new Map<string, JsonRecord>();
const endpointHealth = new Map<string, EndpointHealthRecord>();
const proxyStats = {
  requestsTotal: 0,
  responsesJson: 0,
  responsesSseNormalized: 0,
  responsesSseRaw: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheStores: 0,
  cacheEvictions: 0,
  cacheClears: 0,
  upstreamTimeouts: 0,
  overloadRejects: 0,
  errors4xx: 0,
  errors5xx: 0,
  usageResponses: 0,
  usageInputTokens: 0,
  usageOutputTokens: 0,
  usageTotalTokens: 0,
  usageCachedInputTokens: 0,
  usageReasoningTokens: 0,
  fallbackReasons: {
    upstream5xx: 0,
    retryable4xx: 0,
    compat4xx: 0,
    unknownUpstreamError: 0,
    headersOnlyTimeout: 0,
    streamNoTextContent: 0,
    streamMissingUsage: 0,
    emptyResponse: 0,
    sseReconstructionFailure: 0,
    proxyUnhandledError: 0,
  },
  fallbackByUpstream: {} as Record<
    string,
    {
      total: number;
      upstream5xx: number;
      retryable4xx: number;
      compat4xx: number;
      unknownUpstreamError: number;
      headersOnlyTimeout: number;
      streamNoTextContent: number;
      streamMissingUsage: number;
      emptyResponse: number;
      sseReconstructionFailure: number;
      proxyUnhandledError: number;
    }
  >,
};

function recordFallbackReason(reason: FallbackReason, upstreamName: string) {
  if (reason === 'upstream_5xx') {
    proxyStats.fallbackReasons.upstream5xx += 1;
  } else if (reason === 'retryable_4xx') {
    proxyStats.fallbackReasons.retryable4xx += 1;
  } else if (reason === 'compat_4xx') {
    proxyStats.fallbackReasons.compat4xx += 1;
  } else if (reason === 'unknown_upstream_error') {
    proxyStats.fallbackReasons.unknownUpstreamError += 1;
  } else if (reason === 'headers_only_timeout') {
    proxyStats.fallbackReasons.headersOnlyTimeout += 1;
  } else if (reason === 'stream_no_text_content') {
    proxyStats.fallbackReasons.streamNoTextContent += 1;
  } else if (reason === 'stream_missing_usage') {
    proxyStats.fallbackReasons.streamMissingUsage += 1;
  } else if (reason === 'empty_response') {
    proxyStats.fallbackReasons.emptyResponse += 1;
  } else if (reason === 'sse_reconstruction_failure') {
    proxyStats.fallbackReasons.sseReconstructionFailure += 1;
  } else {
    proxyStats.fallbackReasons.proxyUnhandledError += 1;
  }

  const current = proxyStats.fallbackByUpstream[upstreamName] ?? {
    total: 0,
    upstream5xx: 0,
    retryable4xx: 0,
    compat4xx: 0,
    unknownUpstreamError: 0,
    headersOnlyTimeout: 0,
    streamNoTextContent: 0,
    streamMissingUsage: 0,
    emptyResponse: 0,
    sseReconstructionFailure: 0,
    proxyUnhandledError: 0,
  };

  current.total += 1;
  if (reason === 'upstream_5xx') {
    current.upstream5xx += 1;
  } else if (reason === 'retryable_4xx') {
    current.retryable4xx += 1;
  } else if (reason === 'compat_4xx') {
    current.compat4xx += 1;
  } else if (reason === 'unknown_upstream_error') {
    current.unknownUpstreamError += 1;
  } else if (reason === 'headers_only_timeout') {
    current.headersOnlyTimeout += 1;
  } else if (reason === 'stream_no_text_content') {
    current.streamNoTextContent += 1;
  } else if (reason === 'stream_missing_usage') {
    current.streamMissingUsage += 1;
  } else if (reason === 'empty_response') {
    current.emptyResponse += 1;
  } else if (reason === 'sse_reconstruction_failure') {
    current.sseReconstructionFailure += 1;
  } else {
    current.proxyUnhandledError += 1;
  }

  proxyStats.fallbackByUpstream[upstreamName] = current;
}

function getObservedStreamState(observation: Pick<StreamObservation, 'wroteAnyEvent' | 'wroteTextContent'>) {
  if (observation.wroteTextContent) {
    return 'recognized_text_observed';
  }

  if (observation.wroteAnyEvent) {
    return 'sse_events_observed_without_recognized_text';
  }

  return 'no_complete_sse_events_observed';
}

function getClientOutputState(observation: Pick<StreamObservation, 'startedStreaming' | 'wroteTextContent'>) {
  if (observation.startedStreaming) {
    return 'stream_committed_to_client';
  }

  if (observation.wroteTextContent) {
    return 'recognized_text_detected_but_not_committed';
  }

  return 'no_client_stream_output';
}

function getStreamTimeoutObservation(
  phase: Extract<AbortReason, { kind: 'timeout' }>['phase'],
  observation: Pick<StreamObservation, 'wroteAnyEvent' | 'wroteTextContent'>,
) {
  if (phase === 'first-byte') {
    return 'no_upstream_body_chunk_before_timeout';
  }

  if (phase === 'first-text') {
    return observation.wroteAnyEvent
      ? 'upstream_sse_active_but_no_recognized_text_before_timeout'
      : 'no_recognized_text_before_timeout';
  }

  if (phase === 'idle') {
    return observation.wroteAnyEvent
      ? 'stream_became_idle_without_recognized_text'
      : 'stream_became_idle_before_complete_sse_event';
  }

  return 'request_total_timeout_before_usable_stream_output';
}

function getFallbackReasonNote(
  reason: FallbackReason,
  phase?: Extract<AbortReason, { kind: 'timeout' }>['phase'],
) {
  if (reason === 'headers_only_timeout') {
    if (phase === 'first-byte') {
      return 'internal timeout bucket for requests that never produced the first upstream body chunk';
    }

    if (phase === 'first-text') {
      return 'internal timeout bucket for streams that produced transport activity but no recognized assistant text before the timeout';
    }

    if (phase === 'idle') {
      return 'internal timeout bucket for streams that stalled before any recognized assistant text was usable';
    }

    return 'internal timeout bucket for streams that timed out before usable output reached the client';
  }

  if (reason === 'stream_no_text_content') {
    return 'stream completed but no recognizable assistant text was reconstructed';
  }

  if (reason === 'stream_missing_usage') {
    return 'stream completed with usable output but without extractable usage';
  }

  return undefined;
}

function getStreamObservationLogFields(
  observation: StreamObservation,
  options?: {
    phase?: Extract<AbortReason, { kind: 'timeout' }>['phase'];
    fallbackReason?: FallbackReason;
  },
) {
  const fields: Record<string, unknown> = {
    observedStreamState: getObservedStreamState(observation),
    clientOutputState: getClientOutputState(observation),
    usageState: observation.usage ? 'extractable_usage_observed' : 'extractable_usage_not_observed',
  };

  if (options?.phase) {
    fields.timeoutObservation = getStreamTimeoutObservation(options.phase, observation);
  }

  if (options?.fallbackReason) {
    const fallbackReasonNote = getFallbackReasonNote(options.fallbackReason, options.phase);
    if (fallbackReasonNote) {
      fields.fallbackReasonNote = fallbackReasonNote;
    }
  }

  return fields;
}

function getStreamTimeoutLogMessage(
  phase: Extract<AbortReason, { kind: 'timeout' }>['phase'],
  options?: { fallingBack?: boolean },
) {
  const suffix = options?.fallingBack ? ', falling back' : '';

  if (phase === 'first-byte') {
    return `stream timed out before first upstream body chunk${suffix}`;
  }

  if (phase === 'first-text') {
    return `stream timed out before first recognized text${suffix}`;
  }

  if (phase === 'idle') {
    return `stream went idle before usable text reached the client${suffix}`;
  }

  return `stream hit total timeout before usable output reached the client${suffix}`;
}

function getMissingUsageLogMessage(abortReason?: AbortReason) {
  if (abortReason?.kind === 'timeout') {
    return 'stream stopped before extractable usage was observed';
  }

  if (abortReason?.kind === 'client_disconnect') {
    return 'stream ended before extractable usage was observed because the client disconnected';
  }

  return 'stream completed without extractable usage in observed SSE events';
}

function createRequestId() {
  requestCounter += 1;
  return `r${requestCounter}`;
}

function getEndpointKey(endpoint: UpstreamEndpoint) {
  return createEndpointStateKey(endpoint);
}

function getEndpointHealth(endpoint: UpstreamEndpoint) {
  const key = getEndpointKey(endpoint);
  const current = endpointHealth.get(key);
  if (current) {
    return current;
  }

  const created: EndpointHealthRecord = {
    state: 'closed',
    failureCount: 0,
    successCount: 0,
    cooldownUntil: 0,
    lastFailureReason: null,
    lastFailureAt: null,
    lastSuccessAt: null,
    halfOpenProbeInFlight: 0,
  };
  endpointHealth.set(key, created);
  return created;
}

function getEndpointHealthSnapshot(endpoint: UpstreamEndpoint) {
  const health = getEndpointHealth(endpoint);
  const now = Date.now();
  const remainingMs = health.state === 'open' && health.cooldownUntil > now ? health.cooldownUntil - now : 0;

  return {
    state: health.state,
    failureCount: health.failureCount,
    successCount: health.successCount,
    cooldownUntil: health.cooldownUntil,
    remainingMs,
    remainingSeconds: remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0,
    lastFailureReason: health.lastFailureReason,
    lastFailureAt: health.lastFailureAt,
    lastSuccessAt: health.lastSuccessAt,
    halfOpenProbeInFlight: health.halfOpenProbeInFlight,
  };
}

function getCooldownMsForReason(reason: FallbackReason | 'connect_timeout' | 'body_timeout') {
  if (reason === 'connect_timeout' || reason === 'body_timeout' || reason === 'headers_only_timeout') {
    return getConfig().endpointTimeoutCooldownMs;
  }

  if (reason === 'retryable_4xx' || reason === 'compat_4xx') {
    return getConfig().endpointAuthCooldownMs;
  }

  return getConfig().endpointInvalidResponseCooldownMs;
}

function shouldOpenCircuitImmediately(reason: FallbackReason | 'connect_timeout' | 'body_timeout') {
  return [
    'connect_timeout',
    'body_timeout',
    'headers_only_timeout',
    'retryable_4xx',
    'compat_4xx',
    'unknown_upstream_error',
    'empty_response',
    'sse_reconstruction_failure',
  ].includes(reason);
}

function markEndpointFailure(
  endpoint: UpstreamEndpoint,
  reason: FallbackReason | 'connect_timeout' | 'body_timeout',
  requestId?: string,
  extra?: Record<string, unknown>,
) {
  const health = getEndpointHealth(endpoint);
  const now = Date.now();
  health.failureCount += 1;
  health.lastFailureReason = reason;
  health.lastFailureAt = now;

  const shouldOpenNow = shouldOpenCircuitImmediately(reason) || health.failureCount >= Math.max(1, getConfig().endpointFailureThreshold);
  if (shouldOpenNow) {
    const cooldownMs = getCooldownMsForReason(reason);
    health.state = cooldownMs > 0 ? 'open' : 'closed';
    health.cooldownUntil = cooldownMs > 0 ? now + cooldownMs : 0;
    health.halfOpenProbeInFlight = 0;
    if (requestId) {
      logRequest(requestId, 'endpoint circuit opened', {
        endpointName: endpoint.name,
        endpointUrl: endpoint.url,
        reason,
        cooldownMs,
        endpointHealth: getEndpointHealthSnapshot(endpoint),
        ...extra,
      });
    }
  }
}

function markEndpointSuccess(endpoint: UpstreamEndpoint, requestId?: string, extra?: Record<string, unknown>) {
  const health = getEndpointHealth(endpoint);
  const wasDegraded = health.state !== 'closed' || health.failureCount > 0;
  health.state = 'closed';
  health.failureCount = 0;
  health.successCount += 1;
  health.cooldownUntil = 0;
  health.lastSuccessAt = Date.now();
  health.halfOpenProbeInFlight = 0;

  if (wasDegraded && requestId) {
    logRequest(requestId, 'endpoint circuit recovered', {
      endpointName: endpoint.name,
      endpointUrl: endpoint.url,
      endpointHealth: getEndpointHealthSnapshot(endpoint),
      ...extra,
    });
  }
}

function isEndpointAvailable(endpoint: UpstreamEndpoint, requestId?: string) {
  const health = getEndpointHealth(endpoint);
  const now = Date.now();

  if (health.state === 'open') {
    if (health.cooldownUntil > now) {
      if (requestId) {
        logRequest(requestId, 'skipping upstream during circuit cooldown', {
          endpointName: endpoint.name,
          endpointUrl: endpoint.url,
          endpointHealth: getEndpointHealthSnapshot(endpoint),
        });
      }
      return false;
    }

    health.state = 'half_open';
    health.halfOpenProbeInFlight = 0;
    if (requestId) {
      logRequest(requestId, 'endpoint circuit moved to half-open', {
        endpointName: endpoint.name,
        endpointUrl: endpoint.url,
        endpointHealth: getEndpointHealthSnapshot(endpoint),
      });
    }
  }

  if (health.state === 'half_open' && health.halfOpenProbeInFlight >= Math.max(1, getConfig().endpointHalfOpenMaxProbes)) {
    if (requestId) {
      logRequest(requestId, 'skipping upstream because half-open probe is already in flight', {
        endpointName: endpoint.name,
        endpointUrl: endpoint.url,
        endpointHealth: getEndpointHealthSnapshot(endpoint),
      });
    }
    return false;
  }

  return true;
}

function reserveEndpointProbe(endpoint: UpstreamEndpoint) {
  const health = getEndpointHealth(endpoint);
  if (health.state === 'half_open') {
    health.halfOpenProbeInFlight += 1;
  }
}

function releaseEndpointProbe(endpoint: UpstreamEndpoint) {
  const health = getEndpointHealth(endpoint);
  if (health.halfOpenProbeInFlight > 0) {
    health.halfOpenProbeInFlight -= 1;
  }
}

function canFallbackWithinBudget(
  requestSignal: AbortSignal,
  endpointIndex: number,
  endpoints: UpstreamEndpoint[],
  budget: FallbackBudget,
) {
  if (requestSignal.aborted || endpointIndex >= endpoints.length - 1) {
    return false;
  }

  if (budget.attemptsUsed >= Math.max(0, getConfig().maxFallbackAttempts)) {
    return false;
  }

  if (getConfig().maxFallbackTotalMs > 0 && Date.now() - budget.startedAt >= getConfig().maxFallbackTotalMs) {
    return false;
  }

  return true;
}

function canContinueSearchingUpstreams(
  requestSignal: AbortSignal,
  budget: FallbackBudget,
  attemptedIndices: Set<number>,
  startIndex: number,
  endpoints: UpstreamEndpoint[],
) {
  if (requestSignal.aborted) {
    return false;
  }

  if (budget.attemptsUsed >= Math.max(0, getConfig().maxFallbackAttempts)) {
    return false;
  }

  if (getConfig().maxFallbackTotalMs > 0 && Date.now() - budget.startedAt >= getConfig().maxFallbackTotalMs) {
    return false;
  }

  return attemptedIndices.size < Math.max(0, endpoints.length - startIndex);
}

function findNextAvailableEndpointIndex(
  requestId: string,
  endpoints: UpstreamEndpoint[],
  startIndex: number,
  searchStartIndex: number,
  attemptedIndices: Set<number>,
) {
  const boundedStartIndex = Math.max(0, Math.min(startIndex, endpoints.length));
  const boundedSearchStartIndex = Math.max(boundedStartIndex, Math.min(searchStartIndex, endpoints.length));

  const scanRange = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) {
      if (attemptedIndices.has(index)) {
        continue;
      }

      const endpoint = endpoints[index];
      if (endpoint && isEndpointAvailable(endpoint, requestId)) {
        return index;
      }
    }

    return undefined;
  };

  return scanRange(boundedSearchStartIndex, endpoints.length) ?? scanRange(boundedStartIndex, boundedSearchStartIndex);
}

function attachEndpointToError(error: unknown, endpoint: UpstreamEndpoint, abortReason?: AbortReason) {
  if (error instanceof Error) {
    const enrichedError = error as Error & { abortReason?: AbortReason; endpoint?: UpstreamEndpoint };
    if (abortReason) {
      enrichedError.abortReason = abortReason;
    }
    enrichedError.endpoint = endpoint;
    return enrichedError;
  }

  return {
    error,
    abortReason,
    endpoint,
  };
}

function getEndpointFromError(error: unknown) {
  if (typeof error !== 'object' || error === null || !('endpoint' in error)) {
    return undefined;
  }

  const endpoint = (error as { endpoint?: unknown }).endpoint;
  if (
    typeof endpoint === 'object' &&
    endpoint !== null &&
    'name' in endpoint &&
    'url' in endpoint &&
    'apiKey' in endpoint &&
    typeof endpoint.name === 'string' &&
    typeof endpoint.url === 'string' &&
    typeof endpoint.apiKey === 'string'
  ) {
    return endpoint as UpstreamEndpoint;
  }

  return undefined;
}

function logRequest(requestId: string, message: string, extra?: Record<string, unknown>) {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[${requestId}] ${message}${suffix}`);
}

function sanitizeForLog(value: JsonValue, maxStringLength = 1200): JsonValue {
  if (typeof value === 'string') {
    if (value.length <= maxStringLength) {
      return value;
    }

    return `${value.slice(0, maxStringLength)}...[truncated ${value.length - maxStringLength} chars]`;
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForLog(item, maxStringLength));
  }

  if (!isJsonRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, sanitizeForLog(entryValue, maxStringLength)]),
  );
}

function logRequestBodiesPreview(requestId: string, requestBody: JsonRecord, upstreamBody: JsonRecord) {
  if (!getConfig().logRequestBodies) {
    return;
  }

  logRequest(requestId, 'request body preview', {
    requestBody: sanitizeForLog(requestBody),
    upstreamBody: sanitizeForLog(upstreamBody),
  });
}

function logSseDebug(requestId: string, events: Array<{ event: string; data: string }>) {
  if (!getConfig().debugSse) {
    return;
  }

  const preview = events.slice(0, 8).map(item => ({
    event: item.event,
    dataPreview: item.data.slice(0, 240),
  }));

  logRequest(requestId, 'sse debug preview', {
    eventCount: events.length,
    preview,
  });
}

function logRequestAccepted(
  requestId: string,
  req: import('node:http').IncomingMessage,
  streamResponse: boolean,
  streamMode: StreamMode,
) {
  logRequest(requestId, 'request accepted', {
    method: req.method,
    url: req.url,
    stream: streamResponse,
    mode: streamMode,
    active: activeRequests,
  });
}

function logForwardingUpstream(
  requestId: string,
  requestBody: JsonRecord,
  upstreamBody: JsonRecord,
  streamResponse: boolean,
  streamMode: StreamMode,
  responsesConnectTimeoutMs: number,
  responsesFirstByteTimeoutMs: number,
) {
  const details: Record<string, unknown> = {
    model: typeof upstreamBody.model === 'string' ? upstreamBody.model : null,
    requestedModel: typeof requestBody.model === 'string' ? requestBody.model : null,
    stream: streamResponse,
    mode: streamMode,
    connectMs: responsesConnectTimeoutMs,
    firstByteMs: responsesFirstByteTimeoutMs,
  };

  if (getConfig().forceStoreFalse) {
    details.forceStoreFalse = true;
  }

  if (getConfig().defaultPromptCacheRetention !== null) {
    details.promptCacheRetention = getConfig().defaultPromptCacheRetention;
  }

  if (getConfig().defaultPromptCacheKey !== null) {
    details.promptCacheKey = getConfig().defaultPromptCacheKey;
  }

  if (getConfig().clearDeveloperContent) {
    details.clearDeveloper = true;
  }

  if (getConfig().clearSystemContent) {
    details.clearSystem = true;
  }

  if (getConfig().clearInstructions) {
    details.clearInstructions = true;
  }

  if (getConfig().overrideInstructionsText !== null) {
    details.overrideInstructions = true;
  }

  logRequest(requestId, 'forwarding upstream', details);
}

async function writeSseFailureDebug(
  requestId: string,
  upstreamContentType: string,
  upstreamStatus: number,
  upstreamText: string,
) {
  if (!getConfig().sseFailureDebugEnabled) {
    return;
  }

  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(getConfig().sseFailureDebugDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileBase = `${timestamp}_${requestId}_status${upstreamStatus}`;

    await fs.writeFile(
      path.join(getConfig().sseFailureDebugDir, `${fileBase}.json`),
      JSON.stringify(
        {
          requestId,
          upstreamContentType,
          upstreamStatus,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.writeFile(path.join(getConfig().sseFailureDebugDir, `${fileBase}.sse.txt`), upstreamText, 'utf8');
  } catch (error) {
    logRequest(requestId, 'failed to write SSE failure debug files', {
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
  }
}

async function writeStreamMissingUsageDebug(
  requestId: string,
  upstreamStatus: number,
  streamMode: StreamMode,
  chunkCount: number,
  totalBytes: number,
  streamEventCount: number,
  upstreamText: string,
) {
  if (!getConfig().streamMissingUsageDebugEnabled) {
    return;
  }

  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(getConfig().streamMissingUsageDebugDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileBase = `${timestamp}_${requestId}_status${upstreamStatus}`;

    await fs.writeFile(
      path.join(getConfig().streamMissingUsageDebugDir, `${fileBase}.json`),
      JSON.stringify(
        {
          requestId,
          upstreamStatus,
          streamMode,
          chunkCount,
          totalBytes,
          streamEventCount,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.writeFile(path.join(getConfig().streamMissingUsageDebugDir, `${fileBase}.sse.txt`), upstreamText, 'utf8');
  } catch (error) {
    logRequest(requestId, 'failed to write stream missing usage debug files', {
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
  }
}

function sendJson(res: import('node:http').ServerResponse, statusCode: number, body: JsonValue) {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // Best-effort only: headers were already committed.
    }
    return;
  }

  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(body, null, 2));
}

function extractResponseId(responseObject: JsonRecord) {
  return typeof responseObject.id === 'string' ? responseObject.id : undefined;
}

function cacheResponse(responseObject: JsonRecord) {
  const id = extractResponseId(responseObject);
  if (!id) {
    return;
  }

  responseCache.set(id, responseObject);
  proxyStats.cacheStores += 1;

  while (responseCache.size > getConfig().maxCachedResponses) {
    const oldestKey = responseCache.keys().next().value;
    if (!oldestKey) {
      break;
    }

    responseCache.delete(oldestKey);
    proxyStats.cacheEvictions += 1;
  }
}

function clearResponseCache() {
  const cleared = responseCache.size;
  responseCache.clear();
  proxyStats.cacheClears += 1;
  return cleared;
}

function recordStatus(statusCode: number) {
  if (statusCode >= 400 && statusCode < 500) {
    proxyStats.errors4xx += 1;
  }

  if (statusCode >= 500) {
    proxyStats.errors5xx += 1;
  }
}

function getAdminStats() {
  return {
    instanceName: getConfig().instanceName,
    host: getConfig().host,
    port: getConfig().port,
    primaryProviderName: getConfig().primaryProviderName,
    upstreamUrl: getConfig().upstreamUrl,
    upstreamModelsUrl: getConfig().upstreamModelsUrl,
    fallbackConfigPath: getConfig().fallbackConfigPath,
    modelMappingPath: getConfig().modelMappingPath,
    fallbackNames: getConfig().fallbackEndpoints.map(item => item.name),
    modelMappings: getConfig().modelMappings,
    activeRequests,
    maxConcurrentRequests: getConfig().maxConcurrentRequests,
    cachedResponses: responseCache.size,
    maxCachedResponses: getConfig().maxCachedResponses,
    upstreamTimeoutMs: getConfig().upstreamTimeoutMs,
    nonStreamingRequestTimeoutMs: getConfig().nonStreamingRequestTimeoutMs,
    firstByteTimeoutMs: getConfig().firstByteTimeoutMs,
    firstTextTimeoutMs: getConfig().firstTextTimeoutMs,
    streamIdleTimeoutMs: getConfig().streamIdleTimeoutMs,
    totalRequestTimeoutMs: getConfig().totalRequestTimeoutMs,
    defaultStreamMode: getConfig().defaultStreamMode,
    forceStoreFalse: getConfig().forceStoreFalse,
    clearDeveloperContent: getConfig().clearDeveloperContent,
    clearInstructions: getConfig().clearInstructions,
    clearSystemContent: getConfig().clearSystemContent,
    overrideInstructionsText: getConfig().overrideInstructionsText,
    logRequestBodies: getConfig().logRequestBodies,
    debugSse: getConfig().debugSse,
    fallbackOnRetryable4xx: getConfig().fallbackOnRetryable4xx,
    fallbackOnCompat4xx: getConfig().fallbackOnCompat4xx,
    compatFallbackPatterns: getConfig().compatFallbackPatterns,
    clientErrorPatterns: getConfig().clientErrorPatterns,
    endpointTimeoutCooldownMs: getConfig().endpointTimeoutCooldownMs,
    endpointInvalidResponseCooldownMs: getConfig().endpointInvalidResponseCooldownMs,
    endpointAuthCooldownMs: getConfig().endpointAuthCooldownMs,
    endpointFailureThreshold: getConfig().endpointFailureThreshold,
    endpointHalfOpenMaxProbes: getConfig().endpointHalfOpenMaxProbes,
    maxFallbackAttempts: getConfig().maxFallbackAttempts,
    maxFallbackTotalMs: getConfig().maxFallbackTotalMs,
    endpointHealth: getConfig().responsesEndpoints.map(endpoint => ({
      name: endpoint.name,
      url: endpoint.url,
      isFallback: endpoint.isFallback,
      ...getEndpointHealthSnapshot(endpoint),
    })),
    stats: proxyStats,
  };
}

function makeError(message: string, status = 400, details?: JsonValue) {
  return {
    status,
    body: {
      error: {
        message,
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
        ...(details === undefined ? {} : { details }),
      },
    },
  };
}

function abortWithReason(controller: AbortController, reason: AbortReason) {
  if (!controller.signal.aborted) {
    controller.abort(reason);
  }
}

function getAbortReason(signal: AbortSignal): AbortReason | undefined {
  const reason = signal.reason;
  if (typeof reason !== 'object' || reason === null || !('kind' in reason)) {
    return undefined;
  }

  const abortReason = reason as AbortReason;
  if (abortReason.kind === 'timeout') {
    if (
      abortReason.phase === 'connect' ||
      abortReason.phase === 'first-byte' ||
      abortReason.phase === 'first-text' ||
      abortReason.phase === 'idle' ||
      abortReason.phase === 'total'
    ) {
      return abortReason;
    }

    return undefined;
  }

  if (abortReason.kind === 'client_disconnect') {
    if (abortReason.source === 'request' || abortReason.source === 'response') {
      return abortReason;
    }

    return undefined;
  }

  return undefined;
}

function isAbortErrorLike(error: unknown, abortReason: AbortReason | undefined) {
  if (!abortReason) {
    return false;
  }

  if (error instanceof Error) {
    return error.name === 'AbortError';
  }

  return typeof error === 'object' && error !== null;
}

function createTimeoutMessage(
  phase: 'connect' | 'first-byte' | 'first-text' | 'idle' | 'total',
  timeouts?: { connect?: number; firstByte?: number; firstText?: number; idle?: number; total?: number },
) {
  const connectTimeoutMs = timeouts?.connect ?? getConfig().upstreamTimeoutMs;
  const firstChunkTimeoutMs = timeouts?.firstByte ?? getConfig().firstByteTimeoutMs;
  const firstTextPhaseTimeoutMs = timeouts?.firstText ?? getConfig().firstTextTimeoutMs;
  const idleTimeoutMs = timeouts?.idle ?? getConfig().streamIdleTimeoutMs;
  const totalTimeoutMs = timeouts?.total ?? getConfig().totalRequestTimeoutMs;

  if (phase === 'connect') {
    return `Upstream did not produce an initial response within ${connectTimeoutMs}ms`;
  }

  if (phase === 'first-byte') {
    return `Upstream response body did not produce a first chunk within ${firstChunkTimeoutMs}ms`;
  }

  if (phase === 'first-text') {
    return `Upstream response stream did not produce text output within ${firstTextPhaseTimeoutMs}ms`;
  }

  if (phase === 'idle') {
    return `Upstream response stream was idle for more than ${idleTimeoutMs}ms`;
  }

  return `Upstream request exceeded total lifetime limit of ${totalTimeoutMs}ms`;
}

function getResponsesConnectTimeoutMs(streamResponse: boolean) {
  return streamResponse ? getConfig().upstreamTimeoutMs : getConfig().nonStreamingRequestTimeoutMs;
}

function getResponsesFirstByteTimeoutMs(streamResponse: boolean) {
  return streamResponse ? getConfig().firstByteTimeoutMs : getConfig().nonStreamingRequestTimeoutMs;
}

function wantsStreaming(req: import('node:http').IncomingMessage, body: JsonRecord) {
  if (body.stream === true) {
    return true;
  }

  const accept = req.headers.accept ?? '';
  return accept.includes('text/event-stream');
}

function getStreamMode(req: import('node:http').IncomingMessage, body: JsonRecord): StreamMode {
  const bodyMode = typeof body.proxy_stream_mode === 'string' ? body.proxy_stream_mode.toLowerCase() : undefined;
  if (bodyMode === 'raw' || bodyMode === 'normalized') {
    return bodyMode;
  }

  const headerMode = typeof req.headers['x-proxy-stream-mode'] === 'string'
    ? req.headers['x-proxy-stream-mode'].toLowerCase()
    : undefined;

  if (headerMode === 'raw' || headerMode === 'normalized') {
    return headerMode;
  }

  return getConfig().defaultStreamMode;
}

function normalizeRequestBody(body: JsonRecord, stream: boolean): JsonRecord {
  const { proxy_stream_mode: _proxyStreamMode, ...rest } = body;
  const requestedModel = typeof rest.model === 'string' ? rest.model : getConfig().defaultModel;
  const mappedModel = getConfig().modelMappings[requestedModel] ?? requestedModel;
  const instructions =
    getConfig().overrideInstructionsText !== null
      ? getConfig().overrideInstructionsText
      : getConfig().clearInstructions && typeof rest.instructions === 'string'
      ? ''
      : rest.instructions;
  const promptCacheRetention =
    typeof rest.prompt_cache_retention === 'string' && ['in_memory', '24h'].includes(rest.prompt_cache_retention)
      ? rest.prompt_cache_retention
      : getConfig().defaultPromptCacheRetention;
  const promptCacheKey =
    typeof rest.prompt_cache_key === 'string' && rest.prompt_cache_key.trim().length > 0
      ? rest.prompt_cache_key
      : getConfig().defaultPromptCacheKey;

  return {
    ...rest,
    model: mappedModel,
    ...(rest.instructions === undefined && getConfig().overrideInstructionsText === null ? {} : { instructions }),
    ...(promptCacheRetention === null ? {} : { prompt_cache_retention: promptCacheRetention }),
    ...(promptCacheKey === null ? {} : { prompt_cache_key: promptCacheKey }),
    input: normalizeInput(rest.input, {
      clearDeveloperContent: getConfig().clearDeveloperContent,
      clearSystemContent: getConfig().clearSystemContent,
      convertSystemToDeveloper: getConfig().convertSystemToDeveloper,
    }),
    stream,
    ...(getConfig().forceStoreFalse ? { store: false } : {}),
  };
}

function applyModelMappingsToModelsPayload(payload: unknown) {
  if (!isJsonRecord(payload) || !Array.isArray(payload.data) || Object.keys(getConfig().modelMappings).length === 0) {
    return { payload, aliasCount: 0 };
  }

  const data = payload.data.map(item => (isJsonRecord(item) ? { ...item } : item));
  const existingIds = new Set<string>();
  const entriesById = new Map<string, JsonRecord>();

  for (const item of data) {
    if (!isJsonRecord(item) || typeof item.id !== 'string') {
      continue;
    }

    existingIds.add(item.id);
    entriesById.set(item.id, item);
  }

  let aliasCount = 0;
  for (const [alias, target] of Object.entries(getConfig().modelMappings)) {
    if (existingIds.has(alias)) {
      continue;
    }

    const targetEntry = entriesById.get(target);
    if (!targetEntry) {
      continue;
    }

    data.push({
      ...targetEntry,
      id: alias,
    });
    existingIds.add(alias);
    aliasCount += 1;
  }

  if (aliasCount === 0) {
    return { payload, aliasCount };
  }

  return {
    payload: {
      ...payload,
      data,
    },
    aliasCount,
  };
}

function addUsageToStats(usage: JsonRecord | undefined) {
  if (!usage) {
    return;
  }

  proxyStats.usageResponses += 1;

  if (typeof usage.inputTokens === 'number') {
    proxyStats.usageInputTokens += usage.inputTokens;
  }

  if (typeof usage.outputTokens === 'number') {
    proxyStats.usageOutputTokens += usage.outputTokens;
  }

  if (typeof usage.totalTokens === 'number') {
    proxyStats.usageTotalTokens += usage.totalTokens;
  }

  if (typeof usage.cachedInputTokens === 'number') {
    proxyStats.usageCachedInputTokens += usage.cachedInputTokens;
  }

  if (typeof usage.reasoningTokens === 'number') {
    proxyStats.usageReasoningTokens += usage.reasoningTokens;
  }
}

function extractTextLengthFromResponsesPayload(payload: unknown): number {
  if (!isJsonRecord(payload)) {
    return 0;
  }

  // Standard delta / done events
  if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
    return payload.delta.length;
  }

  if (payload.type === 'response.output_text.done' && typeof payload.text === 'string') {
    return payload.text.length;
  }

  // content_part.done with output_text text
  if (payload.type === 'response.content_part.done' && isJsonRecord(payload.part)) {
    const part = payload.part;
    if (part.type === 'output_text' && typeof part.text === 'string') {
      return part.text.length;
    }
  }

  // response.completed or response.output_item.done may carry full output
  if (
    (payload.type === 'response.completed' || payload.type === 'response.output_item.done') &&
    isJsonRecord(payload.response ?? payload.item)
  ) {
    const container = (payload.response ?? payload.item) as JsonRecord;
    const outputLen = extractTextLengthFromResponseObject(container);
    if (outputLen > 0) {
      return outputLen;
    }
  }

  return 0;
}

function extractTextLengthFromResponseObject(obj: JsonRecord): number {
  if (!Array.isArray(obj.output)) {
    return 0;
  }

  let total = 0;
  for (const item of obj.output) {
    if (!isJsonRecord(item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const part of item.content) {
      if (!isJsonRecord(part)) {
        continue;
      }

      if (part.type === 'output_text' && typeof part.text === 'string') {
        total += part.text.length;
      }
    }
  }

  return total;
}

function hasMeaningfulResponseOutput(responseObject: JsonRecord | undefined) {
  if (!responseObject || !Array.isArray(responseObject.output)) {
    return false;
  }

  for (const item of responseObject.output) {
    if (!isJsonRecord(item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const part of item.content) {
      if (!isJsonRecord(part)) {
        continue;
      }

      if (part.type === 'output_text' && typeof part.text === 'string' && part.text.length > 0) {
        return true;
      }
    }
  }

  return false;
}

function canAttemptFallbackAfterStreamOutcome(
  outcome: {
    startedStreaming: boolean;
    wroteAnyEvent: boolean;
    wroteTextContent: boolean;
  },
  requestSignal: AbortSignal,
  endpointIndex: number,
  endpoints: UpstreamEndpoint[],
  budget: FallbackBudget,
) {
  return !outcome.wroteTextContent && canFallbackWithinBudget(requestSignal, endpointIndex, endpoints, budget);
}

function canAttemptFallback(
  requestSignal: AbortSignal,
  endpointIndex: number,
  endpoints: UpstreamEndpoint[],
  budget: FallbackBudget,
) {
  return canFallbackWithinBudget(requestSignal, endpointIndex, endpoints, budget);
}

async function readJsonBody(req: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    return {} as JsonRecord;
  }

  return JSON.parse(raw) as JsonRecord;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  controller: AbortController,
  connectTimeoutMs = getConfig().upstreamTimeoutMs,
) {
  const timeout = setTimeout(() => {
    abortWithReason(controller, { kind: 'timeout', phase: 'connect' });
  }, connectTimeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function closeResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup only.
  }
}

function createLinkedAbortController(parentSignal: AbortSignal) {
  const controller = new AbortController();

  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return { controller, dispose: () => {} };
  }

  const handleAbort = () => {
    controller.abort(parentSignal.reason);
  };

  parentSignal.addEventListener('abort', handleAbort, { once: true });

  return {
    controller,
    dispose: () => {
      parentSignal.removeEventListener('abort', handleAbort);
    },
  };
}

async function fetchResponsesUpstream(
  requestId: string,
  upstreamBody: JsonRecord,
  parentSignal: AbortSignal,
  streamResponse: boolean,
  budget: FallbackBudget,
  startIndex = 0,
): Promise<UpstreamAttempt> {
  const endpoints = getConfig().responsesEndpoints;
  const connectTimeoutMs = getResponsesConnectTimeoutMs(streamResponse);

  const boundedStartIndex = Math.max(0, Math.min(startIndex, endpoints.length));
  const attemptedIndices = new Set<number>();
  let searchStartIndex = boundedStartIndex;

  while (true) {
    const index = findNextAvailableEndpointIndex(requestId, endpoints, boundedStartIndex, searchStartIndex, attemptedIndices);
    if (index === undefined) {
      break;
    }

    const endpoint = endpoints[index];

    const linkedController = createLinkedAbortController(parentSignal);
    reserveEndpointProbe(endpoint);

    if (index > 0) {
      logRequest(requestId, 'attempting fallback upstream', {
        fallbackName: endpoint.name,
        fallbackUrl: endpoint.url,
        attempt: index,
        totalFallbacks: getConfig().fallbackEndpoints.length,
        fallbackAttemptsUsed: budget.attemptsUsed,
        fallbackBudgetRemainingMs: getConfig().maxFallbackTotalMs > 0 ? Math.max(0, getConfig().maxFallbackTotalMs - (Date.now() - budget.startedAt)) : null,
        endpointHealth: getEndpointHealthSnapshot(endpoint),
      });
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        endpoint.url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${endpoint.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(upstreamBody),
        },
        linkedController.controller,
        connectTimeoutMs,
      );
    } catch (error) {
      const abortReason = getAbortReason(linkedController.controller.signal);
      const connectTimeoutAbortReason =
        isAbortErrorLike(error, abortReason) && abortReason?.kind === 'timeout' && abortReason.phase === 'connect'
          ? abortReason
          : undefined;
      linkedController.dispose();
      releaseEndpointProbe(endpoint);
      attemptedIndices.add(index);

      const nextIndex =
        connectTimeoutAbortReason &&
        canContinueSearchingUpstreams(parentSignal, budget, attemptedIndices, boundedStartIndex, endpoints)
          ? findNextAvailableEndpointIndex(requestId, endpoints, boundedStartIndex, index + 1, attemptedIndices)
          : undefined;
      const connectTimeoutPhase = connectTimeoutAbortReason?.phase;

      if (nextIndex !== undefined && connectTimeoutPhase) {
        budget.attemptsUsed += 1;
        recordFallbackReason('headers_only_timeout', endpoint.name);
        markEndpointFailure(endpoint, 'connect_timeout', requestId, { phase: connectTimeoutPhase });
        logRequest(requestId, 'upstream connect timeout encountered, falling back', {
          upstreamName: endpoint.name,
          upstreamUrl: endpoint.url,
          phase: connectTimeoutPhase,
          nextFallbackName: endpoints[nextIndex]?.name ?? null,
        });
        searchStartIndex = nextIndex;
        continue;
      }

      if (connectTimeoutAbortReason) {
        markEndpointFailure(endpoint, 'connect_timeout', requestId, { phase: connectTimeoutAbortReason.phase });
      }

      throw attachEndpointToError(error, endpoint, abortReason);
    }

    if (index > 0 && response.ok) {
      logRequest(requestId, 'fallback upstream succeeded', {
        fallbackName: endpoint.name,
        fallbackUrl: endpoint.url,
        upstreamStatus: response.status,
        upstreamContentType: response.headers.get('content-type') ?? null,
      });
    }

    if (response.ok) {
      return {
        endpoint,
        endpointIndex: index,
        response,
        controller: linkedController.controller,
        dispose: () => {
          releaseEndpointProbe(endpoint);
          linkedController.dispose();
        },
      };
    }

    const upstreamContentType = response.headers.get('content-type') ?? '';
    let parsedErrorPayload: unknown;
    let errorPreview: string | undefined;

    try {
      const errorText = await response.clone().text();
      parsedErrorPayload = parseBestEffortErrorPayload(errorText, upstreamContentType);
      errorPreview = extractErrorMessage(parsedErrorPayload) ?? errorText.trim().slice(0, 300);
    } catch (error) {
      errorPreview = error instanceof Error ? error.message : String(error);
    }

    attemptedIndices.add(index);
    const nextIndex = canContinueSearchingUpstreams(parentSignal, budget, attemptedIndices, boundedStartIndex, endpoints)
      ? findNextAvailableEndpointIndex(requestId, endpoints, boundedStartIndex, index + 1, attemptedIndices)
      : undefined;

    const fallbackReason = getUpstreamFallbackReason(response.status, parsedErrorPayload, {
      fallbackOnRetryable4xx: getConfig().fallbackOnRetryable4xx,
      fallbackOnCompat4xx: getConfig().fallbackOnCompat4xx,
      compatFallbackPatterns: getConfig().compatFallbackPatterns,
      clientErrorPatterns: getConfig().clientErrorPatterns,
    });

    if (!fallbackReason) {
      logRequest(requestId, 'upstream error did not match fallback policy', {
        upstreamName: endpoint.name,
        upstreamUrl: endpoint.url,
        upstreamStatus: response.status,
        upstreamContentType,
        errorPreview,
        fallbackOnRetryable4xx: getConfig().fallbackOnRetryable4xx,
        fallbackOnCompat4xx: getConfig().fallbackOnCompat4xx,
      });
      return {
        endpoint,
        endpointIndex: index,
        response,
        controller: linkedController.controller,
        dispose: () => {
          releaseEndpointProbe(endpoint);
          linkedController.dispose();
        },
      };
    }

    if (nextIndex !== undefined) {
      budget.attemptsUsed += 1;
    }
    logRequest(requestId, 'upstream error matched fallback policy', {
      upstreamName: endpoint.name,
      upstreamUrl: endpoint.url,
      upstreamStatus: response.status,
      upstreamContentType,
      errorPreview,
      fallbackReason,
      nextFallbackName: nextIndex !== undefined ? endpoints[nextIndex]?.name ?? null : null,
    });

    recordFallbackReason(fallbackReason, endpoint.name);
    markEndpointFailure(endpoint, fallbackReason, requestId, {
      upstreamStatus: response.status,
      upstreamContentType,
    });

    if (nextIndex === undefined) {
      return {
        endpoint,
        endpointIndex: index,
        response,
        controller: linkedController.controller,
        dispose: () => {
          releaseEndpointProbe(endpoint);
          linkedController.dispose();
        },
      };
    }

    await closeResponseBody(response);
    releaseEndpointProbe(endpoint);
    linkedController.dispose();
    searchStartIndex = nextIndex;
  }

  throw new Error('No upstream endpoint configured');
}

async function readResponseText(
  upstreamResponse: Response,
  controller: AbortController,
  firstChunkTimeoutMs = getConfig().firstByteTimeoutMs,
): Promise<string> {
  if (!upstreamResponse.body) {
    return '';
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  let sawFirstChunk = false;

  const resetBodyTimer = (phase: 'first-byte' | 'idle') => {
    if (bodyTimer) {
      clearTimeout(bodyTimer);
    }

    bodyTimer = setTimeout(() => {
      abortWithReason(controller, { kind: 'timeout', phase });
    }, phase === 'first-byte' ? firstChunkTimeoutMs : getConfig().streamIdleTimeoutMs);
  };

  resetBodyTimer('first-byte');

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value || value.byteLength === 0) {
        continue;
      }

      chunks.push(decoder.decode(value, { stream: true }));
      sawFirstChunk = true;
      resetBodyTimer('idle');
    }

    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    if (bodyTimer) {
      clearTimeout(bodyTimer);
    }

    if (!sawFirstChunk) {
      chunks.push(decoder.decode());
    }

    reader.releaseLock();
  }
}

async function probeAndPipeResponsesTextStream(
  upstreamResponse: Response,
  res: import('node:http').ServerResponse,
  requestBody: JsonRecord,
  streamMode: StreamMode,
  controller: AbortController,
): Promise<StreamProbeOutcome> {
  if (!upstreamResponse.body) {
    return {
      kind: 'buffered_text',
      text: '',
      chunkCount: 0,
      totalBytes: 0,
      streamEventCount: 0,
      wroteAnyEvent: false,
      wroteTextContent: false,
      textCharCount: 0,
    };
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let chunkCount = 0;
  let totalBytes = 0;
  let collectedText = '';
  let pending = '';
  let usage: JsonRecord | undefined;
  let streamEventCount = 0;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  let firstTextTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingClientEvents: string[] = [];
  let detectedResponsesStream = false;
  let startedStreaming = false;
  let wroteAnyEvent = false;
  let wroteTextContent = false;
  let textCharCount = 0;
  const enforceFirstTextTimeout = getConfig().firstTextTimeoutMs > 0;

  const ensureSseHeaders = () => {
    if (res.headersSent) {
      return;
    }

    res.writeHead(upstreamResponse.status, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
    });
  };

  const writeSseEvent = (event: { event: string; data: string }) => {
    ensureSseHeaders();
    startedStreaming = true;
    wroteAnyEvent = true;
    res.write(formatSseEvent(event));
  };

  const resetStreamTimer = (phase: 'first-byte' | 'idle') => {
    if (streamTimer) {
      clearTimeout(streamTimer);
    }

    streamTimer = setTimeout(() => {
      abortWithReason(controller, { kind: 'timeout', phase });
    }, phase === 'first-byte' ? getConfig().firstByteTimeoutMs : getConfig().streamIdleTimeoutMs);
  };

  const clearFirstTextTimer = () => {
    if (firstTextTimer) {
      clearTimeout(firstTextTimer);
      firstTextTimer = undefined;
    }
  };

  const armFirstTextTimer = () => {
    if (!enforceFirstTextTimeout || wroteTextContent || firstTextTimer) {
      return;
    }

    firstTextTimer = setTimeout(() => {
      abortWithReason(controller, { kind: 'timeout', phase: 'first-text' });
    }, getConfig().firstTextTimeoutMs);
  };

  const flushPendingBlocks = () => {
    let separatorIndex = pending.search(/\r?\n\r?\n/);
    while (separatorIndex !== -1) {
      const block = pending.slice(0, separatorIndex);
      const separatorMatch = pending.slice(separatorIndex).match(/^\r?\n\r?\n/);
      const separatorLength = separatorMatch ? separatorMatch[0].length : 2;
      pending = pending.slice(separatorIndex + separatorLength);

      if (block.trim()) {
        const parsedEvent = parseSseChunk(block);
        let normalizedEvent = parsedEvent;

        if (parsedEvent.data) {
          const parsedPayload = parseStreamPayload(parsedEvent.data);
          if (parsedPayload !== undefined) {
            usage = extractUsageFromStreamPayload(parsedPayload, requestBody) ?? usage;
            const textLength = extractTextLengthFromResponsesPayload(parsedPayload);
            textCharCount += textLength;
            if (textLength > 0) {
              wroteTextContent = true;
              clearFirstTextTimer();
            }
            normalizedEvent = {
              event: parsedEvent.event,
              data: JSON.stringify(normalizeStreamEventPayload(parsedPayload, requestBody)),
            };
          }
        }

        writeSseEvent(streamMode === 'normalized' ? normalizedEvent : parsedEvent);
        streamEventCount += 1;
      } else if (startedStreaming) {
        res.write('\n');
      }

      separatorIndex = pending.search(/\r?\n\r?\n/);
    }
  };

  resetStreamTimer('first-byte');
  armFirstTextTimer();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value || value.byteLength === 0) {
        continue;
      }

      chunkCount += 1;
      totalBytes += value.byteLength;
      const textChunk = decoder.decode(value, { stream: true });
      collectedText += textChunk;
      pending += textChunk;
      resetStreamTimer('idle');

      if (!detectedResponsesStream) {
        const separatorIndex = pending.search(/\r?\n\r?\n/);
        if (separatorIndex === -1) {
          continue;
        }

        const firstBlock = pending.slice(0, separatorIndex);
        if (!firstBlock.trim()) {
          flushPendingBlocks();
          continue;
        }

        detectedResponsesStream = isResponsesStyleEventStream([parseSseChunk(firstBlock)]);
        if (!detectedResponsesStream) {
          continue;
        }
      }

      flushPendingBlocks();
    }
  } catch (error) {
    if (controller.signal.aborted) {
      const abortReason = getAbortReason(controller.signal);

      if (
        abortReason?.kind === 'timeout' &&
        (abortReason.phase === 'first-byte' || abortReason.phase === 'first-text' || abortReason.phase === 'idle' || abortReason.phase === 'total')
      ) {
        if (startedStreaming) {
          sendResponsesStreamError(res, createTimeoutMessage(abortReason.phase), {
            statusCode: 504,
            code: 'server_error',
            sequenceNumber: chunkCount + 1,
          });
        }

        return {
          kind: 'timeout',
          phase: abortReason.phase,
          chunkCount,
          totalBytes,
          startedStreaming,
          wroteAnyEvent,
          wroteTextContent,
          textCharCount,
          fallbackReason: !wroteTextContent ? 'headers_only_timeout' : undefined,
        };
      }

      if (abortReason?.kind === 'client_disconnect') {
        if (startedStreaming && !res.writableEnded && !res.destroyed) {
          res.end();
        }

        return {
          kind: 'client_disconnect',
          source: abortReason.source,
          chunkCount,
          totalBytes,
          startedStreaming,
          wroteAnyEvent,
          wroteTextContent,
          textCharCount,
        };
      }
    }

    throw error;
  } finally {
    if (streamTimer) {
      clearTimeout(streamTimer);
    }
    clearFirstTextTimer();

    const finalChunk = decoder.decode();
    collectedText += finalChunk;
    pending += finalChunk;

    if (detectedResponsesStream) {
      flushPendingBlocks();
      if (pending.trim()) {
        const parsedEvent = parseSseChunk(pending);
        let normalizedEvent = parsedEvent;

        if (streamMode === 'normalized' && parsedEvent.data) {
          const parsedPayload = parseStreamPayload(parsedEvent.data);
          if (parsedPayload !== undefined) {
            usage = extractUsageFromStreamPayload(parsedPayload, requestBody) ?? usage;
            normalizedEvent = {
              event: parsedEvent.event,
              data: JSON.stringify(normalizeStreamEventPayload(parsedPayload, requestBody)),
            };
          }
        }

        writeSseEvent(streamMode === 'normalized' ? normalizedEvent : parsedEvent);
        streamEventCount += 1;
      }
    }

    reader.releaseLock();
  }

  if (detectedResponsesStream) {
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }

    if (usage) {
      addUsageToStats(usage);
    }

    const usageOutputTokens = usage && typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
    const effectiveWroteText = wroteTextContent || usageOutputTokens > 0;

    if (!effectiveWroteText && !usage) {
      return {
        kind: 'completed',
        chunkCount,
        totalBytes,
        usage,
        startedStreaming,
        wroteAnyEvent,
        wroteTextContent: effectiveWroteText,
        textCharCount,
        fallbackReason: 'stream_no_text_content',
      };
    }

    if (effectiveWroteText && !usage) {
      return {
        kind: 'completed',
        chunkCount,
        totalBytes,
        usage,
        startedStreaming,
        wroteAnyEvent,
        wroteTextContent: effectiveWroteText,
        textCharCount,
        fallbackReason: 'stream_missing_usage',
      };
    }

    return {
      kind: 'completed',
      chunkCount,
      totalBytes,
      usage,
      startedStreaming,
      wroteAnyEvent,
      wroteTextContent: effectiveWroteText,
      textCharCount,
    };
  }

  return {
    kind: 'buffered_text',
    text: collectedText,
    chunkCount,
    totalBytes,
    streamEventCount,
    wroteAnyEvent,
    wroteTextContent,
    textCharCount,
  };
}

async function pipeUpstreamSse(
  requestId: string,
  upstreamResponse: Response,
  res: import('node:http').ServerResponse,
  requestBody: JsonRecord,
  streamMode: StreamMode,
  controller: AbortController,
): Promise<StreamOutcome> {
  let startedStreaming = false;
  let wroteAnyEvent = false;
  let wroteTextContent = false;
  let textCharCount = 0;
  const pendingClientEvents: string[] = [];

  const ensureSseHeaders = () => {
    if (res.headersSent) {
      return;
    }

    res.writeHead(upstreamResponse.status, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
    });
  };

  const writeSseChunk = (chunk: string | Buffer) => {
    ensureSseHeaders();
    startedStreaming = true;
    res.write(chunk);
  };

  const flushPendingClientEvents = () => {
    if (pendingClientEvents.length === 0) {
      return;
    }

    for (const chunk of pendingClientEvents) {
      writeSseChunk(chunk);
    }
    pendingClientEvents.length = 0;
  };

  if (!upstreamResponse.body) {
    ensureSseHeaders();
    res.end();
    return {
      kind: 'completed',
      chunkCount: 0,
      totalBytes: 0,
      startedStreaming,
      wroteAnyEvent,
      wroteTextContent,
      textCharCount,
      fallbackReason: 'empty_response',
    };
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let chunkCount = 0;
  let totalBytes = 0;
  let collectedText = '';
  let pending = '';
  let usage: JsonRecord | undefined;
  let streamEventCount = 0;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  let firstTextTimer: ReturnType<typeof setTimeout> | undefined;
  const enforceFirstTextTimeout = getConfig().firstTextTimeoutMs > 0 && streamMode === 'normalized';

  const resetStreamTimer = (phase: 'first-byte' | 'idle') => {
    if (streamTimer) {
      clearTimeout(streamTimer);
    }

    streamTimer = setTimeout(() => {
      abortWithReason(controller, { kind: 'timeout', phase });
    }, phase === 'first-byte' ? getConfig().firstByteTimeoutMs : getConfig().streamIdleTimeoutMs);
  };

  const clearFirstTextTimer = () => {
    if (firstTextTimer) {
      clearTimeout(firstTextTimer);
      firstTextTimer = undefined;
    }
  };

  const armFirstTextTimer = () => {
    if (!enforceFirstTextTimeout || wroteTextContent || firstTextTimer) {
      return;
    }

    firstTextTimer = setTimeout(() => {
      abortWithReason(controller, { kind: 'timeout', phase: 'first-text' });
    }, getConfig().firstTextTimeoutMs);
  };

  resetStreamTimer('first-byte');
  armFirstTextTimer();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      chunkCount += 1;
      totalBytes += value.byteLength;
      const textChunk = decoder.decode(value, { stream: true });
      collectedText += textChunk;
      resetStreamTimer('idle');

      if (streamMode === 'raw') {
        writeSseChunk(Buffer.from(value));
        continue;
      }

      pending += textChunk;

      let separatorIndex = pending.search(/\r?\n\r?\n/);
      while (separatorIndex !== -1) {
        const block = pending.slice(0, separatorIndex);
        const separatorMatch = pending.slice(separatorIndex).match(/^\r?\n\r?\n/);
        const separatorLength = separatorMatch ? separatorMatch[0].length : 2;
        pending = pending.slice(separatorIndex + separatorLength);

        if (block.trim()) {
          const parsedEvent = parseSseChunk(block);
          let normalizedEvent = parsedEvent;

          if (parsedEvent.data) {
            try {
              const parsedPayload = JSON.parse(parsedEvent.data);
              usage = extractUsageFromStreamPayload(parsedPayload, requestBody) ?? usage;
              const textLength = extractTextLengthFromResponsesPayload(parsedPayload);
              textCharCount += textLength;
              if (textLength > 0) {
                wroteTextContent = true;
                clearFirstTextTimer();
              }
              normalizedEvent = {
                event: parsedEvent.event,
                data: JSON.stringify(normalizeStreamEventPayload(parsedPayload, requestBody)),
              };
            } catch {
              normalizedEvent = parsedEvent;
            }
          }

          const formattedEvent = formatSseEvent(normalizedEvent);
          if (wroteTextContent) {
            flushPendingClientEvents();
            writeSseChunk(formattedEvent);
          } else {
            pendingClientEvents.push(formattedEvent);
          }
          wroteAnyEvent = true;
          streamEventCount += 1;
        } else {
          if (wroteTextContent) {
            flushPendingClientEvents();
            writeSseChunk('\n');
          } else {
            pendingClientEvents.push('\n');
          }
        }

        separatorIndex = pending.search(/\r?\n\r?\n/);
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      const abortReason = getAbortReason(controller.signal);

      if (
        abortReason?.kind === 'timeout' &&
        (abortReason.phase === 'first-byte' || abortReason.phase === 'first-text' || abortReason.phase === 'idle' || abortReason.phase === 'total')
      ) {
        if (startedStreaming) {
          sendResponsesStreamError(res, createTimeoutMessage(abortReason.phase), {
            statusCode: 504,
            code: 'server_error',
            sequenceNumber: chunkCount + 1,
          });
        }

        return {
          kind: 'timeout',
          phase: abortReason.phase,
          chunkCount,
          totalBytes,
          startedStreaming,
          wroteAnyEvent,
          wroteTextContent,
          textCharCount,
          fallbackReason: !wroteTextContent ? 'headers_only_timeout' : undefined,
        };
      }

      if (abortReason?.kind === 'client_disconnect') {
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }

        return {
          kind: 'client_disconnect',
          source: abortReason.source,
          chunkCount,
          totalBytes,
          startedStreaming,
          wroteAnyEvent,
          wroteTextContent,
          textCharCount,
        };
      }
    }

    throw error;
  } finally {
    if (streamTimer) {
      clearTimeout(streamTimer);
    }
    clearFirstTextTimer();

    const finalChunk = decoder.decode();
    collectedText += finalChunk;

    if (streamMode === 'normalized' && !controller.signal.aborted) {
      pending += finalChunk;
      if (pending.trim()) {
        const parsedEvent = parseSseChunk(pending);
        let normalizedEvent = parsedEvent;

        if (parsedEvent.data) {
          try {
            const parsedPayload = JSON.parse(parsedEvent.data);
            const textLength = extractTextLengthFromResponsesPayload(parsedPayload);
            textCharCount += textLength;
            if (textLength > 0) {
              wroteTextContent = true;
            }
            normalizedEvent = {
              event: parsedEvent.event,
              data: JSON.stringify(normalizeStreamEventPayload(parsedPayload, requestBody)),
            };
          } catch {
            normalizedEvent = parsedEvent;
          }
        }

        const formattedEvent = formatSseEvent(normalizedEvent);
        if (wroteTextContent) {
          flushPendingClientEvents();
          writeSseChunk(formattedEvent);
        } else {
          pendingClientEvents.push(formattedEvent);
        }
      }
    }

    if (!controller.signal.aborted) {
      const events = parseSse(collectedText);
      logSseDebug(requestId, events);
      const responseObject = synthesizeResponseFromEvents(events);
      if (responseObject) {
        const normalizedResponse = normalizeResponseObject(responseObject, requestBody);
        cacheResponse(normalizedResponse);
        usage = extractUsageMetrics(normalizedResponse) ?? usage;
        if (hasMeaningfulResponseOutput(normalizedResponse)) {
          wroteTextContent = true;
        }
        addUsageToStats(usage);
      }
    }

    if (!usage) {
      const abortReason = getAbortReason(controller.signal);
      await writeStreamMissingUsageDebug(
        requestId,
        upstreamResponse.status,
        streamMode,
        chunkCount,
        totalBytes,
        streamEventCount,
        collectedText,
      );
      logRequest(requestId, getMissingUsageLogMessage(abortReason), {
        chunkCount,
        totalBytes,
        streamMode,
        streamEventCount,
        abortReason: abortReason ?? null,
        wroteAnyEvent,
        wroteTextContent,
        textCharCount,
        ...getStreamObservationLogFields(
          {
            startedStreaming,
            wroteAnyEvent,
            wroteTextContent,
            textCharCount,
          },
          abortReason?.kind === 'timeout' ? { phase: abortReason.phase } : undefined,
        ),
      });
    }

    reader.releaseLock();
  }

  // Anti-false-positive: if usage reports outputTokens > 0, the stream almost
  // certainly produced real content even if our event-level text detection missed
  // it (e.g. provider uses non-standard event names).  Do not treat it as empty.
  const usageOutputTokens = usage && typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
  const effectiveWroteText = wroteTextContent || usageOutputTokens > 0;

  // If we detected content late (in the finally block via hasMeaningfulResponseOutput)
  // but the pending client events were never flushed, flush them now before ending.
  if (effectiveWroteText && pendingClientEvents.length > 0) {
    flushPendingClientEvents();
  }
  if (effectiveWroteText && !res.writableEnded && !res.destroyed) {
    ensureSseHeaders();
    res.end();
  }

  logRequest(requestId, 'stream passthrough finished', {
    chunkCount,
    totalBytes,
    usage,
    wroteTextContent,
    effectiveWroteText,
    usageOutputTokens,
    textCharCount,
  });
  return {
    kind: 'completed',
    chunkCount,
    totalBytes,
    usage,
    startedStreaming,
    wroteAnyEvent,
    wroteTextContent: effectiveWroteText,
    textCharCount,
    fallbackReason: !effectiveWroteText ? 'stream_no_text_content' : !usage ? 'stream_missing_usage' : undefined,
  };
}

const server = createServer((req, res) => {
  const _snap = runtimeStore.getSnapshot();
  _requestContext.run(_snap, async () => {
  const runtimeVersion = _snap.runtimeVersion;

  const {
    apiKey,
    clientErrorPatterns,
    compatFallbackPatterns,
    clearDeveloperContent,
    clearInstructions,
    clearSystemContent,
    convertSystemToDeveloper,
    debugSse,
    defaultModel,
    defaultPromptCacheKey,
    defaultPromptCacheRetention,
    defaultStreamMode,
    fallbackConfigPath,
    fallbackEndpoints,
    fallbackOnCompat4xx,
    fallbackOnRetryable4xx,
    firstByteTimeoutMs,
    firstTextTimeoutMs,
    forceStoreFalse,
    host,
    instanceName,
    maxCachedResponses,
    maxConcurrentRequests,
    logRequestBodies,
    maxFallbackAttempts,
    maxFallbackTotalMs,
    modelMappingPath,
    modelMappings,
    endpointAuthCooldownMs,
    endpointFailureThreshold,
    endpointHalfOpenMaxProbes,
    endpointInvalidResponseCooldownMs,
    endpointTimeoutCooldownMs,
    overrideInstructionsText,
    port,
    primaryEndpoint,
    primaryProviderName,
    responsesEndpoints,
    sseFailureDebugDir,
    sseFailureDebugEnabled,
    streamIdleTimeoutMs,
    streamMissingUsageDebugDir,
    streamMissingUsageDebugEnabled,
    nonStreamingRequestTimeoutMs,
    totalRequestTimeoutMs,
    upstreamModelsUrl,
    upstreamTimeoutMs,
    upstreamUrl,
  } = _snap.config;

  const requestId = createRequestId();
  const startedAt = Date.now();
  let countedAsActive = false;
  const upstreamController = new AbortController();
  const totalTimeout = setTimeout(() => {
    abortWithReason(upstreamController, { kind: 'timeout', phase: 'total' });
  }, totalRequestTimeoutMs);

  const handleRequestAborted = () => {
    abortWithReason(upstreamController, { kind: 'client_disconnect', source: 'request' });
  };
  const handleResponseClosed = () => {
    if (!res.writableEnded) {
      abortWithReason(upstreamController, { kind: 'client_disconnect', source: 'response' });
    }
  };

  req.on('aborted', handleRequestAborted);
  res.on('close', handleResponseClosed);

  const finish = (statusCode: number, note: string, extra?: Record<string, unknown>) => {
    recordStatus(statusCode);
    logRequest(requestId, note, {
      statusCode,
      durationMs: Date.now() - startedAt,
      activeRequests,
      runtimeVersion,
      ...extra,
    });
  };
  let selectedEndpoint = primaryEndpoint;

  try {
    if (!req.url) {
      sendJson(res, 404, makeError('Not found', 404).body);
      finish(404, 'missing url');
      return;
    }

    const _adminHandled = await _adminHandler(req, res);
    if (_adminHandled) {
      finish(200, 'admin config api handled');
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization',
      });
      res.end();
      finish(204, 'preflight handled');
      return;
    }

    if (req.method === 'GET' && req.url === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        instanceName,
        primaryProviderName,
        upstreamUrl,
        upstreamModelsUrl,
        fallbackConfigPath,
        modelMappingPath,
        port,
        host,
        activeRequests,
        maxConcurrentRequests,
        cachedResponses: responseCache.size,
        maxCachedResponses,
        upstreamTimeoutMs,
        nonStreamingRequestTimeoutMs,
        firstByteTimeoutMs,
        firstTextTimeoutMs,
        streamIdleTimeoutMs,
        totalRequestTimeoutMs,
        clearDeveloperContent,
        clearInstructions,
        clearSystemContent,
        defaultPromptCacheKey,
        defaultPromptCacheRetention,
        modelMappings,
        overrideInstructionsText,
        logRequestBodies,
        forceStoreFalse,
      });
      finish(200, 'health check');
      return;
    }



    if (req.method === 'GET' && req.url.startsWith('/v1/responses/')) {
      const responseId = req.url.slice('/v1/responses/'.length);
      const cachedResponse = responseCache.get(responseId);

      if (!cachedResponse) {
        proxyStats.cacheMisses += 1;
        sendJson(res, 404, makeError(`Response not found in local cache: ${responseId}`, 404).body);
        finish(404, 'cached response not found', { responseId });
        return;
      }

      proxyStats.cacheHits += 1;
      sendJson(res, 200, cachedResponse);
      finish(200, 'cached response returned', { responseId });
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      logRequest(requestId, 'forwarding models request');

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetchWithTimeout(upstreamModelsUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
        }, upstreamController);
      } catch (error) {
        const abortReason = getAbortReason(upstreamController.signal);
        if (error instanceof Error && error.name === 'AbortError' && abortReason?.kind === 'timeout') {
          sendJson(
            res,
            504,
            makeError(createTimeoutMessage(abortReason.phase), 504).body,
          );
          finish(504, 'models upstream timeout', { phase: abortReason.phase });
          return;
        }

        if (error instanceof Error && error.name === 'AbortError' && abortReason?.kind === 'client_disconnect') {
          finish(499, 'models request cancelled by client', { source: abortReason.source });
          return;
        }

        throw error;
      }

      let upstreamText: string;
      try {
        upstreamText = await readResponseText(upstreamResponse, upstreamController);
      } catch (error) {
        const abortReason = getAbortReason(upstreamController.signal);
        if (error instanceof Error && error.name === 'AbortError' && abortReason?.kind === 'timeout') {
          sendJson(res, 504, makeError(createTimeoutMessage(abortReason.phase), 504).body);
          finish(504, 'models response body timeout', { phase: abortReason.phase });
          return;
        }

        if (error instanceof Error && error.name === 'AbortError' && abortReason?.kind === 'client_disconnect') {
          finish(499, 'models response cancelled by client', { source: abortReason.source });
          return;
        }

        throw error;
      }

      let jsonPayload: unknown;
      try {
        jsonPayload = JSON.parse(upstreamText);
      } catch {
        sendJson(
          res,
          502,
          makeError('Upstream models endpoint returned invalid JSON', 502, upstreamText.slice(0, 2000)).body,
        );
        finish(502, 'invalid models json', { upstreamStatus: upstreamResponse.status });
        return;
      }

      if (!upstreamResponse.ok) {
        sendJson(res, upstreamResponse.status, normalizeErrorPayload(upstreamResponse.status, jsonPayload));
        finish(upstreamResponse.status, 'models upstream error');
        return;
      }

      const mappedModelsPayload = applyModelMappingsToModelsPayload(jsonPayload);
      sendJson(res, 200, mappedModelsPayload.payload as JsonValue);
      finish(200, 'models json returned', {
        upstreamStatus: upstreamResponse.status,
        aliasCount: mappedModelsPayload.aliasCount,
      });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      sendJson(
        res,
        404,
        makeError('Supported routes: GET /healthz, GET /admin/config, POST /admin/config/validate, PUT /admin/config, POST /admin/config/reload, POST /admin/config/rollback, GET /admin/stats, GET /v1/models, GET /v1/responses/:id, POST /admin/cache/clear, POST /v1/responses', 404).body,
      );
      finish(404, 'unsupported route', { method: req.method, url: req.url });
      return;
    }

    proxyStats.requestsTotal += 1;

    if (activeRequests >= maxConcurrentRequests) {
      proxyStats.overloadRejects += 1;
      sendJson(
        res,
        503,
        makeError('Proxy is busy, please retry shortly', 503, {
          activeRequests,
          maxConcurrentRequests,
        }).body,
      );
      finish(503, 'rejected due to concurrency limit');
      return;
    }

    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      sendJson(res, 415, makeError('Content-Type must be application/json', 415).body);
      finish(415, 'invalid content type', { contentType });
      return;
    }

    activeRequests += 1;
    countedAsActive = true;

    let requestBody: JsonRecord;
    try {
      requestBody = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, makeError('Invalid JSON request body', 400, String(error)).body);
      finish(400, 'invalid json body');
      return;
    }

    const streamResponse = wantsStreaming(req, requestBody);
    const streamMode = getStreamMode(req, requestBody);
    logRequestAccepted(requestId, req, streamResponse, streamMode);
    const responsesConnectTimeoutMs = getResponsesConnectTimeoutMs(streamResponse);
    const responsesFirstByteTimeoutMs = getResponsesFirstByteTimeoutMs(streamResponse);
    const upstreamBody = normalizeRequestBody(requestBody, streamResponse);
    logRequestBodiesPreview(requestId, requestBody, upstreamBody);
    logForwardingUpstream(
      requestId,
      requestBody,
      upstreamBody,
      streamResponse,
      streamMode,
      responsesConnectTimeoutMs,
      responsesFirstByteTimeoutMs,
    );

    let upstreamAttempt: UpstreamAttempt;
    const fallbackBudget: FallbackBudget = {
      startedAt: Date.now(),
      attemptsUsed: 0,
    };
    try {
      upstreamAttempt = await fetchResponsesUpstream(
        requestId,
        upstreamBody,
        upstreamController.signal,
        streamResponse,
        fallbackBudget,
      );
      selectedEndpoint = upstreamAttempt.endpoint;
    } catch (error) {
      const maybeAbortError = error as Error & { abortReason?: AbortReason };
      const maybeAbortObject = error as { abortReason?: AbortReason; error?: unknown };
      const errorEndpoint = getEndpointFromError(error);
      if (errorEndpoint) {
        selectedEndpoint = errorEndpoint;
      }
      const abortReason = maybeAbortError.abortReason ?? maybeAbortObject.abortReason ?? getAbortReason(upstreamController.signal);
      if (isAbortErrorLike(error, abortReason) && abortReason?.kind === 'timeout') {
        proxyStats.upstreamTimeouts += 1;
        if (streamResponse) {
          sendResponsesStreamError(res, createTimeoutMessage(abortReason.phase, {
            connect: responsesConnectTimeoutMs,
            firstByte: responsesFirstByteTimeoutMs,
            idle: streamIdleTimeoutMs,
            total: totalRequestTimeoutMs,
          }), {
            statusCode: 504,
            code: 'server_error',
            sequenceNumber: 1,
          });
        } else {
          sendJson(
            res,
            504,
            makeError(createTimeoutMessage(abortReason.phase, {
              connect: responsesConnectTimeoutMs,
              firstByte: responsesFirstByteTimeoutMs,
              idle: streamIdleTimeoutMs,
              total: totalRequestTimeoutMs,
            }), 504).body,
          );
        }
        finish(504, 'upstream timeout', { phase: abortReason.phase, upstreamName: selectedEndpoint.name });
        return;
      }

      if (isAbortErrorLike(error, abortReason) && abortReason?.kind === 'client_disconnect') {
        finish(499, 'request cancelled by client', { source: abortReason.source, upstreamName: selectedEndpoint.name });
        return;
      }

      throw error;
    }

    selectedEndpoint = upstreamAttempt.endpoint;

    let bufferedUpstreamText: string | undefined;

    if (streamResponse) {
      const endpoints = responsesEndpoints;
      let currentAttempt = upstreamAttempt;

      while (true) {
        const upstreamContentType = currentAttempt.response.headers.get('content-type') ?? '';

        if (currentAttempt.response.ok && upstreamContentType.includes('text/event-stream')) {
          logRequest(requestId, 'stream passthrough started', {
            upstreamName: currentAttempt.endpoint.name,
            upstreamStatus: currentAttempt.response.status,
            upstreamContentType,
            streamMode,
          });

          const streamOutcome = await pipeUpstreamSse(
            requestId,
            currentAttempt.response,
            res,
            requestBody,
            streamMode,
            currentAttempt.controller,
          );

          if (streamOutcome.kind === 'timeout') {
            proxyStats.upstreamTimeouts += 1;
            const canFallback = canAttemptFallbackAfterStreamOutcome(
              streamOutcome,
              upstreamController.signal,
              currentAttempt.endpointIndex,
              endpoints,
              fallbackBudget,
            );

            if (canFallback) {
              const fallbackReason = streamOutcome.fallbackReason ?? 'headers_only_timeout';
              fallbackBudget.attemptsUsed += 1;
              markEndpointFailure(currentAttempt.endpoint, fallbackReason, requestId, {
                phase: streamOutcome.phase,
                streamMode,
                ...getStreamObservationLogFields(streamOutcome, {
                  phase: streamOutcome.phase,
                  fallbackReason,
                }),
              });
              logRequest(requestId, getStreamTimeoutLogMessage(streamOutcome.phase, { fallingBack: true }), {
                phase: streamOutcome.phase,
                upstreamName: currentAttempt.endpoint.name,
                nextFallbackName: endpoints[currentAttempt.endpointIndex + 1]?.name ?? null,
                streamMode,
                fallbackReason,
                wroteAnyEvent: streamOutcome.wroteAnyEvent,
                wroteTextContent: streamOutcome.wroteTextContent,
                textCharCount: streamOutcome.textCharCount,
                ...getStreamObservationLogFields(streamOutcome, {
                  phase: streamOutcome.phase,
                  fallbackReason,
                }),
              });
              recordFallbackReason(fallbackReason, currentAttempt.endpoint.name);
              await closeResponseBody(currentAttempt.response);
              currentAttempt.dispose();
              try {
                currentAttempt = await fetchResponsesUpstream(
                  requestId,
                  upstreamBody,
                  upstreamController.signal,
                  streamResponse,
                  fallbackBudget,
                  currentAttempt.endpointIndex + 1,
                );
              } catch (error) {
                const maybeAbortError = error as Error & { abortReason?: AbortReason };
                const maybeAbortObject = error as { abortReason?: AbortReason; error?: unknown };
                const errorEndpoint = getEndpointFromError(error);
                if (errorEndpoint) {
                  selectedEndpoint = errorEndpoint;
                }
                const abortReason = maybeAbortError.abortReason ?? maybeAbortObject.abortReason ?? getAbortReason(upstreamController.signal);

                if (isAbortErrorLike(error, abortReason) && abortReason?.kind === 'timeout') {
                  proxyStats.upstreamTimeouts += 1;
                  sendResponsesStreamError(res, createTimeoutMessage(abortReason.phase), {
                    statusCode: 504,
                    code: 'server_error',
                    sequenceNumber: 1,
                  });
                  finish(504, 'stream fallback upstream timeout', {
                    phase: abortReason.phase,
                    upstreamName: selectedEndpoint.name,
                  });
                  return;
                }

                if (isAbortErrorLike(error, abortReason) && abortReason?.kind === 'client_disconnect') {
                  finish(499, 'stream fallback request cancelled by client', {
                    source: abortReason.source,
                    upstreamName: selectedEndpoint.name,
                  });
                  return;
                }

                throw error;
              }
              selectedEndpoint = currentAttempt.endpoint;
              continue;
            }

            if (!streamOutcome.startedStreaming) {
              sendResponsesStreamError(res, createTimeoutMessage(streamOutcome.phase), {
                statusCode: 504,
                code: 'server_error',
                sequenceNumber: streamOutcome.chunkCount + 1,
              });
            }

            currentAttempt.dispose();
            finish(504, getStreamTimeoutLogMessage(streamOutcome.phase), {
              phase: streamOutcome.phase,
              upstreamContentType,
              upstreamStatus: currentAttempt.response.status,
              chunkCount: streamOutcome.chunkCount,
              totalBytes: streamOutcome.totalBytes,
              streamMode,
              upstreamName: currentAttempt.endpoint.name,
              startedStreaming: streamOutcome.startedStreaming,
              wroteAnyEvent: streamOutcome.wroteAnyEvent,
              wroteTextContent: streamOutcome.wroteTextContent,
              textCharCount: streamOutcome.textCharCount,
              ...getStreamObservationLogFields(streamOutcome, {
                phase: streamOutcome.phase,
                fallbackReason: streamOutcome.fallbackReason,
              }),
            });
            return;
          }

          if (streamOutcome.kind === 'client_disconnect') {
            currentAttempt.dispose();
            finish(499, 'client disconnected during stream passthrough', {
              source: streamOutcome.source,
              upstreamContentType,
              upstreamStatus: currentAttempt.response.status,
              chunkCount: streamOutcome.chunkCount,
              totalBytes: streamOutcome.totalBytes,
              streamMode,
              upstreamName: currentAttempt.endpoint.name,
            });
            return;
          }

          currentAttempt.dispose();
          if (streamOutcome.fallbackReason && canAttemptFallbackAfterStreamOutcome(
            streamOutcome,
            upstreamController.signal,
            currentAttempt.endpointIndex,
            endpoints,
            fallbackBudget,
          )) {
            fallbackBudget.attemptsUsed += 1;
            recordFallbackReason(streamOutcome.fallbackReason, currentAttempt.endpoint.name);
            markEndpointFailure(currentAttempt.endpoint, streamOutcome.fallbackReason, requestId, {
              streamMode,
              usageFound: Boolean(streamOutcome.usage),
            });
            logRequest(requestId, 'stream completed without usable output, falling back', {
              fallbackReason: streamOutcome.fallbackReason,
              upstreamName: currentAttempt.endpoint.name,
              nextFallbackName: endpoints[currentAttempt.endpointIndex + 1]?.name ?? null,
              streamMode,
              wroteAnyEvent: streamOutcome.wroteAnyEvent,
              wroteTextContent: streamOutcome.wroteTextContent,
              textCharCount: streamOutcome.textCharCount,
              usageFound: Boolean(streamOutcome.usage),
              usageOutputTokens: streamOutcome.usage && typeof streamOutcome.usage.outputTokens === 'number' ? streamOutcome.usage.outputTokens : null,
              chunkCount: streamOutcome.chunkCount,
              totalBytes: streamOutcome.totalBytes,
            });
            try {
              currentAttempt = await fetchResponsesUpstream(
                requestId,
                upstreamBody,
                upstreamController.signal,
                streamResponse,
                fallbackBudget,
                currentAttempt.endpointIndex + 1,
              );
            } catch (error) {
              const maybeAbortError = error as Error & { abortReason?: AbortReason };
              const maybeAbortObject = error as { abortReason?: AbortReason; error?: unknown };
              const errorEndpoint = getEndpointFromError(error);
              if (errorEndpoint) {
                selectedEndpoint = errorEndpoint;
              }
              const abortReason = maybeAbortError.abortReason ?? maybeAbortObject.abortReason ?? getAbortReason(upstreamController.signal);

              if (isAbortErrorLike(error, abortReason) && abortReason?.kind === 'timeout') {
                proxyStats.upstreamTimeouts += 1;
                sendResponsesStreamError(res, createTimeoutMessage(abortReason.phase), {
                  statusCode: 504,
                  code: 'server_error',
                  sequenceNumber: 1,
                });
                finish(504, 'stream fallback upstream timeout after incomplete output', {
                  phase: abortReason.phase,
                  upstreamName: selectedEndpoint.name,
                });
                return;
              }

              if (isAbortErrorLike(error, abortReason) && abortReason?.kind === 'client_disconnect') {
                finish(499, 'stream fallback cancelled by client after incomplete output', {
                  source: abortReason.source,
                  upstreamName: selectedEndpoint.name,
                });
                return;
              }

              throw error;
            }
            selectedEndpoint = currentAttempt.endpoint;
            continue;
          }

          if (streamMode === 'normalized') {
            proxyStats.responsesSseNormalized += 1;
          } else {
            proxyStats.responsesSseRaw += 1;
          }
          markEndpointSuccess(currentAttempt.endpoint, requestId, { streamMode, path: 'stream_passthrough' });

          finish(200, 'stream passthrough returned', {
            upstreamContentType,
            upstreamStatus: currentAttempt.response.status,
            streamMode,
            upstreamName: currentAttempt.endpoint.name,
            usage: streamOutcome.usage,
          });
          return;
        }

        if (currentAttempt.response.ok && !upstreamContentType.includes('application/json')) {
          logRequest(requestId, 'probing non-standard stream response', {
            upstreamName: currentAttempt.endpoint.name,
            upstreamStatus: currentAttempt.response.status,
            upstreamContentType,
            streamMode,
          });

          const probeOutcome = await probeAndPipeResponsesTextStream(
            currentAttempt.response,
            res,
            requestBody,
            streamMode,
            currentAttempt.controller,
          );

          if (probeOutcome.kind === 'timeout') {
            proxyStats.upstreamTimeouts += 1;
            const canFallback = canAttemptFallbackAfterStreamOutcome(
              probeOutcome,
              upstreamController.signal,
              currentAttempt.endpointIndex,
              endpoints,
              fallbackBudget,
            );

            if (canFallback) {
              const fallbackReason = probeOutcome.fallbackReason ?? 'headers_only_timeout';
              fallbackBudget.attemptsUsed += 1;
              recordFallbackReason(fallbackReason, currentAttempt.endpoint.name);
              markEndpointFailure(currentAttempt.endpoint, fallbackReason, requestId, {
                phase: probeOutcome.phase,
                streamMode,
              });
              logRequest(requestId, 'non-standard stream probe timed out before meaningful output, falling back', {
                phase: probeOutcome.phase,
                upstreamContentType,
                upstreamStatus: currentAttempt.response.status,
                upstreamName: currentAttempt.endpoint.name,
                nextFallbackName: endpoints[currentAttempt.endpointIndex + 1]?.name ?? null,
                fallbackReason,
                wroteAnyEvent: probeOutcome.wroteAnyEvent,
                wroteTextContent: probeOutcome.wroteTextContent,
                textCharCount: probeOutcome.textCharCount,
              });
              await closeResponseBody(currentAttempt.response);
              currentAttempt.dispose();
              currentAttempt = await fetchResponsesUpstream(
                requestId,
                upstreamBody,
                upstreamController.signal,
                streamResponse,
                fallbackBudget,
                currentAttempt.endpointIndex + 1,
              );
              selectedEndpoint = currentAttempt.endpoint;
              continue;
            }

            currentAttempt.dispose();
            finish(504, 'non-standard stream probe timed out', {
              phase: probeOutcome.phase,
              upstreamContentType,
              upstreamStatus: currentAttempt.response.status,
              chunkCount: probeOutcome.chunkCount,
              totalBytes: probeOutcome.totalBytes,
              streamMode,
              upstreamName: currentAttempt.endpoint.name,
              startedStreaming: probeOutcome.startedStreaming,
              wroteAnyEvent: probeOutcome.wroteAnyEvent,
              wroteTextContent: probeOutcome.wroteTextContent,
              textCharCount: probeOutcome.textCharCount,
            });
            return;
          }

          if (probeOutcome.kind === 'client_disconnect') {
            currentAttempt.dispose();
            finish(499, 'client disconnected during non-standard stream probe', {
              source: probeOutcome.source,
              upstreamContentType,
              upstreamStatus: currentAttempt.response.status,
              chunkCount: probeOutcome.chunkCount,
              totalBytes: probeOutcome.totalBytes,
              streamMode,
              upstreamName: currentAttempt.endpoint.name,
            });
            return;
          }

          if (probeOutcome.kind === 'completed') {
            if (
              probeOutcome.fallbackReason &&
              canAttemptFallbackAfterStreamOutcome(
                probeOutcome,
                upstreamController.signal,
                currentAttempt.endpointIndex,
                endpoints,
                fallbackBudget,
              )
            ) {
              fallbackBudget.attemptsUsed += 1;
              recordFallbackReason(probeOutcome.fallbackReason, currentAttempt.endpoint.name);
              markEndpointFailure(currentAttempt.endpoint, probeOutcome.fallbackReason, requestId, {
                streamMode,
              });
              logRequest(requestId, 'non-standard stream completed without usable output, falling back', {
                fallbackReason: probeOutcome.fallbackReason,
                upstreamContentType,
                upstreamStatus: currentAttempt.response.status,
                upstreamName: currentAttempt.endpoint.name,
                nextFallbackName: endpoints[currentAttempt.endpointIndex + 1]?.name ?? null,
                wroteAnyEvent: probeOutcome.wroteAnyEvent,
                wroteTextContent: probeOutcome.wroteTextContent,
                textCharCount: probeOutcome.textCharCount,
              });
              await closeResponseBody(currentAttempt.response);
              currentAttempt.dispose();
              currentAttempt = await fetchResponsesUpstream(
                requestId,
                upstreamBody,
                upstreamController.signal,
                streamResponse,
                fallbackBudget,
                currentAttempt.endpointIndex + 1,
              );
              selectedEndpoint = currentAttempt.endpoint;
              continue;
            }

            currentAttempt.dispose();
            if (streamMode === 'normalized') {
              proxyStats.responsesSseNormalized += 1;
            } else {
              proxyStats.responsesSseRaw += 1;
            }
            markEndpointSuccess(currentAttempt.endpoint, requestId, { streamMode, path: 'stream_probe' });

            finish(200, 'non-standard stream normalized to sse', {
              upstreamContentType,
              upstreamStatus: currentAttempt.response.status,
              streamMode,
              upstreamName: currentAttempt.endpoint.name,
              usage: probeOutcome.usage,
              wroteAnyEvent: probeOutcome.wroteAnyEvent,
              wroteTextContent: probeOutcome.wroteTextContent,
              textCharCount: probeOutcome.textCharCount,
            });
            return;
          }

          bufferedUpstreamText = probeOutcome.text;
          upstreamAttempt = currentAttempt;
          break;
        }

        upstreamAttempt = currentAttempt;
        break;
      }

      if (typeof bufferedUpstreamText === 'string') {
        const upstreamResponse = upstreamAttempt.response;
        const upstreamContentType = upstreamResponse.headers.get('content-type') ?? '';

        const sseEvents = parseSse(bufferedUpstreamText);

        if (isResponsesStyleEventStream(sseEvents)) {
          logSseDebug(requestId, sseEvents);
          const bufferedUsage = writeBufferedResponsesSse(
            res,
            upstreamResponse.status,
            sseEvents,
            requestBody,
            streamMode,
          );

          if (!upstreamResponse.ok) {
            if (streamMode === 'normalized') {
              proxyStats.responsesSseNormalized += 1;
            } else {
              proxyStats.responsesSseRaw += 1;
            }

            finish(upstreamResponse.status, 'buffered upstream stream error returned as sse', {
              upstreamContentType,
              upstreamName: selectedEndpoint.name,
              eventCount: sseEvents.length,
              streamMode,
            });
            upstreamAttempt.dispose();
            return;
          }

          const responseObject = synthesizeResponseFromEvents(sseEvents);
          const normalizedResponse = responseObject ? normalizeResponseObject(responseObject, requestBody) : undefined;
          const hasTextOutput = hasMeaningfulResponseOutput(normalizedResponse);
          const fallbackReason = !normalizedResponse
            ? 'sse_reconstruction_failure'
            : !hasTextOutput
            ? 'stream_no_text_content'
            : !bufferedUsage
            ? 'stream_missing_usage'
            : undefined;

          if (normalizedResponse) {
            cacheResponse(normalizedResponse);
            addUsageToStats(extractUsageMetrics(normalizedResponse) ?? bufferedUsage);
          } else {
            addUsageToStats(bufferedUsage);
          }

          if (streamMode === 'normalized') {
            proxyStats.responsesSseNormalized += 1;
          } else {
            proxyStats.responsesSseRaw += 1;
          }
          markEndpointSuccess(upstreamAttempt.endpoint, requestId, { streamMode, path: 'buffered_stream' });

          finish(200, 'buffered upstream stream returned as sse', {
            upstreamContentType,
            upstreamStatus: upstreamResponse.status,
            eventCount: sseEvents.length,
            upstreamName: selectedEndpoint.name,
            streamMode,
            usage: bufferedUsage,
            fallbackReason,
            hasTextOutput,
          });
          upstreamAttempt.dispose();
          return;
        }
      }
    }

    while (true) {
      const upstreamResponse = upstreamAttempt.response;
      const upstreamContentType = upstreamResponse.headers.get('content-type') ?? '';

      let upstreamText: string;
      if (typeof bufferedUpstreamText === 'string') {
        upstreamText = bufferedUpstreamText;
        bufferedUpstreamText = undefined;
      } else {
        try {
          upstreamText = await readResponseText(
            upstreamResponse,
            upstreamAttempt.controller,
            responsesFirstByteTimeoutMs,
          );
        } catch (error) {
          const abortReason = getAbortReason(upstreamAttempt.controller.signal) ?? getAbortReason(upstreamController.signal);
          if (error instanceof Error && error.name === 'AbortError' && abortReason?.kind === 'timeout') {
            proxyStats.upstreamTimeouts += 1;
            upstreamAttempt.dispose();

            if (canAttemptFallback(upstreamController.signal, upstreamAttempt.endpointIndex, responsesEndpoints, fallbackBudget)) {
              fallbackBudget.attemptsUsed += 1;
              recordFallbackReason('headers_only_timeout', selectedEndpoint.name);
              markEndpointFailure(upstreamAttempt.endpoint, 'body_timeout', requestId, {
                phase: abortReason.phase,
                upstreamContentType,
              });
              logRequest(requestId, 'upstream body timeout, falling back', {
                phase: abortReason.phase,
                upstreamName: selectedEndpoint.name,
                upstreamContentType,
                nextFallbackName: responsesEndpoints[upstreamAttempt.endpointIndex + 1]?.name ?? null,
              });
              upstreamAttempt = await fetchResponsesUpstream(
                requestId,
                upstreamBody,
                upstreamController.signal,
                streamResponse,
                fallbackBudget,
                upstreamAttempt.endpointIndex + 1,
              );
              selectedEndpoint = upstreamAttempt.endpoint;
              continue;
            }

            sendJson(
              res,
              504,
              makeError(createTimeoutMessage(abortReason.phase, {
                connect: responsesConnectTimeoutMs,
                firstByte: responsesFirstByteTimeoutMs,
                idle: streamIdleTimeoutMs,
                total: totalRequestTimeoutMs,
              }), 504).body,
            );
            finish(504, 'upstream body timeout', { phase: abortReason.phase, upstreamContentType, upstreamName: selectedEndpoint.name });
            return;
          }

          if (error instanceof Error && error.name === 'AbortError' && abortReason?.kind === 'client_disconnect') {
            finish(499, 'client disconnected while reading upstream body', {
              source: abortReason.source,
              upstreamContentType,
              upstreamName: selectedEndpoint.name,
            });
            upstreamAttempt.dispose();
            return;
          }

          upstreamAttempt.dispose();

          if (canAttemptFallback(upstreamController.signal, upstreamAttempt.endpointIndex, responsesEndpoints, fallbackBudget)) {
            fallbackBudget.attemptsUsed += 1;
            recordFallbackReason('unknown_upstream_error', selectedEndpoint.name);
            markEndpointFailure(upstreamAttempt.endpoint, 'unknown_upstream_error', requestId, {
              upstreamContentType,
            });
            logRequest(requestId, 'unhandled upstream body read error, falling back', {
              upstreamName: selectedEndpoint.name,
              upstreamContentType,
              nextFallbackName: responsesEndpoints[upstreamAttempt.endpointIndex + 1]?.name ?? null,
              error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
            });
            upstreamAttempt = await fetchResponsesUpstream(
              requestId,
              upstreamBody,
              upstreamController.signal,
              streamResponse,
              fallbackBudget,
              upstreamAttempt.endpointIndex + 1,
            );
            selectedEndpoint = upstreamAttempt.endpoint;
            continue;
          }

          throw error;
        }
      }

      if (upstreamContentType.includes('application/json')) {
        let jsonPayload: unknown;

        try {
          jsonPayload = JSON.parse(upstreamText);
        } catch {
          if (canAttemptFallback(upstreamController.signal, upstreamAttempt.endpointIndex, responsesEndpoints, fallbackBudget)) {
            fallbackBudget.attemptsUsed += 1;
            recordFallbackReason('unknown_upstream_error', selectedEndpoint.name);
            markEndpointFailure(upstreamAttempt.endpoint, 'unknown_upstream_error', requestId, {
              upstreamStatus: upstreamResponse.status,
            });
            logRequest(requestId, 'upstream invalid json, falling back', {
              upstreamStatus: upstreamResponse.status,
              upstreamName: selectedEndpoint.name,
              nextFallbackName: responsesEndpoints[upstreamAttempt.endpointIndex + 1]?.name ?? null,
            });
            upstreamAttempt.dispose();
            upstreamAttempt = await fetchResponsesUpstream(
              requestId,
              upstreamBody,
              upstreamController.signal,
              streamResponse,
              fallbackBudget,
              upstreamAttempt.endpointIndex + 1,
            );
            selectedEndpoint = upstreamAttempt.endpoint;
            continue;
          }

          sendJson(
            res,
            502,
            makeError('Upstream returned invalid JSON', 502, upstreamText.slice(0, 2000)).body,
          );
          finish(502, 'upstream invalid json', { upstreamStatus: upstreamResponse.status, upstreamName: selectedEndpoint.name });
          upstreamAttempt.dispose();
          return;
        }

        if (!upstreamResponse.ok) {
          sendJson(res, upstreamResponse.status, normalizeErrorPayload(upstreamResponse.status, jsonPayload));
          finish(upstreamResponse.status, 'upstream json error', {
            upstreamName: selectedEndpoint.name,
            upstreamStatus: upstreamResponse.status,
            upstreamErrorPreview:
              upstreamResponse.status >= 500
                ? JSON.stringify(normalizeErrorPayload(upstreamResponse.status, jsonPayload)).slice(0, 2000)
                : undefined,
          });
          upstreamAttempt.dispose();
          return;
        }

        const responseObject = coerceResponseObject(jsonPayload);
        if (!responseObject) {
          if (canAttemptFallback(upstreamController.signal, upstreamAttempt.endpointIndex, responsesEndpoints, fallbackBudget)) {
            fallbackBudget.attemptsUsed += 1;
            recordFallbackReason('empty_response', selectedEndpoint.name);
            markEndpointFailure(upstreamAttempt.endpoint, 'empty_response', requestId, {
              upstreamStatus: upstreamResponse.status,
            });
            logRequest(requestId, 'upstream json missing response object, falling back', {
              upstreamName: selectedEndpoint.name,
              upstreamStatus: upstreamResponse.status,
              nextFallbackName: responsesEndpoints[upstreamAttempt.endpointIndex + 1]?.name ?? null,
            });
            upstreamAttempt.dispose();
            upstreamAttempt = await fetchResponsesUpstream(
              requestId,
              upstreamBody,
              upstreamController.signal,
              streamResponse,
              fallbackBudget,
              upstreamAttempt.endpointIndex + 1,
            );
            selectedEndpoint = upstreamAttempt.endpoint;
            continue;
          }

          sendJson(
            res,
            502,
            makeError('Upstream JSON did not contain a valid response object', 502, jsonPayload as JsonValue).body,
          );
          finish(502, 'upstream json missing response object', { upstreamName: selectedEndpoint.name });
          upstreamAttempt.dispose();
          return;
        }

        const normalizedResponse = normalizeResponseObject(responseObject, requestBody);
        const usage = extractUsageMetrics(normalizedResponse);
        const hasTextOutput = hasMeaningfulResponseOutput(normalizedResponse);

        if ((!hasTextOutput || !usage) && canAttemptFallback(upstreamController.signal, upstreamAttempt.endpointIndex, responsesEndpoints, fallbackBudget)) {
          const fallbackReason = !hasTextOutput ? 'empty_response' : 'stream_missing_usage';
          fallbackBudget.attemptsUsed += 1;
          recordFallbackReason(fallbackReason, selectedEndpoint.name);
          markEndpointFailure(upstreamAttempt.endpoint, fallbackReason, requestId, {
            upstreamStatus: upstreamResponse.status,
            usageFound: Boolean(usage),
            hasTextOutput,
          });
          logRequest(requestId, 'upstream json response incomplete, falling back', {
            fallbackReason,
            upstreamContentType,
            upstreamStatus: upstreamResponse.status,
            upstreamName: selectedEndpoint.name,
            usageFound: Boolean(usage),
            hasTextOutput,
            nextFallbackName: responsesEndpoints[upstreamAttempt.endpointIndex + 1]?.name ?? null,
          });
          upstreamAttempt.dispose();
          upstreamAttempt = await fetchResponsesUpstream(
            requestId,
            upstreamBody,
            upstreamController.signal,
            streamResponse,
            fallbackBudget,
            upstreamAttempt.endpointIndex + 1,
          );
          selectedEndpoint = upstreamAttempt.endpoint;
          continue;
        }

        cacheResponse(normalizedResponse);
        addUsageToStats(usage);
        proxyStats.responsesJson += 1;
        markEndpointSuccess(upstreamAttempt.endpoint, requestId, { path: 'json_response' });
        sendJson(res, 200, normalizedResponse);
        finish(200, 'json response returned', {
          upstreamContentType,
          upstreamStatus: upstreamResponse.status,
          upstreamName: selectedEndpoint.name,
          usage,
        });
        upstreamAttempt.dispose();
        return;
      }

      const sseEvents = parseSse(upstreamText);
      logSseDebug(requestId, sseEvents);
      const responseObject = synthesizeResponseFromEvents(sseEvents);

      if (!upstreamResponse.ok) {
        sendJson(
          res,
          upstreamResponse.status,
          normalizeErrorPayload(upstreamResponse.status, responseObject ?? upstreamText),
        );
        finish(upstreamResponse.status, 'upstream sse error', { upstreamContentType, upstreamName: selectedEndpoint.name });
        upstreamAttempt.dispose();
        return;
      }

      if (!responseObject) {
        if (canAttemptFallback(upstreamController.signal, upstreamAttempt.endpointIndex, responsesEndpoints, fallbackBudget)) {
          fallbackBudget.attemptsUsed += 1;
          recordFallbackReason('sse_reconstruction_failure', selectedEndpoint.name);
          markEndpointFailure(upstreamAttempt.endpoint, 'sse_reconstruction_failure', requestId, {
            upstreamStatus: upstreamResponse.status,
          });
          logRequest(requestId, 'failed to normalize sse payload, falling back', {
            upstreamContentType,
            upstreamStatus: upstreamResponse.status,
            upstreamName: selectedEndpoint.name,
            nextFallbackName: responsesEndpoints[upstreamAttempt.endpointIndex + 1]?.name ?? null,
          });
          upstreamAttempt.dispose();
          upstreamAttempt = await fetchResponsesUpstream(
            requestId,
            upstreamBody,
            upstreamController.signal,
            streamResponse,
            fallbackBudget,
            upstreamAttempt.endpointIndex + 1,
          );
          selectedEndpoint = upstreamAttempt.endpoint;
          continue;
        }

        await writeSseFailureDebug(requestId, upstreamContentType, upstreamResponse.status, upstreamText);
        sendJson(
          res,
          502,
          makeError('Unable to convert upstream SSE payload into a response JSON object', 502, {
            contentType: upstreamContentType,
            preview: upstreamText.slice(0, 2000),
          }).body,
        );
        finish(502, 'failed to normalize sse payload', { upstreamContentType, upstreamName: selectedEndpoint.name });
        upstreamAttempt.dispose();
        return;
      }

      const normalizedResponse = normalizeResponseObject(responseObject, requestBody);
      const usage = extractUsageMetrics(normalizedResponse);
      const hasTextOutput = hasMeaningfulResponseOutput(normalizedResponse);

      if ((!hasTextOutput || !usage) && canAttemptFallback(upstreamController.signal, upstreamAttempt.endpointIndex, responsesEndpoints, fallbackBudget)) {
        const fallbackReason = !hasTextOutput ? 'empty_response' : 'stream_missing_usage';
        fallbackBudget.attemptsUsed += 1;
        recordFallbackReason(fallbackReason, selectedEndpoint.name);
        markEndpointFailure(upstreamAttempt.endpoint, fallbackReason, requestId, {
          upstreamStatus: upstreamResponse.status,
          eventCount: sseEvents.length,
          usageFound: Boolean(usage),
          hasTextOutput,
        });
        logRequest(requestId, 'sse normalized json incomplete, falling back', {
          fallbackReason,
          upstreamContentType,
          upstreamStatus: upstreamResponse.status,
          eventCount: sseEvents.length,
          upstreamName: selectedEndpoint.name,
          usageFound: Boolean(usage),
          hasTextOutput,
          nextFallbackName: responsesEndpoints[upstreamAttempt.endpointIndex + 1]?.name ?? null,
        });
        upstreamAttempt.dispose();
        upstreamAttempt = await fetchResponsesUpstream(
          requestId,
          upstreamBody,
          upstreamController.signal,
          streamResponse,
          fallbackBudget,
          upstreamAttempt.endpointIndex + 1,
        );
        selectedEndpoint = upstreamAttempt.endpoint;
        continue;
      }

      cacheResponse(normalizedResponse);
      addUsageToStats(usage);
      proxyStats.responsesJson += 1;
      markEndpointSuccess(upstreamAttempt.endpoint, requestId, { path: 'sse_to_json' });
      sendJson(res, 200, normalizedResponse);
      finish(200, 'sse normalized to json', {
        upstreamContentType,
        upstreamStatus: upstreamResponse.status,
        eventCount: sseEvents.length,
        upstreamName: selectedEndpoint.name,
        usage,
      });
      upstreamAttempt.dispose();
      return;
    }
  } catch (error) {
    if (selectedEndpoint) {
      markEndpointFailure(selectedEndpoint, 'proxy_unhandled_error', requestId);
    }
    const errorDetails = error instanceof Error ? { name: error.name, message: error.message } : String(error);

    if (res.headersSent || res.writableEnded || res.destroyed) {
      logRequest(requestId, 'unhandled proxy error after response commit', {
        error: errorDetails,
        headersSent: res.headersSent,
        writableEnded: res.writableEnded,
        destroyed: res.destroyed,
      });

      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          // Best-effort only after a partially committed response.
        }
      }
      return;
    }

    const message = error instanceof Error ? error.message : 'Unknown proxy error';
    sendJson(res, 500, makeError(message, 500).body);
    finish(500, 'unhandled proxy error', {
      error: errorDetails,
    });
  } finally {
    clearTimeout(totalTimeout);
    req.off('aborted', handleRequestAborted);
    res.off('close', handleResponseClosed);

    if (countedAsActive && activeRequests > 0) {
      activeRequests -= 1;
    }
  }
  });
});



server.listen(_initialSnapshot.config.port, _initialSnapshot.config.host, () => {
  const c = _initialSnapshot.config;
  console.log(`Instance: ${c.instanceName}`);
  console.log(`JSON proxy listening on http://${c.host}:${c.port}`);
  console.log(`Primary provider: ${c.primaryProviderName}`);
  console.log(`Forwarding POST /v1/responses to ${c.upstreamUrl}`);
  console.log(`Fallback config path: ${c.fallbackConfigPath}`);
  console.log(`Model mapping path: ${c.modelMappingPath}`);
  console.log(
    `Model aliases: ${Object.keys(c.modelMappings).length === 0 ? 'none' : Object.entries(c.modelMappings).map(([alias, target]) => `${alias} -> ${target}`).join(', ')}`,
  );
  console.log(`Concurrency limit: ${c.maxConcurrentRequests}, upstream timeout: ${c.upstreamTimeoutMs}ms`);
  console.log(`Non-stream upstream timeout: ${c.nonStreamingRequestTimeoutMs}ms`);
  console.log(`First-byte timeout: ${c.firstByteTimeoutMs}ms, stream idle timeout: ${c.streamIdleTimeoutMs}ms`);
  console.log(`First-text timeout: ${c.firstTextTimeoutMs <= 0 ? 'disabled' : `${c.firstTextTimeoutMs}ms`}`);
  console.log(`Total request lifetime timeout: ${c.totalRequestTimeoutMs}ms`);
  console.log(`Cached responses limit: ${c.maxCachedResponses}`);
  console.log(`Default stream mode: ${c.defaultStreamMode}`);
  console.log(
    `Default prompt cache retention: ${c.defaultPromptCacheRetention === null ? 'disabled' : c.defaultPromptCacheRetention}`,
  );
  console.log(`Default prompt cache key: ${c.defaultPromptCacheKey === null ? 'disabled' : JSON.stringify(c.defaultPromptCacheKey)}`);
  console.log(`Clear developer content: ${c.clearDeveloperContent ? 'enabled' : 'disabled'}`);
  console.log(`Clear instructions: ${c.clearInstructions ? 'enabled' : 'disabled'}`);
  console.log(`Override instructions text: ${c.overrideInstructionsText === null ? 'disabled' : JSON.stringify(c.overrideInstructionsText)}`);
  console.log(`Clear system content: ${c.clearSystemContent ? 'enabled' : 'disabled'}`);
  console.log(`Convert system to developer: ${c.convertSystemToDeveloper ? 'enabled' : 'disabled'}`);
  console.log(`Request body logging: ${c.logRequestBodies ? 'enabled' : 'disabled'}`);
  console.log(`Force store=false: ${c.forceStoreFalse ? 'enabled' : 'disabled'}`);
  console.log(`SSE debug logging: ${c.debugSse ? 'enabled' : 'disabled'}`);
  console.log(`Retryable 4xx fallback: ${c.fallbackOnRetryable4xx ? 'enabled' : 'disabled'}`);
  console.log(`Compatibility 4xx fallback: ${c.fallbackOnCompat4xx ? 'enabled' : 'disabled'}`);
  console.log(`Endpoint timeout cooldown: ${c.endpointTimeoutCooldownMs}ms`);
  console.log(`Endpoint invalid-response cooldown: ${c.endpointInvalidResponseCooldownMs}ms`);
  console.log(`Endpoint auth cooldown: ${c.endpointAuthCooldownMs}ms`);
  console.log(`Endpoint failure threshold: ${c.endpointFailureThreshold}`);
  console.log(`Endpoint half-open max probes: ${c.endpointHalfOpenMaxProbes}`);
  console.log(`Fallback attempt budget: ${c.maxFallbackAttempts}`);
  console.log(`Fallback total budget: ${c.maxFallbackTotalMs}ms`);
  console.log(
    `SSE failure capture: ${c.sseFailureDebugEnabled ? `enabled -> ${c.sseFailureDebugDir}` : 'disabled'}`,
  );
  console.log(
    `Stream missing usage capture: ${c.streamMissingUsageDebugEnabled ? `enabled -> ${c.streamMissingUsageDebugDir}` : 'disabled'}`,
  );
  console.log(
    `Fallback upstreams: ${c.fallbackEndpoints.length === 0 ? 'none' : c.fallbackEndpoints.map(item => item.name).join(', ')}`,
  );
});
