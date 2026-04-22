import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type StreamMode = 'normalized' | 'raw';

export type UpstreamEndpoint = {
  name: string;
  url: string;
  apiKey: string;
  isFallback: boolean;
};

export type ProxyRuntimeConfig = {
  host: string;
  port: number;
  adminAllowHost: boolean;
  instanceName: string;
  primaryProviderName: string;
  primaryProviderBaseUrl: string;
  apiKey: string;
  upstreamUrl: string;
  upstreamModelsUrl: string;
  fallbackConfigPath: string;
  modelMappingPath: string;
  defaultModel: string;
  modelMappings: Record<string, string>;
  upstreamTimeoutMs: number;
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
  endpointTimeoutCooldownMs: number;
  endpointInvalidResponseCooldownMs: number;
  endpointAuthCooldownMs: number;
  endpointFailureThreshold: number;
  endpointHalfOpenMaxProbes: number;
  maxFallbackAttempts: number;
  maxFallbackTotalMs: number;
  primaryEndpoint: UpstreamEndpoint;
  fallbackEndpoints: UpstreamEndpoint[];
  responsesEndpoints: UpstreamEndpoint[];
};

type FallbackConfigFile = {
  fallback_api_config?: unknown;
};

type ModelMappingsFile = {
  model_mappings?: unknown;
};

type FallbackApiConfig = {
  name: string;
  base_url: string;
  api_key?: string;
  api_key_env?: string;
};

export function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

export function isEnabled(value: string | undefined, defaultValue = false) {
  if (value === undefined) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
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

function isFallbackApiConfig(value: unknown): value is FallbackApiConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'base_url' in value &&
    typeof value.name === 'string' &&
    typeof value.base_url === 'string' &&
    ((('api_key' in value) && typeof value.api_key === 'string') ||
      (('api_key_env' in value) && typeof value.api_key_env === 'string'))
  );
}

function resolveFallbackApiKey(item: FallbackApiConfig, env: NodeJS.ProcessEnv) {
  if (typeof item.api_key === 'string' && item.api_key.length > 0) {
    return item.api_key;
  }

  if (typeof item.api_key_env === 'string' && item.api_key_env.length > 0) {
    return env[item.api_key_env];
  }

  return undefined;
}

function loadFallbackEndpoints(fallbackConfigPath: string, env: NodeJS.ProcessEnv) {
  try {
    const raw = readFileSync(fallbackConfigPath, 'utf8');
    const parsed = JSON.parse(raw) as FallbackConfigFile;

    if (!Array.isArray(parsed.fallback_api_config)) {
      return [] as UpstreamEndpoint[];
    }

    return parsed.fallback_api_config
      .filter(isFallbackApiConfig)
      .flatMap(item => {
        const resolvedApiKey = resolveFallbackApiKey(item, env);

        if (!resolvedApiKey) {
          console.warn(
            `Skipping fallback '${item.name}' from ${fallbackConfigPath}: missing api_key or unresolved api_key_env`,
          );
          return [] as UpstreamEndpoint[];
        }

        return [
          {
            name: item.name,
            url: `${normalizeBaseUrl(item.base_url)}/v1/responses`,
            apiKey: resolvedApiKey,
            isFallback: true,
          },
        ];
      });
  } catch (error) {
    console.warn(
      `Failed to load fallback API config from ${fallbackConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [] as UpstreamEndpoint[];
  }
}

function normalizeModelMappings(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {} as Record<string, string>;
  }

  const mappings: Record<string, string> = {};
  for (const [alias, target] of Object.entries(value)) {
    if (typeof target !== 'string') {
      continue;
    }

    const normalizedAlias = alias.trim();
    const normalizedTarget = target.trim();
    if (normalizedAlias.length === 0 || normalizedTarget.length === 0) {
      continue;
    }

    mappings[normalizedAlias] = normalizedTarget;
  }

  return mappings;
}

function loadModelMappings(modelMappingPath: string) {
  try {
    const raw = readFileSync(modelMappingPath, 'utf8');
    const parsed = JSON.parse(raw) as ModelMappingsFile | Record<string, unknown>;
    const mappingSource =
      typeof parsed === 'object' && parsed !== null && 'model_mappings' in parsed
        ? parsed.model_mappings
        : parsed;

    return normalizeModelMappings(mappingSource);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {} as Record<string, string>;
    }

    console.warn(
      `Failed to load model mapping config from ${modelMappingPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {} as Record<string, string>;
  }
}

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
  const primaryProviderName = env.PRIMARY_PROVIDER_NAME ?? 'primary-provider';
  const primaryProviderBaseUrl = normalizeBaseUrl(env.PRIMARY_PROVIDER_BASE_URL ?? 'https://primary.example');
  const apiKey = env.PRIMARY_PROVIDER_API_KEY;

  if (!apiKey) {
    throw new Error('Missing PRIMARY_PROVIDER_API_KEY in .env');
  }

  const upstreamUrl = `${primaryProviderBaseUrl}/v1/responses`;
  const upstreamModelsUrl = `${primaryProviderBaseUrl}/v1/models`;
  const fallbackConfigPath = resolve(env.FALLBACK_CONFIG_PATH ?? 'config.json');
  const modelMappingPath = resolve(env.MODEL_MAP_PATH ?? 'model-map.json');
  const defaultModel = env.PRIMARY_PROVIDER_DEFAULT_MODEL ?? 'my-model-v2';
  const upstreamTimeoutMs = Number(env.PROXY_UPSTREAM_TIMEOUT_MS ?? 8000);
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
  const endpointTimeoutCooldownMs = Number(env.PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS ?? 120000);
  const endpointInvalidResponseCooldownMs = Number(env.PROXY_ENDPOINT_INVALID_RESPONSE_COOLDOWN_MS ?? 120000);
  const endpointAuthCooldownMs = Number(env.PROXY_ENDPOINT_AUTH_COOLDOWN_MS ?? 1800000);
  const endpointFailureThreshold = Number(env.PROXY_ENDPOINT_FAILURE_THRESHOLD ?? 1);
  const endpointHalfOpenMaxProbes = Number(env.PROXY_ENDPOINT_HALF_OPEN_MAX_PROBES ?? 1);

  const primaryEndpoint: UpstreamEndpoint = {
    name: primaryProviderName,
    url: upstreamUrl,
    apiKey,
    isFallback: false,
  };

  const fallbackEndpoints = loadFallbackEndpoints(fallbackConfigPath, env);
  const modelMappings = loadModelMappings(modelMappingPath);
  const responsesEndpoints = [primaryEndpoint, ...fallbackEndpoints];
  const maxFallbackAttempts = Number(env.PROXY_MAX_FALLBACK_ATTEMPTS ?? Math.max(1, fallbackEndpoints.length));
  const maxFallbackTotalMs = Number(env.PROXY_MAX_FALLBACK_TOTAL_MS ?? 30000);

  return {
    host,
    port,
    adminAllowHost,
    instanceName,
    primaryProviderName,
    primaryProviderBaseUrl,
    apiKey,
    upstreamUrl,
    upstreamModelsUrl,
    fallbackConfigPath,
    modelMappingPath,
    defaultModel,
    modelMappings,
    upstreamTimeoutMs,
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
    endpointTimeoutCooldownMs,
    endpointInvalidResponseCooldownMs,
    endpointAuthCooldownMs,
    endpointFailureThreshold,
    endpointHalfOpenMaxProbes,
    maxFallbackAttempts,
    maxFallbackTotalMs,
    primaryEndpoint,
    fallbackEndpoints,
    responsesEndpoints,
  };
}
