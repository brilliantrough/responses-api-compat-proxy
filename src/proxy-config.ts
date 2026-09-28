import { resolve } from 'node:path';
import type { ClaudeBillingHeaderMode } from './responses-input-normalization.js';
import { loadRoutingConfig, type RoutingConfig } from './routing-config.js';

export type StreamMode = 'normalized' | 'raw';

export type ProxyRuntimeConfig = {
  host: string;
  port: number;
  adminAllowHost: boolean;
  instanceName: string;
  routingConfigPath: string;
  routingConfig: RoutingConfig;
  healthWindowMs: number;
  healthFailureThreshold: number;
  healthFailureRateThreshold: number;
  healthCooldownMs: number;
  channelMaxAttempts: number;
  channelRetryDelayMs: number;
  cacheKeyPoolSize: number;
  channelCooldownMs: number;
  modelChannelCooldownMs: number;
  quotaCooldownMs: number;
  channelFailureThreshold: number;
  modelChannelFailureThreshold: number;
  halfOpenMaxProbes: number;
  upstreamTimeoutMs: number;
  compactTimeoutMs: number;
  compactDetectTimeoutMs: number;
  compactDetectEnabled: boolean;
  nonStreamingRequestTimeoutMs: number;
  firstByteTimeoutMs: number;
  firstTextTimeoutMs: number;
  streamIdleTimeoutMs: number;
  totalRequestTimeoutMs: number;
  maxConcurrentRequests: number;
  maxCachedResponses: number;
  defaultStreamMode: StreamMode;
  defaultPromptCacheRetention: 'in_memory' | '24h' | null;
  defaultPromptCacheKey: string | null;
  forceStoreFalse: boolean;
  clearDeveloperContent: boolean;
  clearSystemContent: boolean;
  convertSystemToDeveloper: boolean;
  clearInstructions: boolean;
  overrideInstructionsText: string | null;
  claudeBillingHeaderMode: ClaudeBillingHeaderMode;
  logRequestBodies: boolean;
  debugSse: boolean;
  sseFailureDebugEnabled: boolean;
  sseFailureDebugDir: string;
  streamMissingUsageDebugEnabled: boolean;
  streamMissingUsageDebugDir: string;
  fallbackOnRetryable4xx: boolean;
  fallbackOnCompat4xx: boolean;
  compatFallbackPatterns: string[];
  clientErrorPatterns: string[];
  blockedUaKeywords: string[];
  maxFallbackTotalMs: number;
};

export function isEnabled(value: string | undefined, defaultValue = false) {
  if (value === undefined) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export const routingPolicyDefaults = {
  PROXY_HEALTH_WINDOW_MS: '180000',
  PROXY_HEALTH_FAILURE_THRESHOLD: '15',
  PROXY_HEALTH_FAILURE_RATE_THRESHOLD: '0.5',
  PROXY_HEALTH_COOLDOWN_MS: '600000',
  PROXY_CHANNEL_MAX_ATTEMPTS: '3',
  PROXY_CHANNEL_RETRY_DELAY_MS: '500',
  PROXY_CACHE_KEY_POOL_SIZE: '100',
  PROXY_QUOTA_COOLDOWN_MS: '7200000',
};

export function readRoutingPolicyConfig(env: NodeJS.ProcessEnv) {
  const number = (key: keyof typeof routingPolicyDefaults, min = 1, fraction = false) => {
    const value = Number(env[key] ?? routingPolicyDefaults[key]);
    if (!Number.isFinite(value) || value < min || (fraction ? value >= 1 : !Number.isSafeInteger(value))) {
      throw new Error(`${key} must be ${fraction ? 'a number >= 0 and < 1' : `an integer >= ${min}`}`);
    }
    return value;
  };
  return {
    healthWindowMs: number('PROXY_HEALTH_WINDOW_MS'),
    healthFailureThreshold: number('PROXY_HEALTH_FAILURE_THRESHOLD'),
    healthFailureRateThreshold: number('PROXY_HEALTH_FAILURE_RATE_THRESHOLD', 0, true),
    healthCooldownMs: number('PROXY_HEALTH_COOLDOWN_MS'),
    channelMaxAttempts: number('PROXY_CHANNEL_MAX_ATTEMPTS'),
    channelRetryDelayMs: number('PROXY_CHANNEL_RETRY_DELAY_MS', 0),
    cacheKeyPoolSize: number('PROXY_CACHE_KEY_POOL_SIZE'),
    quotaCooldownMs: number('PROXY_QUOTA_COOLDOWN_MS'),
  };
}

export function parseEnvList(value: string | undefined, fallback: string[]) {
  if (value === undefined) {
    return fallback;
  }

  const items = value
    .split(/[\n,]/)
    .map(item => item.trim().toLowerCase())
    .filter(item => item.length > 0);

  return items.length > 0 ? items : fallback;
}

export function parsePromptCacheRetention(value: string | undefined): 'in_memory' | '24h' | null {
  if (value === undefined) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '') {
    return null;
  }

  if (normalized === 'in_memory') {
    return 'in_memory';
  }

  if (normalized === '24h') {
    return '24h';
  }

  console.warn(
    `Ignoring unsupported PROXY_PROMPT_CACHE_RETENTION value ${JSON.stringify(value)}; expected "in_memory" or "24h"`,
  );
  return null;
}

