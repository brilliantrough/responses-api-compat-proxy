import 'dotenv/config';
import { bootstrapHttpProxySupport } from './http-proxy-bootstrap.js';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createUsageStore } from './usage-store.js';
import { beginUsageAttempt, usageContext } from './usage-tracking.js';
import { cacheKeyHistoryStats, trackCacheKey } from './cache-key-history.js';
import { startUptimeSampling } from './uptime.js';

import {
  isJsonRecord,
  normalizeInput,
  sanitizeClaudeBillingHeaderMessageContent,
  sanitizeClaudeBillingHeaderText,
  type JsonRecord,
  type JsonValue,
} from './responses-input-normalization.js';
import { type StreamMode, type ProxyRuntimeConfig } from './proxy-config.js';
import {
  classifyProxyTerminalError,
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
  isCommentOnlySseChunk,
  isKeepAliveStreamPayload,
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
import { createRuntimeConfigStore, type RuntimeSnapshot } from './runtime-config.js';
import { classifyHealthDecision, createHealthRegistry, isQuotaExhaustedEvidence, type FailureEvidence, type HealthLease, type HealthRegistry } from './channel-health.js';
import { buildConfiguredModelsResponse, resolveModelRoute, type ResolvedModelRoute } from './model-router.js';
import {
  isModelChannelsUnavailable,
  reportChannelFailure,
  reportChannelSuccess,
  selectNextChannel,
  createChannelAttempts,
  hasAvailableChannel,
  nextAvailableChannel,
  type ChannelAttempts,
  routingAttemptStats,
} from './upstream-router.js';
import {
  compactV2HealthKey,
  listConfiguredModels,
  type ChannelConfig,
} from './routing-config.js';
import { createCompactDetectionService } from './compact-support.js';
import { createCompactProxy } from './compact-proxy.js';

bootstrapHttpProxySupport();

const _envPath = process.env.PROXY_ENV_PATH ?? resolve('.env');
const runtimeStore = createRuntimeConfigStore({
  envPath: _envPath,
  routingConfigPath: resolve(process.env.FALLBACK_CONFIG_PATH ?? 'fallback.json'),
});

const _initialSnapshot = runtimeStore.getSnapshot();
const _usageStore = createUsageStore(resolve(dirname(process.env.PROXY_ENV_PATH ? resolve(_envPath) : _initialSnapshot.config.routingConfigPath), 'usage.sqlite'));
const _compactDetection = createCompactDetectionService();
const healthRegistry: HealthRegistry = createHealthRegistry(_initialSnapshot.config);
runtimeStore.registerHealthRegistry?.(healthRegistry);
const stopUptimeSampling = startUptimeSampling(runtimeStore, healthRegistry, _usageStore);

const _adminConfigStore = createConfigFileStoreFromPaths({
  envPath: _envPath,
  fallbackPath: _initialSnapshot.config.routingConfigPath,
  modelMapPath: _initialSnapshot.config.routingConfigPath,
});
const _adminHandler = createAdminHandler({
  configStore: _adminConfigStore,
  runtimeStore,
  getAdminStats: () => getAdminStats(),
  clearResponseCache: () => clearResponseCache(),
  responseCacheSize: () => responseCache.size,
  compactDetection: _compactDetection,
  usageStore: _usageStore,
  healthRegistry,
});

const _requestContext = new AsyncLocalStorage<RuntimeSnapshot>();
const upstreamFailures = new WeakMap<AbortController, FailureEvidence>();

function observeUpstreamFailure(controller: AbortController, payload: unknown, status: number): boolean {
  if (!isJsonRecord(payload)) return false;
  const response = isJsonRecord(payload.response) ? payload.response : payload;
  if (response.error || response.status === 'failed' || response.status === 'incomplete' ||
      payload.type === 'error' || payload.type === 'response.failed' || payload.type === 'response.incomplete') {
    const evidence = { payload, status, upstreamResponseObserved: true };
    const previous = upstreamFailures.get(controller);
    if (!previous || classifyHealthDecision(previous).reason !== 'quota_exhausted') {
      upstreamFailures.set(controller, evidence);
    }
    return true;
  }
  return false;
}

function getConfig(): ProxyRuntimeConfig {
  const snap = _requestContext.getStore();
  return snap ? snap.config : _initialSnapshot.config;
}

function assertNeverCompactResult(value: never): never {
  throw new Error(`unexpected compact proxy result: ${String(value)}`);
}

const _compactProxy = createCompactProxy({
  getConfig,
  healthRegistry,
  fetchWithTimeout,
  createLinkedAbortController,
  closeResponseBody,
});

function triggerCompactDetection(force = false): void {
  const config = runtimeStore.getSnapshot().config;
  const compactRoute = config.routingConfig.compactRoute;
  _compactDetection.setModel(compactRoute?.canonicalModel ?? null);
  if (compactRoute === undefined || !config.compactDetectEnabled) {
    return;
  }

  void _compactDetection.detectAll(
    Array.from(config.routingConfig.channelsById.values()),
    compactRoute.canonicalModel,
    { force, timeoutMs: config.compactDetectTimeoutMs },
  ).catch(error => {
    console.warn(`compact detection failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

type UpstreamAttempt = {
  channel: ChannelConfig;
  channelIndex: number;
  lease: HealthLease;
  response: Response;
  controller: AbortController;
  dispose: () => void;
  reportSuccess: () => void;
  reportFailure: (evidence: FailureEvidence) => void;
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
    }
  | {
      kind: 'error';
      chunkCount: number;
      totalBytes: number;
      startedStreaming: boolean;
      wroteAnyEvent: boolean;
      wroteTextContent: boolean;
      textCharCount: number;
      error: unknown;
      fallbackReason?: FallbackReason;
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
    }
  | {
      kind: 'error';
      chunkCount: number;
      totalBytes: number;
      startedStreaming: boolean;
      wroteAnyEvent: boolean;
      wroteTextContent: boolean;
      textCharCount: number;
      error: unknown;
      fallbackReason?: FallbackReason;
    };

type FallbackBudget = ChannelAttempts & {
  startedAt: number;
  attemptsUsed: number;
  route: ResolvedModelRoute;
  betaFeaturesHeader?: string;
  rememberChannel?: ReturnType<typeof trackCacheKey>;
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
const proxyStats = {
  requestsTotal: 0,
  compactRequestsTotal: 0,
  compactFallbacks: 0,
  compactV2RequestsTotal: 0,
  compactV2Fallbacks: 0,
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

function canFallbackWithinBudget(
  requestSignal: AbortSignal,
  route: ResolvedModelRoute,
  budget: FallbackBudget,
  _legacyStartIndex?: number,
) {
  if (requestSignal.aborted) {
    return false;
  }

  if (getConfig().maxFallbackTotalMs > 0 && Date.now() - budget.startedAt >= getConfig().maxFallbackTotalMs) {
    return false;
  }

  return hasAvailableChannel(route, getConfig().routingConfig, healthRegistry, budget);
}

class ModelChannelsUnavailableError extends Error {
  readonly name = 'ModelChannelsUnavailableError';

  constructor(readonly retryAfterMs: number) {
    super('model_channels_unavailable');
  }
}

function attachChannelToError(error: unknown, channel: ChannelConfig, abortReason?: AbortReason) {
  if (error instanceof Error) {
    const enrichedError = error as Error & { abortReason?: AbortReason; channel?: ChannelConfig };
    if (abortReason) {
      enrichedError.abortReason = abortReason;
    }
    enrichedError.channel = channel;
    return enrichedError;
  }

  return {
    error,
    abortReason,
    channel,
  };
}

function getChannelFromError(error: unknown) {
  if (typeof error !== 'object' || error === null || !('channel' in error)) {
    return undefined;
  }

  const channel = (error as { channel?: unknown }).channel;
  if (
    typeof channel === 'object' &&
    channel !== null &&
    'name' in channel &&
    'responsesUrl' in channel &&
    'apiKey' in channel &&
    typeof channel.name === 'string' &&
    typeof channel.responsesUrl === 'string' &&
    typeof channel.apiKey === 'string'
  ) {
    return channel as ChannelConfig;
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

function sanitizeRequestBodyForLog(body: JsonRecord): JsonRecord {
  const sanitized: JsonRecord = { ...body };
  const mode = getConfig().claudeBillingHeaderMode;

  if (typeof sanitized.instructions === 'string') {
    sanitized.instructions = sanitizeClaudeBillingHeaderText(sanitized.instructions, mode);
  }

  if (Array.isArray(sanitized.input)) {
    sanitized.input = sanitized.input.map(item => {
      if (!isJsonRecord(item) || typeof item.role !== 'string' || item.content === undefined) {
        return item;
      }

      return {
        ...item,
        content: sanitizeClaudeBillingHeaderMessageContent(item.role, item.content, mode),
      };
    });
  }

  return sanitized;
}

function logRequestBodiesPreview(requestId: string, requestBody: JsonRecord, upstreamBody: JsonRecord) {
  if (!getConfig().logRequestBodies) {
    return;
  }

  logRequest(requestId, 'request body preview', {
    requestBody: sanitizeForLog(sanitizeRequestBodyForLog(requestBody)),
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

  details.claudeBillingHeaderMode = getConfig().claudeBillingHeaderMode;

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
  const config = getConfig();
  return {
    usageAvailable: true,
    breakerControlAvailable: true,
    healthWindowMs: config.healthWindowMs,
    healthFailureThreshold: config.healthFailureThreshold,
    healthFailureRateThreshold: config.healthFailureRateThreshold,
    healthCooldownMs: config.healthCooldownMs,
    channelMaxAttempts: config.channelMaxAttempts,
    channelRetryDelayMs: config.channelRetryDelayMs,
    cacheKeyHistory: cacheKeyHistoryStats(),
    instanceName: config.instanceName,
    host: config.host,
    port: config.port,
    routingConfigPath: config.routingConfigPath,
    configuredModels: listConfiguredModels(config.routingConfig),
    configuredChannels: Array.from(config.routingConfig.channelsById.keys()),
    configuredChannelDetails: Array.from(config.routingConfig.channelsById.values()).map(channel => ({
      id: channel.id,
      name: channel.name,
    })),
    configuredModelRoutes: Array.from(config.routingConfig.modelRoutes.values()).map(route => ({
      canonicalModel: route.canonicalModel,
      channelIds: route.channelIds,
    })),
    healthSnapshot: healthRegistry.snapshot(),
    compactDetection: _compactDetection.getResults(),
    activeRequests,
    maxConcurrentRequests: config.maxConcurrentRequests,
    cachedResponses: responseCache.size,
    maxCachedResponses: config.maxCachedResponses,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    nonStreamingRequestTimeoutMs: config.nonStreamingRequestTimeoutMs,
    firstByteTimeoutMs: config.firstByteTimeoutMs,
    firstTextTimeoutMs: config.firstTextTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    totalRequestTimeoutMs: config.totalRequestTimeoutMs,
    defaultStreamMode: config.defaultStreamMode,
    forceStoreFalse: config.forceStoreFalse,
    clearDeveloperContent: config.clearDeveloperContent,
    clearInstructions: config.clearInstructions,
    clearSystemContent: config.clearSystemContent,
    overrideInstructionsText: config.overrideInstructionsText,
    logRequestBodies: config.logRequestBodies,
    debugSse: config.debugSse,
    fallbackOnRetryable4xx: config.fallbackOnRetryable4xx,
    fallbackOnCompat4xx: config.fallbackOnCompat4xx,
    compatFallbackPatterns: config.compatFallbackPatterns,
    clientErrorPatterns: config.clientErrorPatterns,
    channelCooldownMs: config.channelCooldownMs,
    modelChannelCooldownMs: config.modelChannelCooldownMs,
    quotaCooldownMs: config.quotaCooldownMs,
    channelFailureThreshold: config.channelFailureThreshold,
    modelChannelFailureThreshold: config.modelChannelFailureThreshold,
    halfOpenMaxProbes: config.halfOpenMaxProbes,
    maxFallbackTotalMs: config.maxFallbackTotalMs,
    stats: {
      ...proxyStats,
      ...routingAttemptStats,
      compactDetectionRuns: _compactDetection.getRunCount(),
    },
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

export function isV2CompactionRequest(body: JsonRecord): boolean {
  return Array.isArray(body.input) && body.input.some(
    item => isJsonRecord(item) && item.type === 'compaction_trigger',
  );
}

function normalizeRequestBody(body: JsonRecord, stream: boolean, canonicalModel: string): JsonRecord {
  const { proxy_stream_mode: _proxyStreamMode, ...rest } = body;
  const model = canonicalModel;
  const rawInstructions =
    getConfig().overrideInstructionsText !== null
      ? getConfig().overrideInstructionsText
      : getConfig().clearInstructions && typeof rest.instructions === 'string'
      ? ''
      : rest.instructions;
  const instructions =
    typeof rawInstructions === 'string'
      ? sanitizeClaudeBillingHeaderText(rawInstructions, getConfig().claudeBillingHeaderMode)
      : rawInstructions;
  const promptCacheRetention =
    Object.hasOwn(rest, 'prompt_cache_retention') ? null : getConfig().defaultPromptCacheRetention;
  const promptCacheKey =
    Object.hasOwn(rest, 'prompt_cache_key') ? null : getConfig().defaultPromptCacheKey;

  return {
    ...rest,
    model,
    ...(rest.instructions === undefined && getConfig().overrideInstructionsText === null ? {} : { instructions }),
    ...(promptCacheRetention === null ? {} : { prompt_cache_retention: promptCacheRetention }),
    ...(promptCacheKey === null ? {} : { prompt_cache_key: promptCacheKey }),
    ...(rest.reasoning === undefined ? { reasoning: { effort: 'high' } } : {}),
    input: normalizeInput(rest.input, {
      clearDeveloperContent: getConfig().clearDeveloperContent,
      clearSystemContent: getConfig().clearSystemContent,
      convertSystemToDeveloper: getConfig().convertSystemToDeveloper,
      claudeBillingHeaderMode: getConfig().claudeBillingHeaderMode,
    }),
    stream,
    ...(getConfig().forceStoreFalse ? { store: false } : {}),
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

// Tool / function-call activity counts as meaningful output even though it
// produces no output_text. Without this, a legitimate tool-call turn (common
// for coding agents) would look "empty" once we stop trusting usage token
// counts. We treat a stream as having produced a tool call when we observe a
// function/tool/custom/mcp call item, or a function_call_arguments.* event.
const TOOL_CALL_ITEM_TYPES = new Set([
  'compaction',
  'function_call',
  'custom_tool_call',
  'mcp_call',
  'tool_call',
  'computer_call',
  'local_shell_call',
  'code_interpreter_call',
  'file_search_call',
  'web_search_call',
  'image_generation_call',
]);

function responseObjectHasToolCall(obj: JsonRecord): boolean {
  if (!Array.isArray(obj.output)) {
    return false;
  }

  for (const item of obj.output) {
    if (isJsonRecord(item) && typeof item.type === 'string' && TOOL_CALL_ITEM_TYPES.has(item.type)) {
      return true;
    }
  }

  return false;
}

function responseObjectHasMeaningfulNonTextOutput(obj: JsonRecord): boolean {
  if (!Array.isArray(obj.output)) {
    return false;
  }

  for (const item of obj.output) {
    if (!isJsonRecord(item) || typeof item.type !== 'string') {
      continue;
    }

    if (TOOL_CALL_ITEM_TYPES.has(item.type)) {
      return true;
    }

    if (item.type === 'reasoning') {
      if (Array.isArray(item.summary)) {
        for (const part of item.summary) {
          if (!isJsonRecord(part)) {
            continue;
          }
          if (part.type === 'summary_text' && typeof part.text === 'string' && part.text.length > 0) {
            return true;
          }
        }
      }

      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!isJsonRecord(part)) {
            continue;
          }
          if (part.type === 'reasoning_text' && typeof part.text === 'string' && part.text.length > 0) {
            return true;
          }
        }
      }
    }

    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isJsonRecord(part)) {
          continue;
        }

        if (part.type === 'refusal' && typeof part.refusal === 'string' && part.refusal.length > 0) {
          return true;
        }
      }
    }
  }

  return false;
}

function payloadHasToolCall(payload: unknown): boolean {
  if (!isJsonRecord(payload)) {
    return false;
  }

  const eventType = typeof payload.type === 'string' ? payload.type : '';

  if (eventType.startsWith('response.function_call_arguments') ||
      eventType.startsWith('response.custom_tool_call') ||
      eventType.startsWith('response.mcp_call')) {
    return true;
  }

  if (
    (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') &&
    isJsonRecord(payload.item) &&
    typeof payload.item.type === 'string' &&
    TOOL_CALL_ITEM_TYPES.has(payload.item.type)
  ) {
    return true;
  }

  if (
    (eventType === 'response.completed' || eventType === 'response.output_item.done') &&
    isJsonRecord(payload.response ?? payload.item)
  ) {
    const container = (payload.response ?? payload.item) as JsonRecord;
    if (responseObjectHasToolCall(container)) {
      return true;
    }
  }

  return false;
}

function hasMeaningfulResponseOutput(responseObject: JsonRecord | undefined) {
  if (!responseObject || !Array.isArray(responseObject.output)) {
    return false;
  }

  if (responseObjectHasMeaningfulNonTextOutput(responseObject)) {
    return true;
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

function isFallbackBudget(value: readonly ChannelConfig[] | FallbackBudget): value is FallbackBudget {
  return 'route' in value;
}

function canAttemptFallbackAfterStreamOutcome(
  outcome: {
    startedStreaming: boolean;
    wroteAnyEvent: boolean;
    wroteTextContent: boolean;
  },
  requestSignal: AbortSignal,
  routeOrIndex: ResolvedModelRoute | number,
  channelsOrBudget: readonly ChannelConfig[] | FallbackBudget,
  budgetMaybe?: FallbackBudget,
) {
  const budget = budgetMaybe ?? (isFallbackBudget(channelsOrBudget) ? channelsOrBudget : undefined);
  if (budget === undefined) {
    return false;
  }
  const route = typeof routeOrIndex === 'number' ? budget.route : routeOrIndex;
  return !outcome.startedStreaming && !outcome.wroteTextContent && canFallbackWithinBudget(requestSignal, route, budget);
}

function canAttemptFallback(
  requestSignal: AbortSignal,
  routeOrIndex: ResolvedModelRoute | number,
  channelsOrBudget: readonly ChannelConfig[] | FallbackBudget,
  budgetMaybe?: FallbackBudget,
) {
  const budget = budgetMaybe ?? (isFallbackBudget(channelsOrBudget) ? channelsOrBudget : undefined);
  if (budget === undefined) {
    return false;
  }
  const route = typeof routeOrIndex === 'number' ? budget.route : routeOrIndex;
  return canFallbackWithinBudget(requestSignal, route, budget);
}

function readStatus(extra: Record<string, unknown> | undefined): number | undefined {
  return typeof extra?.upstreamStatus === 'number' ? extra.upstreamStatus : undefined;
}

function readAbortReason(reason: FallbackReason | 'connect_timeout' | 'body_timeout', extra: Record<string, unknown> | undefined): AbortReason | undefined {
  const phase = extra?.phase;
  if (typeof phase !== 'string') {
    return undefined;
  }

  if (reason === 'connect_timeout' && phase === 'connect') {
    return { kind: 'timeout', phase };
  }

  if ((reason === 'body_timeout' || reason === 'headers_only_timeout') && (phase === 'first-byte' || phase === 'first-text' || phase === 'idle' || phase === 'total')) {
    return { kind: 'timeout', phase };
  }

  return undefined;
}

function normalizeFailureReason(reason: FallbackReason | 'connect_timeout' | 'body_timeout'): FallbackReason {
  return reason === 'connect_timeout' || reason === 'body_timeout' ? 'headers_only_timeout' : reason;
}

function reportAttemptFailure(
  attempt: UpstreamAttempt,
  reason: FallbackReason | 'connect_timeout' | 'body_timeout',
  _requestId?: string,
  extra?: Record<string, unknown>,
) {
  attempt.reportFailure({
    fallbackReason: normalizeFailureReason(reason),
    status: readStatus(extra),
    error: extra?.error,
    abortReason: readAbortReason(reason, extra),
    upstreamResponseObserved: true,
  });
}

function reportAttemptSuccess(attempt: UpstreamAttempt, _requestId?: string, _extra?: Record<string, unknown>) {
  attempt.reportSuccess();
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
  modelRoute: ResolvedModelRoute,
  upstreamBody: JsonRecord,
  parentSignal: AbortSignal,
  streamResponse: boolean,
  budget: FallbackBudget,
  _legacyStartIndex?: number,
): Promise<UpstreamAttempt> {
  const config = getConfig();
  const route = modelRoute;
  const connectTimeoutMs = getResponsesConnectTimeoutMs(streamResponse);
  const attemptedChannelIds = budget.attemptedChannelIds;

  const nextChannelName = () => {
    return nextAvailableChannel(route, config.routingConfig, healthRegistry, budget)?.name ?? null;
  };

  while (true) {
    if (attemptedChannelIds.size > 0) {
      const next = nextAvailableChannel(route, config.routingConfig, healthRegistry, budget);
      if (next && budget.counts.has(next.id) && config.channelRetryDelayMs > 0) {
        try { await delay(config.channelRetryDelayMs, undefined, { signal: parentSignal }); }
        catch (error) { throw Object.assign(error as Error, { abortReason: getAbortReason(parentSignal) }); }
      }
      if (!canFallbackWithinBudget(parentSignal, route, budget)) throw new Error('No model channel available after fallback attempts');
    }
    const selection = selectNextChannel(route, config.routingConfig, healthRegistry, budget);
    if (!selection.ok) {
      if (isModelChannelsUnavailable(selection, attemptedChannelIds) && attemptedChannelIds.size === 0) {
        throw new ModelChannelsUnavailableError(selection.retryAfterMs);
      }
      throw new Error('No model channel available after fallback attempts');
    }

    const { channel, channelIndex, lease } = selection;
    const channelAttemptNumber = budget.counts.get(channel.id)!;
    logRequest(requestId, channelAttemptNumber > 1 ? 'retrying same upstream channel' : 'selected upstream channel', {
      channelId: channel.id, channelAttempt: channelAttemptNumber, maxAttempts: budget.maxAttempts,
      routePosition: channelIndex + 1,
    });

    const linkedController = createLinkedAbortController(parentSignal);
    const usageAttempt = beginUsageAttempt(channel, String(upstreamBody.model), route.canonicalModel.startsWith('compact-v2:') ? 'compact-v2' : 'responses', linkedController.controller.signal);
    let healthCompleted = false;

    const reportSuccess = () => {
      const failure = upstreamFailures.get(linkedController.controller);
      if (failure) { reportFailure(failure); return; }
      usageAttempt.result('success');
      if (healthCompleted) {
        return;
      }
      reportChannelSuccess(lease, healthRegistry);
      budget.rememberChannel?.(channel);
      healthCompleted = true;
    };

    const reportFailure = (evidence: FailureEvidence) => {
      evidence = { ...evidence, ...upstreamFailures.get(linkedController.controller) };
      usageAttempt.result('failed', evidence.fallbackReason ?? 'upstream_error');
      if (evidence.status !== undefined) usageAttempt.row.status = evidence.status;
      if (healthCompleted) {
        return;
      }
      reportChannelFailure(lease, healthRegistry, evidence);
      healthCompleted = true;
    };

    const dispose = () => {
      if (!healthCompleted) {
        healthRegistry.complete(lease, {
          scope: 'none',
          success: false,
          reason: 'disposed',
          channelReachabilityProven: false,
        });
        healthCompleted = true;
      }
      linkedController.dispose();
      usageAttempt.finish();
    };

    if (attemptedChannelIds.size > 1) {
      logRequest(requestId, 'attempting fallback upstream', {
        fallbackName: channel.name,
        fallbackUrl: channel.responsesUrl,
        attempt: attemptedChannelIds.size - 1,
        totalFallbacks: Math.max(0, route.channelIds.length - 1),
        fallbackAttemptsUsed: budget.attemptsUsed,
        fallbackBudgetRemainingMs: config.maxFallbackTotalMs > 0 ? Math.max(0, config.maxFallbackTotalMs - (Date.now() - budget.startedAt)) : null,
      });
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        channel.responsesUrl,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${channel.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(budget.betaFeaturesHeader === undefined
              ? {}
              : { 'x-codex-beta-features': budget.betaFeaturesHeader }),
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
      const connectTimeoutPhase = connectTimeoutAbortReason?.phase;
      const fallbackReason: FallbackReason = connectTimeoutAbortReason ? 'headers_only_timeout' : 'connect_error';
      reportFailure({
        error,
        abortReason,
        fallbackReason,
        upstreamResponseObserved: false,
      });
      const canContinue = canFallbackWithinBudget(parentSignal, route, budget);

      if (connectTimeoutPhase && canContinue) {
        budget.attemptsUsed += 1;
        recordFallbackReason('headers_only_timeout', channel.name);
        logRequest(requestId, 'upstream connect timeout encountered, falling back', {
          upstreamName: channel.name,
          channelUrl: channel.responsesUrl,
          phase: connectTimeoutPhase,
          nextFallbackName: nextChannelName(),
        });
        dispose();
        continue;
      }

      if (!connectTimeoutAbortReason && !isAbortErrorLike(error, abortReason) && canContinue) {
        budget.attemptsUsed += 1;
        recordFallbackReason('connect_error', channel.name);
        logRequest(requestId, 'upstream connect error encountered, falling back', {
          upstreamName: channel.name,
          channelUrl: channel.responsesUrl,
          errorName: error instanceof Error ? error.name : undefined,
          errorMessage: error instanceof Error ? error.message : String(error),
          causeCode: typeof (error as { cause?: { code?: unknown } })?.cause?.code === 'string'
            ? (error as { cause: { code: string } }).cause.code
            : undefined,
          nextFallbackName: nextChannelName(),
        });
        dispose();
        continue;
      }

      dispose();
      throw attachChannelToError(error, channel, abortReason);
    }

    usageAttempt.row.status = response.status;
    if (attemptedChannelIds.size > 1 && response.ok) {
      logRequest(requestId, 'fallback upstream succeeded', {
        fallbackName: channel.name,
        fallbackUrl: channel.responsesUrl,
        upstreamStatus: response.status,
        upstreamContentType: response.headers.get('content-type') ?? null,
      });
    }

    if (response.ok) {
      return {
        channel,
        channelIndex,
        lease,
        response,
        controller: linkedController.controller,
        dispose,
        reportSuccess,
        reportFailure,
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

    const fallbackReason = isQuotaExhaustedEvidence({ status: response.status, payload: parsedErrorPayload, upstreamResponseObserved: true }) ? 'compat_4xx' : getUpstreamFallbackReason(response.status, parsedErrorPayload, {
      fallbackOnRetryable4xx: config.fallbackOnRetryable4xx,
      fallbackOnCompat4xx: config.fallbackOnCompat4xx,
      compatFallbackPatterns: config.compatFallbackPatterns,
      clientErrorPatterns: config.clientErrorPatterns,
    });

    if (isJsonRecord(parsedErrorPayload)) extractUsageFromStreamPayload(parsedErrorPayload, upstreamBody);

    reportFailure({
      status: response.status,
      payload: parsedErrorPayload,
      fallbackReason,
      upstreamResponseObserved: true,
    });

    if (!fallbackReason) {
      logRequest(requestId, 'upstream error did not match fallback policy', {
        upstreamName: channel.name,
        channelUrl: channel.responsesUrl,
        upstreamStatus: response.status,
        upstreamContentType,
        errorPreview,
        fallbackOnRetryable4xx: config.fallbackOnRetryable4xx,
        fallbackOnCompat4xx: config.fallbackOnCompat4xx,
      });
      return {
        channel,
        channelIndex,
        lease,
        response,
        controller: linkedController.controller,
        dispose,
        reportSuccess,
        reportFailure,
      };
    }

    const canFallback = canFallbackWithinBudget(parentSignal, route, budget);
    if (canFallback) {
      budget.attemptsUsed += 1;
    }
    logRequest(requestId, 'upstream error matched fallback policy', {
      upstreamName: channel.name,
      channelUrl: channel.responsesUrl,
      upstreamStatus: response.status,
      upstreamContentType,
      errorPreview,
      fallbackReason,
      nextFallbackName: nextChannelName(),
    });

    recordFallbackReason(fallbackReason, channel.name);
    if (!canFallback) {
      return {
        channel,
        channelIndex,
        lease,
        response,
        controller: linkedController.controller,
        dispose,
        reportSuccess,
        reportFailure,
      };
    }

    await closeResponseBody(response);
    dispose();
  }
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
  let wroteToolCall = false;
  let textCharCount = 0;
  const enforceFirstTextTimeout = !isV2CompactionRequest(requestBody) && getConfig().firstTextTimeoutMs > 0;

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
    wroteAnyEvent = true;
    const chunk = formatSseEvent(event);
    if (streamMode === 'normalized' && !wroteTextContent && !wroteToolCall) {
      pendingClientEvents.push(chunk);
      return;
    }
    ensureSseHeaders();
    startedStreaming = true;
    for (const pendingChunk of pendingClientEvents) res.write(pendingChunk);
    pendingClientEvents.length = 0;
    res.write(chunk);
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

        if (block.trim() && !isCommentOnlySseChunk(block)) {
          const parsedEvent = parseSseChunk(block);
          let normalizedEvent = parsedEvent;
          let isKeepAliveEvent = false;

          if (parsedEvent.data) {
            try {
              const parsedPayload = JSON.parse(parsedEvent.data);
              observeUpstreamFailure(controller, parsedPayload, upstreamResponse.status);
              isKeepAliveEvent = isKeepAliveStreamPayload(parsedPayload);
              if (!isKeepAliveEvent) {
                usage = extractUsageFromStreamPayload(parsedPayload, requestBody) ?? usage;
                const textLength = extractTextLengthFromResponsesPayload(parsedPayload);
                textCharCount += textLength;
                if (textLength > 0) {
                  wroteTextContent = true;
                  clearFirstTextTimer();
                }
                if (payloadHasToolCall(parsedPayload)) {
                  wroteToolCall = true;
                  clearFirstTextTimer();
                }
                normalizedEvent = {
                  event: parsedEvent.event,
                  data: JSON.stringify(normalizeStreamEventPayload(parsedPayload, requestBody)),
                };
              }
            } catch {
              normalizedEvent = parsedEvent;
            }
          }

          if (!isKeepAliveEvent) {
            writeSseEvent(streamMode === 'normalized' ? normalizedEvent : parsedEvent);
            streamEventCount += 1;
          }
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
      if (upstreamFailures.has(controller)) { await reader.cancel(); break; }
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

    return {
      kind: 'error',
      chunkCount,
      totalBytes,
      startedStreaming,
      wroteAnyEvent,
      wroteTextContent,
      textCharCount,
      error,
      fallbackReason: !wroteTextContent ? 'stream_no_text_content' : 'unknown_upstream_error',
    };
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
      if (pending.trim() && !isCommentOnlySseChunk(pending)) {
        const parsedEvent = parseSseChunk(pending);
        let normalizedEvent = parsedEvent;
        let isKeepAliveTail = false;

        if (streamMode === 'raw' && parsedEvent.data) extractUsageFromStreamPayload(parseStreamPayload(parsedEvent.data), requestBody);
        if (streamMode === 'normalized' && parsedEvent.data) {
          const parsedPayload = parseStreamPayload(parsedEvent.data);
          observeUpstreamFailure(controller, parsedPayload, upstreamResponse.status);
          if (isKeepAliveStreamPayload(parsedPayload)) {
            isKeepAliveTail = true;
          } else if (parsedPayload !== undefined) {
            usage = extractUsageFromStreamPayload(parsedPayload, requestBody) ?? usage;
            if (payloadHasToolCall(parsedPayload)) {
              wroteToolCall = true;
            }
            normalizedEvent = {
              event: parsedEvent.event,
              data: JSON.stringify(normalizeStreamEventPayload(parsedPayload, requestBody)),
            };
          }
        }

        if (!isKeepAliveTail) {
          writeSseEvent(streamMode === 'normalized' ? normalizedEvent : parsedEvent);
          streamEventCount += 1;
        }
      }
    }

    reader.releaseLock();
  }

  if (detectedResponsesStream) {
    if (startedStreaming && !res.writableEnded && !res.destroyed) {
      res.end();
    }

    if (usage) {
      addUsageToStats(usage);
    }

    const effectiveWroteText = wroteTextContent || wroteToolCall;

    if (!effectiveWroteText || upstreamFailures.has(controller)) {
      return {
        kind: 'completed',
        chunkCount,
        totalBytes,
        usage,
        startedStreaming,
        wroteAnyEvent,
        wroteTextContent: effectiveWroteText,
        textCharCount,
        fallbackReason: upstreamFailures.has(controller) ? 'unknown_upstream_error' : 'stream_no_text_content',
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
  let wroteToolCall = false;
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
  const enforceFirstTextTimeout =
    !isV2CompactionRequest(requestBody) && getConfig().firstTextTimeoutMs > 0 && streamMode === 'normalized';

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
        pending += textChunk;
        let boundary = pending.search(/\r?\n\r?\n/);
        while (boundary !== -1) {
          const event = parseSseChunk(pending.slice(0, boundary));
          observeUpstreamFailure(controller, parseStreamPayload(event.data), upstreamResponse.status);
          pending = pending.slice(boundary).replace(/^\r?\n\r?\n/, '');
          boundary = pending.search(/\r?\n\r?\n/);
        }
        if (upstreamFailures.has(controller)) { await reader.cancel(); break; }
        continue;
      }

      pending += textChunk;

      let separatorIndex = pending.search(/\r?\n\r?\n/);
      while (separatorIndex !== -1) {
        const block = pending.slice(0, separatorIndex);
        const separatorMatch = pending.slice(separatorIndex).match(/^\r?\n\r?\n/);
        const separatorLength = separatorMatch ? separatorMatch[0].length : 2;
        pending = pending.slice(separatorIndex + separatorLength);

        if (block.trim() && !isCommentOnlySseChunk(block)) {
          const parsedEvent = parseSseChunk(block);
          let normalizedEvent = parsedEvent;
          let isKeepAliveEvent = false;

          if (parsedEvent.data) {
            try {
              const parsedPayload = JSON.parse(parsedEvent.data);
              observeUpstreamFailure(controller, parsedPayload, upstreamResponse.status);
              isKeepAliveEvent = isKeepAliveStreamPayload(parsedPayload);
              if (!isKeepAliveEvent) {
                usage = extractUsageFromStreamPayload(parsedPayload, requestBody) ?? usage;
                const textLength = extractTextLengthFromResponsesPayload(parsedPayload);
                textCharCount += textLength;
                if (textLength > 0) {
                  wroteTextContent = true;
                  clearFirstTextTimer();
                }
                if (payloadHasToolCall(parsedPayload)) {
                  wroteToolCall = true;
                  clearFirstTextTimer();
                }
                normalizedEvent = {
                  event: parsedEvent.event,
                  data: JSON.stringify(normalizeStreamEventPayload(parsedPayload, requestBody)),
                };
              }
            } catch {
              normalizedEvent = parsedEvent;
            }
          }

          if (!isKeepAliveEvent) {
            const formattedEvent = formatSseEvent(normalizedEvent);
            if (wroteTextContent || wroteToolCall) {
              flushPendingClientEvents();
              writeSseChunk(formattedEvent);
            } else {
              pendingClientEvents.push(formattedEvent);
            }
            wroteAnyEvent = true;
            streamEventCount += 1;
          }
        } else {
          if (wroteTextContent || wroteToolCall) {
            flushPendingClientEvents();
            writeSseChunk('\n');
          } else {
            pendingClientEvents.push('\n');
          }
        }

        separatorIndex = pending.search(/\r?\n\r?\n/);
      }
      if (upstreamFailures.has(controller)) { await reader.cancel(); break; }
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

    return {
      kind: 'error',
      chunkCount,
      totalBytes,
      startedStreaming,
      wroteAnyEvent,
      wroteTextContent,
      textCharCount,
      error,
      fallbackReason: !wroteTextContent ? 'stream_no_text_content' : 'unknown_upstream_error',
    };
  } finally {
    if (streamTimer) {
      clearTimeout(streamTimer);
    }
    clearFirstTextTimer();

    const finalChunk = decoder.decode();
    collectedText += finalChunk;

    if (streamMode === 'normalized' && !controller.signal.aborted) {
      pending += finalChunk;
      if (pending.trim() && !isCommentOnlySseChunk(pending)) {
        const parsedEvent = parseSseChunk(pending);
        let normalizedEvent = parsedEvent;
        let isKeepAliveTail = false;

        if (parsedEvent.data) {
          try {
            const parsedPayload = JSON.parse(parsedEvent.data);
            observeUpstreamFailure(controller, parsedPayload, upstreamResponse.status);
            if (isKeepAliveStreamPayload(parsedPayload)) {
              isKeepAliveTail = true;
            } else {
              const textLength = extractTextLengthFromResponsesPayload(parsedPayload);
              textCharCount += textLength;
              if (textLength > 0) {
                wroteTextContent = true;
              }
              if (payloadHasToolCall(parsedPayload)) {
                wroteToolCall = true;
              }
              normalizedEvent = {
                event: parsedEvent.event,
                data: JSON.stringify(normalizeStreamEventPayload(parsedPayload, requestBody)),
              };
            }
          } catch {
            normalizedEvent = parsedEvent;
          }
        }

        if (!isKeepAliveTail) {
          const formattedEvent = formatSseEvent(normalizedEvent);
          if (wroteTextContent || wroteToolCall) {
            flushPendingClientEvents();
            writeSseChunk(formattedEvent);
          } else {
            pendingClientEvents.push(formattedEvent);
          }
        }
      }
    }

    const events = parseSse(collectedText);
    // Observe reported usage even when a raw stream later disconnects or times out.
    for (const event of events) {
      const payload = parseStreamPayload(event.data);
      extractUsageFromStreamPayload(payload, requestBody);
      observeUpstreamFailure(controller, payload, upstreamResponse.status);
    }
    if (!controller.signal.aborted) {
      logSseDebug(requestId, events);
      const responseObject = synthesizeResponseFromEvents(events);
      if (responseObject) {
        const normalizedResponse = normalizeResponseObject(responseObject, requestBody);
        cacheResponse(normalizedResponse);
        usage = extractUsageMetrics(normalizedResponse) ?? usage;
        if (hasMeaningfulResponseOutput(normalizedResponse)) {
          wroteTextContent = true;
        }
        if (responseObjectHasToolCall(normalizedResponse)) {
          wroteToolCall = true;
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

  // A stream is only "useful" if it produced visible text or a tool call.
  // Upstream-reported usage.outputTokens is NOT sufficient: some providers
  // report token counts while emitting only reasoning/meta events and no
  // client-visible answer, which previously slipped through as a 200 with an
  // empty body and stalled the calling agent. Tool calls are tracked
  // separately so legitimate function-call turns (no output_text) still pass.
  const effectiveWroteText = wroteTextContent || wroteToolCall;

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
    wroteToolCall,
    effectiveWroteText,
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
    fallbackReason: upstreamFailures.has(controller) ? 'unknown_upstream_error' : !effectiveWroteText ? 'stream_no_text_content' : undefined,
  };
}

const server = createServer((req, res) => {
  const _snap = runtimeStore.getSnapshot();
  usageContext.run({ requestId: randomUUID(), write: row => _usageStore.write(row) }, () => _requestContext.run(_snap, async () => {
  const runtimeVersion = _snap.runtimeVersion;

  const {
    clientErrorPatterns,
    compatFallbackPatterns,
    clearDeveloperContent,
    claudeBillingHeaderMode,
    clearInstructions,
    clearSystemContent,
    convertSystemToDeveloper,
    debugSse,
    defaultPromptCacheKey,
    defaultPromptCacheRetention,
    defaultStreamMode,
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
    maxFallbackTotalMs,
    overrideInstructionsText,
    port,
    routingConfig,
    routingConfigPath,
    sseFailureDebugDir,
    sseFailureDebugEnabled,
    streamIdleTimeoutMs,
    streamMissingUsageDebugDir,
    streamMissingUsageDebugEnabled,
    nonStreamingRequestTimeoutMs,
    totalRequestTimeoutMs,
    upstreamTimeoutMs,
  } = _snap.config;

  const requestId = createRequestId();
  const startedAt = Date.now();
  let countedAsActive = false;
  const upstreamController = new AbortController();
  const requestTotalTimeoutMs = req.url === '/v1/responses/compact' ? 0 : totalRequestTimeoutMs;
  const totalTimeout = requestTotalTimeoutMs > 0
    ? setTimeout(() => {
      abortWithReason(upstreamController, { kind: 'timeout', phase: 'total' });
    }, requestTotalTimeoutMs)
    : undefined;

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
    if (statusCode >= 400) usageContext.getStore()?.current?.result(statusCode === 499 ? 'cancelled' : 'failed', note);
    if (
      compactV2Request &&
      !compactV2FallbackRecorded &&
      compactV2AttemptedChannelIds !== undefined &&
      compactV2AttemptedChannelIds.size > 1
    ) {
      proxyStats.compactV2Fallbacks += 1;
      compactV2FallbackRecorded = true;
    }
    recordStatus(statusCode);
    logRequest(requestId, note, {
      statusCode,
      durationMs: Date.now() - startedAt,
      activeRequests,
      runtimeVersion,
      ...extra,
    });
  };
  let compactV2Request = false;
  let compactV2FallbackRecorded = false;
  let compactV2AttemptedChannelIds: ReadonlySet<string> | undefined;
  let selectedChannel: ChannelConfig | undefined;
  let selectedChannelForLog: ChannelConfig | undefined;

  try {
    if (!req.url) {
      sendJson(res, 404, makeError('Not found', 404).body);
      finish(404, 'missing url');
      return;
    }

    const _adminHandled = await _adminHandler(req, res);
    if (_adminHandled) {
      if ((req.url ?? '').split(/[?#]/)[0] === '/admin/monitor/stats') {
        return;
      }
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
        routingConfigPath,
        configuredModelCount: routingConfig.modelRoutes.size,
        configuredChannelCount: routingConfig.channelsById.size,
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
        claudeBillingHeaderMode,
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
      const payload = buildConfiguredModelsResponse(routingConfig);
      sendJson(res, 200, payload as JsonValue);
      finish(200, 'models config-derived returned');
      return;
    }

    const isCompactRequest = req.method === 'POST' && req.url === '/v1/responses/compact';
    const isResponsesRequest = req.method === 'POST' && req.url === '/v1/responses';
    if (!isCompactRequest && !isResponsesRequest) {
      sendJson(
        res,
        404,
        makeError('Supported routes: GET /healthz, GET /admin/config, POST /admin/config/validate, PUT /admin/config, POST /admin/config/reload, POST /admin/config/rollback, GET /admin/stats, GET /admin/compact/detection, POST /admin/compact/detect, GET /v1/models, GET /v1/responses/:id, POST /admin/cache/clear, POST /v1/responses, POST /v1/responses/compact', 404).body,
      );
      finish(404, 'unsupported route', { method: req.method, url: req.url });
      return;
    }

    if (isCompactRequest) {
      proxyStats.compactRequestsTotal += 1;
    } else {
      proxyStats.requestsTotal += 1;
    }

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

    if (isCompactRequest) {
      if (routingConfig.compactRoute === undefined) {
        sendJson(res, 501, makeError('compact route not configured', 501).body);
        finish(501, 'compact route not configured');
        return;
      }

      const compactResult = await _compactProxy(requestBody, upstreamController.signal);
      if ('attempts' in compactResult && compactResult.attempts > 1) {
        proxyStats.compactFallbacks += 1;
      }

      switch (compactResult.kind) {
        case 'all_unavailable': {
          const retryAfterMs = Math.max(1, compactResult.retryAfterMs);
          res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
          sendJson(res, 503, makeError('compact_channels_unavailable', 503, { retryAfterMs }).body);
          finish(503, 'compact channels unavailable', { retryAfterMs });
          return;
        }
        case 'client_disconnect':
          finish(499, 'compact request cancelled by client', { source: compactResult.source });
          return;
        case 'fallback_exhausted':
          sendJson(
            res,
            compactResult.status,
            makeError('No upstream endpoint produced a usable response before fallback was exhausted', compactResult.status, compactResult.details).body,
          );
          finish(compactResult.status, 'compact fallback exhausted', compactResult.details);
          return;
        case 'upstream_error':
          sendJson(res, compactResult.status, compactResult.body);
          finish(compactResult.status, 'compact upstream error', {
            upstreamName: compactResult.channel.name,
            upstreamStatus: compactResult.status,
            attempts: compactResult.attempts,
          });
          return;
        case 'success':
          addUsageToStats(compactResult.usage);
          sendJson(res, compactResult.status, compactResult.body);
          finish(compactResult.status, 'compact response returned', {
            upstreamName: compactResult.channel.name,
            upstreamStatus: compactResult.status,
            attempts: compactResult.attempts,
            usage: compactResult.usage,
          });
          return;
        default:
          return assertNeverCompactResult(compactResult);
      }
    }

    const streamResponse = wantsStreaming(req, requestBody);
    const streamMode = getStreamMode(req, requestBody);
    logRequestAccepted(requestId, req, streamResponse, streamMode);
    const responsesConnectTimeoutMs = getResponsesConnectTimeoutMs(streamResponse);
    const responsesFirstByteTimeoutMs = getResponsesFirstByteTimeoutMs(streamResponse);
    const modelResolution = resolveModelRoute(requestBody.model, routingConfig);
    if ('code' in modelResolution) {
      sendJson(res, 400, makeError(`Model not configured: ${modelResolution.requestedModel}`, 400).body);
      finish(400, 'model not configured', { requestedModel: modelResolution.requestedModel });
      return;
    }

    compactV2Request = isV2CompactionRequest(requestBody);
    if (compactV2Request) {
      proxyStats.compactV2RequestsTotal += 1;
    }
    const compactV2ChannelIds = routingConfig.compactRoute?.v2ChannelIds ?? [];
    const usesCompactV2Route = compactV2Request && compactV2ChannelIds.length > 0;
    const upstreamRoute: ResolvedModelRoute = usesCompactV2Route
      ? {
        requestedModel: modelResolution.requestedModel,
        canonicalModel: compactV2HealthKey(modelResolution.canonicalModel),
        channelIds: compactV2ChannelIds,
      }
      : modelResolution;
    const clientBetaFeatures = req.headers['x-codex-beta-features'];
    const betaFeaturesHeader = compactV2Request
      ? Array.isArray(clientBetaFeatures)
        ? clientBetaFeatures.join(', ')
        : clientBetaFeatures ?? 'remote_compaction_v2'
      : undefined;

    const upstreamBody = normalizeRequestBody(requestBody, streamResponse, modelResolution.canonicalModel);
    const channels = upstreamRoute.channelIds.flatMap(channelId => {
      const channel = routingConfig.channelsById.get(channelId);
      return channel === undefined ? [] : [channel];
    });
    const routeChannels = channels;
    selectedChannelForLog = channels[0];
    selectedChannel = selectedChannelForLog;
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
      ...createChannelAttempts(getConfig().channelMaxAttempts),
      route: upstreamRoute,
      rememberChannel: trackCacheKey(upstreamBody.prompt_cache_key, upstreamRoute.canonicalModel),
      ...(betaFeaturesHeader === undefined ? {} : { betaFeaturesHeader }),
    };
    compactV2AttemptedChannelIds = fallbackBudget.attemptedChannelIds;
    try {
      upstreamAttempt = await fetchResponsesUpstream(
        requestId,
        upstreamRoute,
        upstreamBody,
        upstreamController.signal,
        streamResponse,
        fallbackBudget,
      );
      selectedChannel = upstreamAttempt.channel;
      selectedChannelForLog = upstreamAttempt.channel;
    } catch (error) {
      const maybeAbortError = error as Error & { abortReason?: AbortReason };
      const maybeAbortObject = error as { abortReason?: AbortReason; error?: unknown };
      const errorChannel = getChannelFromError(error);
      if (errorChannel) {
        selectedChannel = errorChannel;
        selectedChannelForLog = errorChannel;
      }
      if (error instanceof ModelChannelsUnavailableError) {
        const retryAfterMs = Math.max(1, error.retryAfterMs);
        const unavailableCode = usesCompactV2Route
          ? 'compact_v2_channels_unavailable'
          : 'model_channels_unavailable';
        res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        if (streamResponse) {
          sendResponsesStreamError(res, unavailableCode, {
            statusCode: 503,
            code: 'server_error',
            sequenceNumber: 1,
          });
        } else {
          sendJson(res, 503, makeError(unavailableCode, 503, { retryAfterMs }).body);
        }
        finish(503, usesCompactV2Route ? 'compact v2 channels unavailable' : 'model channels unavailable', {
          retryAfterMs,
        });
        return;
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
        finish(504, 'upstream timeout', { phase: abortReason.phase, upstreamName: selectedChannelForLog.name });
        return;
      }

      if (isAbortErrorLike(error, abortReason) && abortReason?.kind === 'client_disconnect') {
        finish(499, 'request cancelled by client', { source: abortReason.source, upstreamName: selectedChannelForLog.name });
        return;
      }

      throw error;
    }

    selectedChannelForLog = upstreamAttempt.channel;

    let bufferedUpstreamText: string | undefined;

    if (streamResponse) {
      const endpoints = routeChannels;
      let currentAttempt = upstreamAttempt;

      while (true) {
        const upstreamContentType = currentAttempt.response.headers.get('content-type') ?? '';

        if (currentAttempt.response.ok && upstreamContentType.includes('text/event-stream')) {
          logRequest(requestId, 'stream passthrough started', {
            upstreamName: currentAttempt.channel.name,
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
          if (streamOutcome.kind !== 'client_disconnect' && (streamOutcome.kind !== 'completed' || streamOutcome.fallbackReason)) {
            currentAttempt.reportFailure({
              fallbackReason: streamOutcome.fallbackReason ?? 'unknown_upstream_error',
              abortReason: getAbortReason(currentAttempt.controller.signal),
              upstreamResponseObserved: true,
            });
          }

          if (streamOutcome.kind === 'timeout') {
            proxyStats.upstreamTimeouts += 1;
            const canFallback = canAttemptFallbackAfterStreamOutcome(
              streamOutcome,
              upstreamController.signal,
              currentAttempt.channelIndex,
              endpoints,
              fallbackBudget,
            );

            if (canFallback) {
              const fallbackReason = streamOutcome.fallbackReason ?? 'headers_only_timeout';
              fallbackBudget.attemptsUsed += 1;
              reportAttemptFailure(currentAttempt, fallbackReason, requestId, {
                phase: streamOutcome.phase,
                streamMode,
                ...getStreamObservationLogFields(streamOutcome, {
                  phase: streamOutcome.phase,
                  fallbackReason,
                }),
              });
              logRequest(requestId, getStreamTimeoutLogMessage(streamOutcome.phase, { fallingBack: true }), {
                phase: streamOutcome.phase,
                upstreamName: currentAttempt.channel.name,
                nextFallbackName: endpoints[currentAttempt.channelIndex + 1]?.name ?? null,
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
              recordFallbackReason(fallbackReason, currentAttempt.channel.name);
              await closeResponseBody(currentAttempt.response);
              currentAttempt.dispose();
              try {
                currentAttempt = await fetchResponsesUpstream(
                  requestId,
                  upstreamRoute,
                upstreamBody,
                  upstreamController.signal,
                  streamResponse,
                  fallbackBudget,
                  currentAttempt.channelIndex + 1,
                );
              } catch (error) {
                const maybeAbortError = error as Error & { abortReason?: AbortReason };
                const maybeAbortObject = error as { abortReason?: AbortReason; error?: unknown };
                const errorEndpoint = getChannelFromError(error);
                if (errorEndpoint) {
                  selectedChannelForLog = errorEndpoint;
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
                    upstreamName: selectedChannelForLog.name,
                  });
                  return;
                }

                if (isAbortErrorLike(error, abortReason) && abortReason?.kind === 'client_disconnect') {
                  finish(499, 'stream fallback request cancelled by client', {
                    source: abortReason.source,
                    upstreamName: selectedChannelForLog.name,
                  });
                  return;
                }

                throw error;
              }
              selectedChannelForLog = currentAttempt.channel;
              continue;
            }

            if (!streamOutcome.startedStreaming) {
              sendResponsesStreamError(res, createTimeoutMessage(streamOutcome.phase), {
                statusCode: 504,
                code: 'server_error',
                sequenceNumber: streamOutcome.chunkCount + 1,
              });
            }

            reportAttemptFailure(currentAttempt, streamOutcome.fallbackReason ?? 'headers_only_timeout', requestId, {
              phase: streamOutcome.phase,
              streamMode,
            });
            currentAttempt.dispose();
            finish(504, getStreamTimeoutLogMessage(streamOutcome.phase), {
              phase: streamOutcome.phase,
              upstreamContentType,
              upstreamStatus: currentAttempt.response.status,
              chunkCount: streamOutcome.chunkCount,
              totalBytes: streamOutcome.totalBytes,
              streamMode,
              upstreamName: currentAttempt.channel.name,
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
              upstreamName: currentAttempt.channel.name,
            });
            return;
          }

          if (streamOutcome.kind === 'error') {
            const canFallback = canAttemptFallbackAfterStreamOutcome(
              streamOutcome,
              upstreamController.signal,
              currentAttempt.channelIndex,
              endpoints,
              fallbackBudget,
            );

            if (canFallback && streamOutcome.fallbackReason) {
              fallbackBudget.attemptsUsed += 1;
              recordFallbackReason(streamOutcome.fallbackReason, currentAttempt.channel.name);
              reportAttemptFailure(currentAttempt, streamOutcome.fallbackReason, requestId, {
                streamMode,
                error: streamOutcome.error instanceof Error
                  ? { name: streamOutcome.error.name, message: streamOutcome.error.message }
                  : String(streamOutcome.error),
              });
              logRequest(requestId, 'stream read error before usable output, falling back', {
                fallbackReason: streamOutcome.fallbackReason,
                upstreamName: currentAttempt.channel.name,
                nextFallbackName: endpoints[currentAttempt.channelIndex + 1]?.name ?? null,
                streamMode,
                wroteAnyEvent: streamOutcome.wroteAnyEvent,
                wroteTextContent: streamOutcome.wroteTextContent,
                textCharCount: streamOutcome.textCharCount,
                error: streamOutcome.error instanceof Error
                  ? { name: streamOutcome.error.name, message: streamOutcome.error.message }
                  : String(streamOutcome.error),
              });
              await closeResponseBody(currentAttempt.response);
              currentAttempt.dispose();
              currentAttempt = await fetchResponsesUpstream(
                requestId,
                upstreamRoute,
                upstreamBody,
                upstreamController.signal,
                streamResponse,
                fallbackBudget,
                currentAttempt.channelIndex + 1,
              );
              selectedChannelForLog = currentAttempt.channel;
              continue;
            }

            reportAttemptFailure(currentAttempt, streamOutcome.fallbackReason ?? 'unknown_upstream_error', requestId, {
              streamMode,
              error: streamOutcome.error instanceof Error
                ? { name: streamOutcome.error.name, message: streamOutcome.error.message }
                : String(streamOutcome.error),
            });
            currentAttempt.dispose();
            if (streamOutcome.startedStreaming && !res.writableEnded && !res.destroyed) {
              sendResponsesStreamError(res, 'Upstream stream terminated unexpectedly', {
                statusCode: 502,
                code: 'server_error',
                sequenceNumber: streamOutcome.chunkCount + 1,
              });
            } else if (!res.headersSent) {
              sendJson(res, 502, makeError('Upstream stream terminated unexpectedly', 502).body);
            }
            finish(502, 'stream read error', {
              upstreamName: currentAttempt.channel.name,
              streamMode,
              wroteTextContent: streamOutcome.wroteTextContent,
            });
            return;
          }

          if (streamOutcome.fallbackReason && canAttemptFallbackAfterStreamOutcome(
            streamOutcome,
            upstreamController.signal,
            currentAttempt.channelIndex,
            endpoints,
            fallbackBudget,
          )) {
            fallbackBudget.attemptsUsed += 1;
            recordFallbackReason(streamOutcome.fallbackReason, currentAttempt.channel.name);
            reportAttemptFailure(currentAttempt, streamOutcome.fallbackReason, requestId, {
              streamMode,
              usageFound: Boolean(streamOutcome.usage),
            });
            logRequest(requestId, 'stream completed without usable output, falling back', {
              fallbackReason: streamOutcome.fallbackReason,
              upstreamName: currentAttempt.channel.name,
              nextFallbackName: endpoints[currentAttempt.channelIndex + 1]?.name ?? null,
              streamMode,
              wroteAnyEvent: streamOutcome.wroteAnyEvent,
              wroteTextContent: streamOutcome.wroteTextContent,
              textCharCount: streamOutcome.textCharCount,
              usageFound: Boolean(streamOutcome.usage),
              usageOutputTokens: streamOutcome.usage && typeof streamOutcome.usage.outputTokens === 'number' ? streamOutcome.usage.outputTokens : null,
              chunkCount: streamOutcome.chunkCount,
              totalBytes: streamOutcome.totalBytes,
            });
            currentAttempt.dispose();
            try {
              currentAttempt = await fetchResponsesUpstream(
                requestId,
                upstreamRoute,
                upstreamBody,
                upstreamController.signal,
                streamResponse,
                fallbackBudget,
                currentAttempt.channelIndex + 1,
              );
            } catch (error) {
              const maybeAbortError = error as Error & { abortReason?: AbortReason };
              const maybeAbortObject = error as { abortReason?: AbortReason; error?: unknown };
              const errorEndpoint = getChannelFromError(error);
              if (errorEndpoint) {
                selectedChannelForLog = errorEndpoint;
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
                  upstreamName: selectedChannelForLog.name,
                });
                return;
              }

              if (isAbortErrorLike(error, abortReason) && abortReason?.kind === 'client_disconnect') {
                finish(499, 'stream fallback cancelled by client after incomplete output', {
                  source: abortReason.source,
                  upstreamName: selectedChannelForLog.name,
                });
                return;
              }

              throw error;
            }
            selectedChannelForLog = currentAttempt.channel;
            continue;
          }

          if (streamOutcome.fallbackReason) {
            const message = `No upstream endpoint produced a usable response before fallback was exhausted: ${streamOutcome.fallbackReason}`;
            sendResponsesStreamError(res, message, {
              statusCode: 502,
              code: 'server_error',
              sequenceNumber: streamOutcome.chunkCount + 1,
            });
            reportAttemptFailure(currentAttempt, streamOutcome.fallbackReason, requestId, {
              streamMode,
              usageFound: Boolean(streamOutcome.usage),
            });
            currentAttempt.dispose();
            finish(502, 'stream fallback exhausted without usable output', {
              fallbackReason: streamOutcome.fallbackReason,
              upstreamName: currentAttempt.channel.name,
              streamMode,
              usageFound: Boolean(streamOutcome.usage),
              usageOutputTokens: streamOutcome.usage && typeof streamOutcome.usage.outputTokens === 'number' ? streamOutcome.usage.outputTokens : null,
              chunkCount: streamOutcome.chunkCount,
              totalBytes: streamOutcome.totalBytes,
              wroteAnyEvent: streamOutcome.wroteAnyEvent,
              wroteTextContent: streamOutcome.wroteTextContent,
              textCharCount: streamOutcome.textCharCount,
            });
            return;
          }

          if (streamMode === 'normalized') {
            proxyStats.responsesSseNormalized += 1;
          } else {
            proxyStats.responsesSseRaw += 1;
          }
          reportAttemptSuccess(currentAttempt, requestId, { streamMode, path: 'stream_passthrough' });
          currentAttempt.dispose();

          finish(200, 'stream passthrough returned', {
            upstreamContentType,
            upstreamStatus: currentAttempt.response.status,
            streamMode,
            upstreamName: currentAttempt.channel.name,
            usage: streamOutcome.usage,
          });
          return;
        }

        if (currentAttempt.response.ok && !upstreamContentType.includes('application/json')) {
          logRequest(requestId, 'probing non-standard stream response', {
            upstreamName: currentAttempt.channel.name,
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
          if (probeOutcome.kind !== 'client_disconnect' && probeOutcome.kind !== 'buffered_text' && (probeOutcome.kind !== 'completed' || probeOutcome.fallbackReason)) {
            currentAttempt.reportFailure({
              fallbackReason: probeOutcome.fallbackReason ?? 'unknown_upstream_error',
              abortReason: getAbortReason(currentAttempt.controller.signal),
              upstreamResponseObserved: true,
            });
          }

          if (probeOutcome.kind === 'timeout') {
            proxyStats.upstreamTimeouts += 1;
            const canFallback = canAttemptFallbackAfterStreamOutcome(
              probeOutcome,
              upstreamController.signal,
              currentAttempt.channelIndex,
              endpoints,
              fallbackBudget,
            );

            if (canFallback) {
              const fallbackReason = probeOutcome.fallbackReason ?? 'headers_only_timeout';
              fallbackBudget.attemptsUsed += 1;
              recordFallbackReason(fallbackReason, currentAttempt.channel.name);
              reportAttemptFailure(currentAttempt, fallbackReason, requestId, {
                phase: probeOutcome.phase,
                streamMode,
              });
              logRequest(requestId, 'non-standard stream probe timed out before meaningful output, falling back', {
                phase: probeOutcome.phase,
                upstreamContentType,
                upstreamStatus: currentAttempt.response.status,
                upstreamName: currentAttempt.channel.name,
                nextFallbackName: endpoints[currentAttempt.channelIndex + 1]?.name ?? null,
                fallbackReason,
                wroteAnyEvent: probeOutcome.wroteAnyEvent,
                wroteTextContent: probeOutcome.wroteTextContent,
                textCharCount: probeOutcome.textCharCount,
              });
              await closeResponseBody(currentAttempt.response);
              currentAttempt.dispose();
              currentAttempt = await fetchResponsesUpstream(
                requestId,
                upstreamRoute,
                upstreamBody,
                upstreamController.signal,
                streamResponse,
                fallbackBudget,
                currentAttempt.channelIndex + 1,
              );
              selectedChannelForLog = currentAttempt.channel;
              continue;
            }

            reportAttemptFailure(currentAttempt, probeOutcome.fallbackReason ?? 'headers_only_timeout', requestId, {
              phase: probeOutcome.phase,
              streamMode,
            });
            currentAttempt.dispose();
            finish(504, 'non-standard stream probe timed out', {
              phase: probeOutcome.phase,
              upstreamContentType,
              upstreamStatus: currentAttempt.response.status,
              chunkCount: probeOutcome.chunkCount,
              totalBytes: probeOutcome.totalBytes,
              streamMode,
              upstreamName: currentAttempt.channel.name,
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
              upstreamName: currentAttempt.channel.name,
            });
            return;
          }

          if (probeOutcome.kind === 'error') {
            const canFallback = canAttemptFallbackAfterStreamOutcome(
              probeOutcome,
              upstreamController.signal,
              currentAttempt.channelIndex,
              endpoints,
              fallbackBudget,
            );

            if (canFallback && probeOutcome.fallbackReason) {
              fallbackBudget.attemptsUsed += 1;
              recordFallbackReason(probeOutcome.fallbackReason, currentAttempt.channel.name);
              reportAttemptFailure(currentAttempt, probeOutcome.fallbackReason, requestId, {
                streamMode,
              });
              logRequest(requestId, 'non-standard stream read error before usable output, falling back', {
                fallbackReason: probeOutcome.fallbackReason,
                upstreamContentType,
                upstreamStatus: currentAttempt.response.status,
                upstreamName: currentAttempt.channel.name,
                nextFallbackName: endpoints[currentAttempt.channelIndex + 1]?.name ?? null,
              });
              await closeResponseBody(currentAttempt.response);
              currentAttempt.dispose();
              currentAttempt = await fetchResponsesUpstream(
                requestId,
                upstreamRoute,
                upstreamBody,
                upstreamController.signal,
                streamResponse,
                fallbackBudget,
                currentAttempt.channelIndex + 1,
              );
              selectedChannelForLog = currentAttempt.channel;
              continue;
            }

            reportAttemptFailure(currentAttempt, probeOutcome.fallbackReason ?? 'unknown_upstream_error', requestId, {
              streamMode,
            });
            currentAttempt.dispose();
            sendJson(res, 502, makeError('Upstream stream terminated unexpectedly', 502).body);
            finish(502, 'non-standard stream read error', {
              upstreamContentType,
              upstreamName: currentAttempt.channel.name,
            });
            return;
          }

          if (probeOutcome.kind === 'completed') {
            if (
              probeOutcome.fallbackReason &&
              canAttemptFallbackAfterStreamOutcome(
                probeOutcome,
                upstreamController.signal,
                currentAttempt.channelIndex,
                endpoints,
                fallbackBudget,
              )
            ) {
              fallbackBudget.attemptsUsed += 1;
              recordFallbackReason(probeOutcome.fallbackReason, currentAttempt.channel.name);
              reportAttemptFailure(currentAttempt, probeOutcome.fallbackReason, requestId, {
                streamMode,
              });
              logRequest(requestId, 'non-standard stream completed without usable output, falling back', {
                fallbackReason: probeOutcome.fallbackReason,
                upstreamContentType,
                upstreamStatus: currentAttempt.response.status,
                upstreamName: currentAttempt.channel.name,
                nextFallbackName: endpoints[currentAttempt.channelIndex + 1]?.name ?? null,
                wroteAnyEvent: probeOutcome.wroteAnyEvent,
                wroteTextContent: probeOutcome.wroteTextContent,
                textCharCount: probeOutcome.textCharCount,
              });
              await closeResponseBody(currentAttempt.response);
              currentAttempt.dispose();
              currentAttempt = await fetchResponsesUpstream(
                requestId,
                upstreamRoute,
                upstreamBody,
                upstreamController.signal,
                streamResponse,
                fallbackBudget,
                currentAttempt.channelIndex + 1,
              );
              selectedChannelForLog = currentAttempt.channel;
              continue;
            }

            if (probeOutcome.fallbackReason) {
              const message = `No upstream endpoint produced a usable response before fallback was exhausted: ${probeOutcome.fallbackReason}`;
              sendResponsesStreamError(res, message, {
                statusCode: 502,
                code: 'server_error',
                sequenceNumber: probeOutcome.chunkCount + 1,
              });
              reportAttemptFailure(currentAttempt, probeOutcome.fallbackReason, requestId, {
                streamMode,
              });
              currentAttempt.dispose();
              finish(502, 'non-standard stream fallback exhausted without usable output', {
                fallbackReason: probeOutcome.fallbackReason,
                upstreamContentType,
                upstreamStatus: currentAttempt.response.status,
                upstreamName: currentAttempt.channel.name,
                streamMode,
                chunkCount: probeOutcome.chunkCount,
                totalBytes: probeOutcome.totalBytes,
                wroteAnyEvent: probeOutcome.wroteAnyEvent,
                wroteTextContent: probeOutcome.wroteTextContent,
                textCharCount: probeOutcome.textCharCount,
              });
              return;
            }

            if (streamMode === 'normalized') {
              proxyStats.responsesSseNormalized += 1;
            } else {
              proxyStats.responsesSseRaw += 1;
            }
            reportAttemptSuccess(currentAttempt, requestId, { streamMode, path: 'stream_probe' });
            currentAttempt.dispose();

            finish(200, 'non-standard stream normalized to sse', {
              upstreamContentType,
              upstreamStatus: currentAttempt.response.status,
              streamMode,
              upstreamName: currentAttempt.channel.name,
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
              upstreamName: selectedChannelForLog.name,
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
          reportAttemptSuccess(upstreamAttempt, requestId, { streamMode, path: 'buffered_stream' });

          finish(200, 'buffered upstream stream returned as sse', {
            upstreamContentType,
            upstreamStatus: upstreamResponse.status,
            eventCount: sseEvents.length,
            upstreamName: selectedChannelForLog.name,
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
            reportAttemptFailure(upstreamAttempt, 'body_timeout', requestId, { phase: abortReason.phase });
            upstreamAttempt.dispose();

            if (canAttemptFallback(upstreamController.signal, upstreamAttempt.channelIndex, routeChannels, fallbackBudget)) {
              fallbackBudget.attemptsUsed += 1;
              recordFallbackReason('headers_only_timeout', selectedChannelForLog.name);
              reportAttemptFailure(upstreamAttempt, 'body_timeout', requestId, {
                phase: abortReason.phase,
                upstreamContentType,
              });
              logRequest(requestId, 'upstream body timeout, falling back', {
                phase: abortReason.phase,
                upstreamName: selectedChannelForLog.name,
                upstreamContentType,
                nextFallbackName: routeChannels[upstreamAttempt.channelIndex + 1]?.name ?? null,
              });
              upstreamAttempt = await fetchResponsesUpstream(
                requestId,
                upstreamRoute,
                upstreamBody,
                upstreamController.signal,
                streamResponse,
                fallbackBudget,
                upstreamAttempt.channelIndex + 1,
              );
              selectedChannelForLog = upstreamAttempt.channel;
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
            finish(504, 'upstream body timeout', { phase: abortReason.phase, upstreamContentType, upstreamName: selectedChannelForLog.name });
            return;
          }

          if (error instanceof Error && error.name === 'AbortError' && abortReason?.kind === 'client_disconnect') {
            finish(499, 'client disconnected while reading upstream body', {
              source: abortReason.source,
              upstreamContentType,
              upstreamName: selectedChannelForLog.name,
            });
            upstreamAttempt.dispose();
            return;
          }

          reportAttemptFailure(upstreamAttempt, 'unknown_upstream_error', requestId, { error });
          upstreamAttempt.dispose();

          if (canAttemptFallback(upstreamController.signal, upstreamAttempt.channelIndex, routeChannels, fallbackBudget)) {
            fallbackBudget.attemptsUsed += 1;
            recordFallbackReason('unknown_upstream_error', selectedChannelForLog.name);
            reportAttemptFailure(upstreamAttempt, 'unknown_upstream_error', requestId, {
              upstreamContentType,
            });
            logRequest(requestId, 'unhandled upstream body read error, falling back', {
              upstreamName: selectedChannelForLog.name,
              upstreamContentType,
              nextFallbackName: routeChannels[upstreamAttempt.channelIndex + 1]?.name ?? null,
              error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
            });
            upstreamAttempt = await fetchResponsesUpstream(
              requestId,
                upstreamRoute,
                upstreamBody,
              upstreamController.signal,
              streamResponse,
              fallbackBudget,
              upstreamAttempt.channelIndex + 1,
            );
            selectedChannelForLog = upstreamAttempt.channel;
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
          reportAttemptFailure(upstreamAttempt, 'unknown_upstream_error', requestId, { upstreamStatus: upstreamResponse.status });
          if (canAttemptFallback(upstreamController.signal, upstreamAttempt.channelIndex, routeChannels, fallbackBudget)) {
            fallbackBudget.attemptsUsed += 1;
            recordFallbackReason('unknown_upstream_error', selectedChannelForLog.name);
            reportAttemptFailure(upstreamAttempt, 'unknown_upstream_error', requestId, {
              upstreamStatus: upstreamResponse.status,
            });
            logRequest(requestId, 'upstream invalid json, falling back', {
              upstreamStatus: upstreamResponse.status,
              upstreamName: selectedChannelForLog.name,
              nextFallbackName: routeChannels[upstreamAttempt.channelIndex + 1]?.name ?? null,
            });
            upstreamAttempt.dispose();
            upstreamAttempt = await fetchResponsesUpstream(
              requestId,
              upstreamRoute,
                upstreamBody,
              upstreamController.signal,
              streamResponse,
              fallbackBudget,
              upstreamAttempt.channelIndex + 1,
            );
            selectedChannelForLog = upstreamAttempt.channel;
            continue;
          }

          sendJson(
            res,
            502,
            makeError('Upstream returned invalid JSON', 502, upstreamText.slice(0, 2000)).body,
          );
          finish(502, 'upstream invalid json', { upstreamStatus: upstreamResponse.status, upstreamName: selectedChannelForLog.name });
          upstreamAttempt.dispose();
          return;
        }

        if (!upstreamResponse.ok) {
          sendJson(res, upstreamResponse.status, normalizeErrorPayload(upstreamResponse.status, jsonPayload));
          finish(upstreamResponse.status, 'upstream json error', {
            upstreamName: selectedChannelForLog.name,
            upstreamStatus: upstreamResponse.status,
            upstreamErrorPreview:
              upstreamResponse.status >= 500
                ? JSON.stringify(normalizeErrorPayload(upstreamResponse.status, jsonPayload)).slice(0, 2000)
                : undefined,
          });
          upstreamAttempt.dispose();
          return;
        }

        observeUpstreamFailure(upstreamAttempt.controller, jsonPayload, upstreamResponse.status);
        if (isJsonRecord(jsonPayload)) extractUsageFromStreamPayload(jsonPayload, upstreamBody);
        const responseObject = coerceResponseObject(jsonPayload);
        if (!responseObject) {
          reportAttemptFailure(upstreamAttempt, 'empty_response', requestId, { upstreamStatus: upstreamResponse.status });
          if (canAttemptFallback(upstreamController.signal, upstreamAttempt.channelIndex, routeChannels, fallbackBudget)) {
            fallbackBudget.attemptsUsed += 1;
            recordFallbackReason('empty_response', selectedChannelForLog.name);
            reportAttemptFailure(upstreamAttempt, 'empty_response', requestId, {
              upstreamStatus: upstreamResponse.status,
            });
            logRequest(requestId, 'upstream json missing response object, falling back', {
              upstreamName: selectedChannelForLog.name,
              upstreamStatus: upstreamResponse.status,
              nextFallbackName: routeChannels[upstreamAttempt.channelIndex + 1]?.name ?? null,
            });
            upstreamAttempt.dispose();
            upstreamAttempt = await fetchResponsesUpstream(
              requestId,
              upstreamRoute,
                upstreamBody,
              upstreamController.signal,
              streamResponse,
              fallbackBudget,
              upstreamAttempt.channelIndex + 1,
            );
            selectedChannelForLog = upstreamAttempt.channel;
            continue;
          }

          sendJson(
            res,
            502,
            makeError('Upstream JSON did not contain a valid response object', 502, jsonPayload as JsonValue).body,
          );
          finish(502, 'upstream json missing response object', { upstreamName: selectedChannelForLog.name });
          upstreamAttempt.dispose();
          return;
        }

        const normalizedResponse = normalizeResponseObject(responseObject, requestBody);
        const usage = extractUsageMetrics(normalizedResponse);
        const hasTextOutput = hasMeaningfulResponseOutput(normalizedResponse);
        const invalid = !hasTextOutput || upstreamFailures.has(upstreamAttempt.controller);
        if (invalid) reportAttemptFailure(upstreamAttempt, !hasTextOutput ? 'empty_response' : 'unknown_upstream_error', requestId, { upstreamStatus: upstreamResponse.status });

        if (invalid && canAttemptFallback(upstreamController.signal, upstreamAttempt.channelIndex, routeChannels, fallbackBudget)) {
          const fallbackReason = !hasTextOutput ? 'empty_response' : 'stream_missing_usage';
          fallbackBudget.attemptsUsed += 1;
          recordFallbackReason(fallbackReason, selectedChannelForLog.name);
          reportAttemptFailure(upstreamAttempt, fallbackReason, requestId, {
            upstreamStatus: upstreamResponse.status,
            usageFound: Boolean(usage),
            hasTextOutput,
          });
          logRequest(requestId, 'upstream json response incomplete, falling back', {
            fallbackReason,
            upstreamContentType,
            upstreamStatus: upstreamResponse.status,
            upstreamName: selectedChannelForLog.name,
            usageFound: Boolean(usage),
            hasTextOutput,
            nextFallbackName: routeChannels[upstreamAttempt.channelIndex + 1]?.name ?? null,
          });
          upstreamAttempt.dispose();
          upstreamAttempt = await fetchResponsesUpstream(
            requestId,
              upstreamRoute,
                upstreamBody,
            upstreamController.signal,
            streamResponse,
            fallbackBudget,
            upstreamAttempt.channelIndex + 1,
          );
          selectedChannelForLog = upstreamAttempt.channel;
          continue;
        }

        if (invalid) {
          sendJson(res, 502, makeError('No upstream endpoint produced a usable response before fallback was exhausted', 502, { reason: 'fallback_exhausted' }).body);
          upstreamAttempt.dispose();
          finish(502, 'json fallback exhausted');
          return;
        }
        cacheResponse(normalizedResponse);
        addUsageToStats(usage);
        proxyStats.responsesJson += 1;
        reportAttemptSuccess(upstreamAttempt, requestId, { path: 'json_response' });
        sendJson(res, 200, normalizedResponse);
        finish(200, 'json response returned', {
          upstreamContentType,
          upstreamStatus: upstreamResponse.status,
          upstreamName: selectedChannelForLog.name,
          usage,
        });
        upstreamAttempt.dispose();
        return;
      }

      const sseEvents = parseSse(upstreamText);
      for (const event of sseEvents) {
        const payload = parseStreamPayload(event.data);
        observeUpstreamFailure(upstreamAttempt.controller, payload, upstreamResponse.status);
        extractUsageFromStreamPayload(payload, upstreamBody);
      }
      logSseDebug(requestId, sseEvents);
      const responseObject = synthesizeResponseFromEvents(sseEvents);

      if (!upstreamResponse.ok) {
        sendJson(
          res,
          upstreamResponse.status,
          normalizeErrorPayload(upstreamResponse.status, responseObject ?? upstreamText),
        );
        finish(upstreamResponse.status, 'upstream sse error', { upstreamContentType, upstreamName: selectedChannelForLog.name });
        upstreamAttempt.dispose();
        return;
      }

      if (!responseObject) {
        reportAttemptFailure(upstreamAttempt, 'sse_reconstruction_failure', requestId, { upstreamStatus: upstreamResponse.status });
        if (canAttemptFallback(upstreamController.signal, upstreamAttempt.channelIndex, routeChannels, fallbackBudget)) {
          fallbackBudget.attemptsUsed += 1;
          recordFallbackReason('sse_reconstruction_failure', selectedChannelForLog.name);
          reportAttemptFailure(upstreamAttempt, 'sse_reconstruction_failure', requestId, {
            upstreamStatus: upstreamResponse.status,
          });
          logRequest(requestId, 'failed to normalize sse payload, falling back', {
            upstreamContentType,
            upstreamStatus: upstreamResponse.status,
            upstreamName: selectedChannelForLog.name,
            nextFallbackName: routeChannels[upstreamAttempt.channelIndex + 1]?.name ?? null,
          });
          upstreamAttempt.dispose();
          upstreamAttempt = await fetchResponsesUpstream(
            requestId,
            upstreamRoute,
                upstreamBody,
            upstreamController.signal,
            streamResponse,
            fallbackBudget,
            upstreamAttempt.channelIndex + 1,
          );
          selectedChannelForLog = upstreamAttempt.channel;
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
        finish(502, 'failed to normalize sse payload', { upstreamContentType, upstreamName: selectedChannelForLog.name });
        upstreamAttempt.dispose();
        return;
      }

      const normalizedResponse = normalizeResponseObject(responseObject, requestBody);
      const usage = extractUsageMetrics(normalizedResponse);
      const hasTextOutput = hasMeaningfulResponseOutput(normalizedResponse);
      const invalid = !hasTextOutput || upstreamFailures.has(upstreamAttempt.controller);
      if (invalid) reportAttemptFailure(upstreamAttempt, !hasTextOutput ? 'empty_response' : 'unknown_upstream_error', requestId, { upstreamStatus: upstreamResponse.status });

      if (invalid && canAttemptFallback(upstreamController.signal, upstreamAttempt.channelIndex, routeChannels, fallbackBudget)) {
        const fallbackReason = !hasTextOutput ? 'empty_response' : 'stream_missing_usage';
        fallbackBudget.attemptsUsed += 1;
        recordFallbackReason(fallbackReason, selectedChannelForLog.name);
        reportAttemptFailure(upstreamAttempt, fallbackReason, requestId, {
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
          upstreamName: selectedChannelForLog.name,
          usageFound: Boolean(usage),
          hasTextOutput,
          nextFallbackName: routeChannels[upstreamAttempt.channelIndex + 1]?.name ?? null,
        });
        upstreamAttempt.dispose();
        upstreamAttempt = await fetchResponsesUpstream(
          requestId,
          upstreamRoute,
                upstreamBody,
          upstreamController.signal,
          streamResponse,
          fallbackBudget,
          upstreamAttempt.channelIndex + 1,
        );
        selectedChannelForLog = upstreamAttempt.channel;
        continue;
      }

      if (invalid) {
        sendJson(res, 502, makeError('No upstream endpoint produced a usable response before fallback was exhausted', 502, { reason: 'fallback_exhausted' }).body);
        upstreamAttempt.dispose();
        finish(502, 'sse json fallback exhausted');
        return;
      }
      cacheResponse(normalizedResponse);
      addUsageToStats(usage);
      proxyStats.responsesJson += 1;
      reportAttemptSuccess(upstreamAttempt, requestId, { path: 'sse_to_json' });
      sendJson(res, 200, normalizedResponse);
      finish(200, 'sse normalized to json', {
        upstreamContentType,
        upstreamStatus: upstreamResponse.status,
        eventCount: sseEvents.length,
        upstreamName: selectedChannelForLog.name,
        usage,
      });
      upstreamAttempt.dispose();
      return;
    }
  } catch (error) {
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

    const terminalError = classifyProxyTerminalError(error);
    sendJson(res, terminalError.statusCode, terminalError.body as JsonValue);
    finish(terminalError.statusCode, 'unhandled proxy error', {
      error: errorDetails,
    });
  } finally {
    usageContext.getStore()?.current?.finish();
    if (totalTimeout !== undefined) {
      clearTimeout(totalTimeout);
    }
    req.off('aborted', handleRequestAborted);
    res.off('close', handleResponseClosed);

    if (countedAsActive && activeRequests > 0) {
      activeRequests -= 1;
    }
  }
  }));
});



for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopUptimeSampling();
    server.close(() => {
      void _usageStore.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    });
  });
}

server.listen(_initialSnapshot.config.port, _initialSnapshot.config.host, () => {
  const c = _initialSnapshot.config;
  console.log(`Instance: ${c.instanceName}`);
  console.log(`JSON proxy listening on http://${c.host}:${c.port}`);
  console.log(`Routing config path: ${c.routingConfigPath}`);
  console.log(`Configured models: ${listConfiguredModels(c.routingConfig).join(', ')}`);
  console.log(`Configured channels: ${Array.from(c.routingConfig.channelsById.values()).map(channel => channel.name).join(', ')}`);
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
  console.log(`Claude billing header mode: ${c.claudeBillingHeaderMode}`);
  console.log(`Clear system content: ${c.clearSystemContent ? 'enabled' : 'disabled'}`);
  console.log(`Convert system to developer: ${c.convertSystemToDeveloper ? 'enabled' : 'disabled'}`);
  console.log(`Request body logging: ${c.logRequestBodies ? 'enabled' : 'disabled'}`);
  console.log(`Force store=false: ${c.forceStoreFalse ? 'enabled' : 'disabled'}`);
  console.log(`SSE debug logging: ${c.debugSse ? 'enabled' : 'disabled'}`);
  console.log(`Retryable 4xx fallback: ${c.fallbackOnRetryable4xx ? 'enabled' : 'disabled'}`);
  console.log(`Compatibility 4xx fallback: ${c.fallbackOnCompat4xx ? 'enabled' : 'disabled'}`);
  console.log(`Health window: ${c.healthWindowMs}ms; failures >= ${c.healthFailureThreshold} and rate > ${c.healthFailureRateThreshold}`);
  console.log(`Ordinary/manual cooldown: ${c.healthCooldownMs}ms`);
  console.log(`Quota-exhaustion cooldown: ${c.quotaCooldownMs}ms`);
  console.log(`Per-channel attempt limit: ${c.channelMaxAttempts}, retry delay: ${c.channelRetryDelayMs}ms`);
  console.log(`Cache-key history capacity: ${c.cacheKeyPoolSize}; strict route priority`);
  console.log(`Fallback total budget: ${c.maxFallbackTotalMs}ms`);
  console.log(
    `SSE failure capture: ${c.sseFailureDebugEnabled ? `enabled -> ${c.sseFailureDebugDir}` : 'disabled'}`,
  );
  console.log(
    `Stream missing usage capture: ${c.streamMissingUsageDebugEnabled ? `enabled -> ${c.streamMissingUsageDebugDir}` : 'disabled'}`,
  );
  triggerCompactDetection();
});
