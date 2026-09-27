import { classifyHealthDecision, type FailureEvidence, type HealthRegistry } from './channel-health.js';
import type { ProxyRuntimeConfig } from './proxy-config.js';
import { extractErrorMessage } from './responses-errors.js';
import type { JsonRecord, JsonValue } from './responses-input-normalization.js';
import type { ChannelConfig } from './routing-config.js';

export type TimeoutAbortReason = Readonly<{ kind: 'timeout'; phase: 'connect' | 'total' }>;
type ClientAbortReason = Readonly<{ kind: 'client_disconnect'; source: 'request' | 'response' }>;
export type CompactAbortReason = TimeoutAbortReason | ClientAbortReason;

type LinkedAbortController = Readonly<{
  controller: AbortController;
  dispose: () => void;
}>;

export type CompactProxyDependencies = Readonly<{
  getConfig: () => ProxyRuntimeConfig;
  healthRegistry: HealthRegistry;
  fetchWithTimeout: (
    url: string,
    init: RequestInit,
    controller: AbortController,
    connectTimeoutMs: number,
  ) => Promise<Response>;
  createLinkedAbortController: (parentSignal: AbortSignal) => LinkedAbortController;
  closeResponseBody: (response: Response) => Promise<void>;
}>;

export type CompactProxyResult =
  | Readonly<{
      kind: 'success';
      body: JsonRecord;
      status: number;
      usage?: JsonRecord;
      attempts: number;
      channel: ChannelConfig;
    }>
  | Readonly<{
      kind: 'upstream_error';
      status: number;
      body: JsonValue;
      attempts: number;
      channel: ChannelConfig;
    }>
  | Readonly<{ kind: 'all_unavailable'; retryAfterMs: number }>
  | Readonly<{
      kind: 'fallback_exhausted';
      status: 502 | 504;
      attempts: number;
      details: JsonRecord;
    }>
  | Readonly<{ kind: 'client_disconnect'; source: 'request' | 'response' }>;

export function readCompactAbortReason(signal: AbortSignal): CompactAbortReason | undefined {
  const value: unknown = signal.reason;
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return undefined;
  }
  if (value.kind === 'timeout' && 'phase' in value && (value.phase === 'connect' || value.phase === 'total')) {
    return { kind: 'timeout', phase: value.phase };
  }
  if (value.kind === 'client_disconnect' && 'source' in value && (value.source === 'request' || value.source === 'response')) {
    return { kind: 'client_disconnect', source: value.source };
  }
  return undefined;
}

export function normalizeCompactBody(
  body: JsonRecord,
  canonicalModel: string,
  config: ProxyRuntimeConfig,
): JsonRecord {
  return {
    ...body,
    model: canonicalModel,
    ...(!Object.hasOwn(body, 'prompt_cache_retention') && config.defaultPromptCacheRetention !== null
      ? { prompt_cache_retention: config.defaultPromptCacheRetention }
      : {}),
    ...(!Object.hasOwn(body, 'prompt_cache_key') && config.defaultPromptCacheKey !== null
      ? { prompt_cache_key: config.defaultPromptCacheKey }
      : {}),
  };
}

export function clientErrorMatches(payload: unknown, patterns: readonly string[]): boolean {
  const message = extractErrorMessage(payload)?.toLowerCase();
  return message !== undefined && patterns.some(pattern => pattern.length > 0 && message.includes(pattern));
}

export function completeCompactFailure(
  healthRegistry: HealthRegistry,
  lease: Parameters<HealthRegistry['complete']>[0],
  evidence: FailureEvidence,
  override?: Readonly<{ scope: 'channel' | 'model_channel' | 'none'; reason: string; channelReachabilityProven: boolean }>,
): void {
  const classified = classifyHealthDecision(evidence);
  const decision = classified.reason === 'quota_exhausted' ? classified : override ?? classified;
  healthRegistry.complete(lease, {
    scope: decision.scope,
    success: false,
    reason: decision.reason,
    channelReachabilityProven: decision.channelReachabilityProven,
  });
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => toJsonValue(item));
  }
  if (typeof value === 'object') {
    const record: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      record[key] = toJsonValue(entry);
    }
    return record;
  }
  return String(value);
}

const SECRET_FIELD_NAMES = new Set([
  'api_key',
  'apikey',
  'authorization',
  'bearer',
  'password',
  'secret',
  'token',
  'x-api-key',
]);

function isSecretField(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll('-', '_');
  return SECRET_FIELD_NAMES.has(normalized) || normalized.endsWith('_token') || normalized.endsWith('_secret');
}

export function redactCompactDetails(value: unknown, apiKey: string): JsonValue {
  if (typeof value === 'string') {
    return value.replaceAll(apiKey, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 300);
  }
  if (Array.isArray(value)) {
    return value.map(item => redactCompactDetails(item, apiKey));
  }
  if (typeof value === 'object' && value !== null) {
    const record: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      record[key] = isSecretField(key) ? '[redacted]' : redactCompactDetails(entry, apiKey);
    }
    return record;
  }
  return toJsonValue(value);
}

export function compactFallbackDetails(
  channel: ChannelConfig | undefined,
  reason: string,
  attempts: number,
  extra?: unknown,
): JsonRecord {
  return {
    reason: 'fallback_exhausted',
    lastFailure: reason,
    attempts,
    ...(channel === undefined ? {} : { channel: { id: channel.id, name: channel.name } }),
    ...(extra === undefined ? {} : { details: toJsonValue(extra) }),
  };
}