export function parseClaudeBillingHeaderMode(value: string | undefined): ClaudeBillingHeaderMode {
  if (value === undefined || value.trim() === '') {
    return 'strip_line';
  }

  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'strip_line' || normalized === 'strip_cch') {
    return normalized;
  }

  console.warn(
    `Ignoring unsupported PROXY_CLAUDE_BILLING_HEADER_MODE value ${JSON.stringify(value)}; expected "strip_line" or "strip_cch"`,
  );
  return 'strip_line';
}

export const defaultCompatFallbackPatterns = [
  'model not found',
  'unsupported model',
  'not configured model',
  '未配置模型',
  'invalid_workspace_selected',
  'invalid workspace selected',
  '不允许使用余额',
  '无可用套餐',
  '令牌权限',
  'token permission',
  'insufficient balance',
  'no available package',
  'daily quota exceeded',
  'quota exhausted',
  'credit exhausted',
  'billing required',
  'model is not available',
  'does not support',
  'not supported',
  'unsupported parameter',
  'unknown field',
  'store must be false',
  'reasoning not supported',
  'tool calling not supported',
  'response format not supported',
  'invalid for this provider',
  'this endpoint only supports',
  'rate limit',
  'quota exceeded',
  'temporarily unavailable',
  'try again later',
  'disallowed ip address',
  'local or disallowed ip address',
  "dns records resolve to a local",
  'dns resolution failed',
  'dns lookup failed',
  'upstream unavailable',
  'origin unreachable',
  'host unreachable',
];

export const defaultClientErrorPatterns = [
  'maximum context length',
  'context length exceeded',
  'too many input tokens',
  'input too large',
  'prompt is too long',
  'tool schema is invalid',
  'invalid tool schema',
  'json schema is invalid',
  'invalid response_format',
  'response_format is invalid',
  'unsupported response_format type',
];

export function createProxyRuntimeConfig(env: NodeJS.ProcessEnv = process.env): ProxyRuntimeConfig {
  const host = env.HOST ?? '0.0.0.0';
  const port = Number(env.PORT ?? 11234);
  const adminAllowHost = isEnabled(env.PROXY_ADMIN_ALLOW_HOST);
  if (adminAllowHost) {
    console.warn(
      'PROXY_ADMIN_ALLOW_HOST is enabled: /admin endpoints will accept non-localhost requests. Keep the published port bound to a trusted host or add external protection.',
    );
  }
  const instanceName = env.INSTANCE_NAME ?? `responses-proxy-${port}`;
  const routingConfigPath = resolve(env.FALLBACK_CONFIG_PATH ?? 'fallback.json');
  const routingConfig = loadRoutingConfig(routingConfigPath);

  if (
    env.PRIMARY_PROVIDER_NAME !== undefined ||
    env.PRIMARY_PROVIDER_BASE_URL !== undefined ||
    env.PRIMARY_PROVIDER_API_KEY !== undefined ||
    env.PRIMARY_PROVIDER_DEFAULT_MODEL !== undefined
  ) {
    console.warn('PRIMARY_PROVIDER_* environment variables are ignored; configure channels and models in the routing config');
  }

  const policy = readRoutingPolicyConfig(env);
  const legacyHealthKeys = ['PROXY_CHANNEL_COOLDOWN_MS', 'PROXY_MODEL_CHANNEL_COOLDOWN_MS', 'PROXY_CHANNEL_FAILURE_THRESHOLD', 'PROXY_MODEL_CHANNEL_FAILURE_THRESHOLD', 'PROXY_HALF_OPEN_MAX_PROBES'].filter(key => env[key] !== undefined);
  if (legacyHealthKeys.length) console.warn(`Legacy health settings ignored: ${legacyHealthKeys.join(', ')}; use PROXY_HEALTH_* rolling-window settings`);
  // Legacy response fields remain readable by older admin assets; old env knobs no longer govern routing.
  const channelCooldownMs = policy.healthCooldownMs;
  const modelChannelCooldownMs = policy.healthCooldownMs;
  const channelFailureThreshold = policy.healthFailureThreshold;
  const modelChannelFailureThreshold = policy.healthFailureThreshold;
  const halfOpenMaxProbes = 0;
  const upstreamTimeoutMs = Number(env.PROXY_UPSTREAM_TIMEOUT_MS ?? 8000);
  const compactTimeoutMs = Number(env.PROXY_COMPACT_TIMEOUT_MS ?? 300000);
  const compactDetectTimeoutMs = Number(env.PROXY_COMPACT_DETECT_TIMEOUT_MS ?? 45000);
  const compactDetectEnabled = isEnabled(env.PROXY_COMPACT_DETECT_ENABLED, true);
  const nonStreamingRequestTimeoutMs = Number(env.PROXY_NON_STREAM_TIMEOUT_MS ?? 20000);
  const firstByteTimeoutMs = Number(env.PROXY_FIRST_BYTE_TIMEOUT_MS ?? 8000);
  const firstTextTimeoutMs = Number(env.PROXY_FIRST_TEXT_TIMEOUT_MS ?? 0);
  const streamIdleTimeoutMs = Number(env.PROXY_STREAM_IDLE_TIMEOUT_MS ?? 15000);
  const totalRequestTimeoutMs = Number(env.PROXY_TOTAL_REQUEST_TIMEOUT_MS ?? 45000);
  const maxConcurrentRequests = Number(env.PROXY_MAX_CONCURRENT_REQUESTS ?? 512);
  const maxCachedResponses = Number(env.PROXY_MAX_CACHED_RESPONSES ?? 200);
  const defaultStreamMode = String(env.PROXY_STREAM_MODE ?? 'normalized').toLowerCase() === 'raw' ? 'raw' : 'normalized';
  const defaultPromptCacheRetention = parsePromptCacheRetention(env.PROXY_PROMPT_CACHE_RETENTION);
  const defaultPromptCacheKey = env.PROXY_PROMPT_CACHE_KEY?.trim() || null;
  const forceStoreFalse = isEnabled(env.PROXY_FORCE_STORE_FALSE);
  const clearDeveloperContent = isEnabled(env.PROXY_CLEAR_DEVELOPER_CONTENT);
  const clearSystemContent = isEnabled(env.PROXY_CLEAR_SYSTEM_CONTENT);
  const convertSystemToDeveloper = isEnabled(env.PROXY_CONVERT_SYSTEM_TO_DEVELOPER, true);
  const clearInstructions = isEnabled(env.PROXY_CLEAR_INSTRUCTIONS);
  const overrideInstructionsText = env.PROXY_OVERRIDE_INSTRUCTIONS_TEXT ?? null;
  const claudeBillingHeaderMode = parseClaudeBillingHeaderMode(env.PROXY_CLAUDE_BILLING_HEADER_MODE);
  const logRequestBodies = isEnabled(env.PROXY_LOG_REQUEST_BODY);
  const debugSse = isEnabled(env.PROXY_DEBUG_SSE);
  const sseFailureDebugEnabled = isEnabled(env.PROXY_SSE_FAILURE_DEBUG);
  const sseFailureDebugDir = env.PROXY_SSE_FAILURE_DIR ?? `captures/${instanceName}/sse-failures`;
  const streamMissingUsageDebugEnabled = isEnabled(env.PROXY_STREAM_MISSING_USAGE_DEBUG);
  const streamMissingUsageDebugDir = env.PROXY_STREAM_MISSING_USAGE_DIR ?? `captures/${instanceName}/stream/missing-usage`;
  const fallbackOnRetryable4xx = isEnabled(env.PROXY_FALLBACK_ON_RETRYABLE_4XX, true);
  const fallbackOnCompat4xx = isEnabled(env.PROXY_FALLBACK_ON_COMPAT_4XX, true);
  const compatFallbackPatterns = parseEnvList(env.PROXY_FALLBACK_COMPAT_PATTERNS, defaultCompatFallbackPatterns);
  const clientErrorPatterns = parseEnvList(
    env.PROXY_NO_FALLBACK_CLIENT_ERROR_PATTERNS ?? env.PROXY_FALLBACK_CLIENT_ERROR_PATTERNS,
    defaultClientErrorPatterns,
  );
  const blockedUaKeywords = parseEnvList(env.PROXY_BLOCKED_UA_KEYWORDS, []);
  const maxFallbackTotalMs = Number(env.PROXY_MAX_FALLBACK_TOTAL_MS ?? 30000);

  return {
    host,
    port,
    adminAllowHost,
    instanceName,
    routingConfigPath,
    routingConfig,
    ...policy,
    channelCooldownMs,
    modelChannelCooldownMs,
    channelFailureThreshold,
    modelChannelFailureThreshold,
    halfOpenMaxProbes,
    upstreamTimeoutMs,
    compactTimeoutMs,
    compactDetectTimeoutMs,
    compactDetectEnabled,
    nonStreamingRequestTimeoutMs,
    firstByteTimeoutMs,
    firstTextTimeoutMs,
    streamIdleTimeoutMs,
    totalRequestTimeoutMs,
    maxConcurrentRequests,
    maxCachedResponses,
    defaultStreamMode,
    defaultPromptCacheRetention,
    defaultPromptCacheKey,
    forceStoreFalse,
    clearDeveloperContent,
    clearSystemContent,
    convertSystemToDeveloper,
    clearInstructions,
    overrideInstructionsText,
    claudeBillingHeaderMode,
    logRequestBodies,
    debugSse,
    sseFailureDebugEnabled,
    sseFailureDebugDir,
    streamMissingUsageDebugEnabled,
    streamMissingUsageDebugDir,
    fallbackOnRetryable4xx,
    fallbackOnCompat4xx,
    compatFallbackPatterns,
    clientErrorPatterns,
    blockedUaKeywords,
    maxFallbackTotalMs,
  };
}
