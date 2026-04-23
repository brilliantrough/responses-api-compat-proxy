import { isJsonRecord, type JsonRecord, type JsonValue } from './responses-input-normalization.js';
import { parseSse, parseStreamPayload, synthesizeResponseFromEvents } from './responses-sse.js';

export type FallbackReason =
  | 'upstream_5xx'
  | 'retryable_4xx'
  | 'compat_4xx'
  | 'unknown_upstream_error'
  | 'headers_only_timeout'
  | 'stream_no_text_content'
  | 'stream_missing_usage'
  | 'empty_response'
  | 'sse_reconstruction_failure'
  | 'proxy_unhandled_error';

type TimeoutAbortReason = {
  kind: 'timeout';
  phase: 'connect' | 'first-byte' | 'first-text' | 'idle' | 'total';
};

type ClientDisconnectAbortReason = {
  kind: 'client_disconnect';
  source: 'request' | 'response';
};

type ProxyAbortReason = TimeoutAbortReason | ClientDisconnectAbortReason;

type ProxyTerminalErrorLike = {
  abortReason?: unknown;
  endpoint?: unknown;
  error?: unknown;
};

function isProxyAbortReason(value: unknown): value is ProxyAbortReason {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }

  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'timeout') {
    const phase = (value as { phase?: unknown }).phase;
    return ['connect', 'first-byte', 'first-text', 'idle', 'total'].includes(String(phase));
  }

  if (kind === 'client_disconnect') {
    const source = (value as { source?: unknown }).source;
    return source === 'request' || source === 'response';
  }

  return false;
}

function extractEndpointSummary(endpoint: unknown) {
  if (typeof endpoint !== 'object' || endpoint === null) {
    return undefined;
  }

  const maybe = endpoint as { name?: unknown; url?: unknown };
  if (typeof maybe.name === 'string' || typeof maybe.url === 'string') {
    return {
      ...(typeof maybe.name === 'string' ? { name: maybe.name } : {}),
      ...(typeof maybe.url === 'string' ? { url: maybe.url } : {}),
    } as JsonRecord;
  }

  return undefined;
}

export function classifyProxyTerminalError(error: unknown) {
  const maybe = (typeof error === 'object' && error !== null ? error as ProxyTerminalErrorLike : undefined);
  const abortReason = isProxyAbortReason(maybe?.abortReason) ? maybe?.abortReason : undefined;
  const endpoint = extractEndpointSummary(maybe?.endpoint);

  if (abortReason?.kind === 'timeout') {
    return {
      statusCode: 504,
      body: normalizeErrorPayload(504, {
        error: {
          message: 'No upstream endpoint produced a usable response before fallback was exhausted',
          type: 'server_error',
          details: {
            reason: 'fallback_exhausted',
            abortReason,
            ...(endpoint ? { endpoint } : {}),
          },
        },
      }),
    };
  }

  if (error instanceof Error) {
    return {
      statusCode: 500,
      body: normalizeErrorPayload(500, {
        error: {
          message: error.message,
          type: 'server_error',
        },
      }),
    };
  }

  return {
    statusCode: 500,
    body: normalizeErrorPayload(500, {
      error: {
        message: 'Unknown proxy error',
        type: 'server_error',
      },
    }),
  };
}

export function normalizeErrorPayload(status: number, payload: unknown) {
  const errorType = status >= 500 ? 'server_error' : 'invalid_request_error';

  if (isJsonRecord(payload)) {
    if (isJsonRecord(payload.error)) {
      return payload;
    }

    if (typeof payload.error === 'string') {
      return {
        error: {
          message: payload.error,
          type: errorType,
        },
      };
    }

    if (typeof payload.detail === 'string') {
      return {
        error: {
          message: payload.detail,
          type: errorType,
        },
      };
    }
  }

  const errorBody: JsonRecord = {
    message: 'Upstream request failed',
    type: errorType,
  };

  if (payload !== undefined) {
    errorBody.details = payload as JsonValue;
  }

  return {
    error: errorBody,
  };
}

export function extractErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!isJsonRecord(payload)) {
    return undefined;
  }

  if (typeof payload.message === 'string' && payload.message.trim().length > 0) {
    return payload.message.trim();
  }

  if (typeof payload.detail === 'string' && payload.detail.trim().length > 0) {
    return payload.detail.trim();
  }

  if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
    return payload.error.trim();
  }

  if (isJsonRecord(payload.error) && typeof payload.error.message === 'string' && payload.error.message.trim().length > 0) {
    return payload.error.message.trim();
  }

  if (isJsonRecord(payload.response)) {
    return extractErrorMessage(payload.response);
  }

  return undefined;
}

export function parseBestEffortErrorPayload(text: string, contentType: string) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to stream/text handling.
  }

  const events = parseSse(text);
  if (events.length > 0) {
    for (const event of events) {
      if (!event.data) {
        continue;
      }

      const payload = parseStreamPayload(event.data);
      if (payload !== undefined) {
        if (isJsonRecord(payload) && isJsonRecord(payload.response)) {
          return payload.response;
        }

        return payload;
      }
    }

    const responseObject = synthesizeResponseFromEvents(events);
    if (responseObject) {
      return responseObject;
    }

    const firstNonEmptyData = events.find(event => event.data.trim().length > 0)?.data.trim();
    return firstNonEmptyData ?? text;
  }

  return text;
}

function extractWrappedUpstreamStatus(message: string) {
  const match = message.match(/all\s+\d+\s+attempts\s+failed:\s+http\s+(\d{3})\b/i);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function matchesAnyPattern(message: string | undefined, patterns: string[]) {
  if (!message) {
    return false;
  }

  return patterns.some(pattern => pattern.length > 0 && message.includes(pattern));
}

export function getUpstreamFallbackReason(
  status: number,
  payload: unknown,
  options: {
    fallbackOnRetryable4xx: boolean;
    fallbackOnCompat4xx: boolean;
    compatFallbackPatterns: string[];
    clientErrorPatterns: string[];
  },
): FallbackReason | undefined {
  const message = extractErrorMessage(payload)?.toLowerCase();
  const wrappedStatus = message ? extractWrappedUpstreamStatus(message) : undefined;

  if (status >= 500) {
    return 'upstream_5xx';
  }

  if (typeof wrappedStatus === 'number') {
    if (wrappedStatus >= 500) {
      return 'upstream_5xx';
    }

    if (options.fallbackOnRetryable4xx && [408, 409, 423, 425, 429].includes(wrappedStatus)) {
      return 'retryable_4xx';
    }

    if (wrappedStatus >= 400 && wrappedStatus < 500) {
      return 'compat_4xx';
    }
  }

  if (status >= 400 && status < 500) {
    if (options.fallbackOnRetryable4xx && [408, 409, 423, 425, 429].includes(status)) {
      return 'retryable_4xx';
    }

    if ([401, 403].includes(status)) {
      return 'compat_4xx';
    }

    if (matchesAnyPattern(message, options.clientErrorPatterns)) {
      return undefined;
    }

    if (!options.fallbackOnCompat4xx) {
      return undefined;
    }

    if (matchesAnyPattern(message, options.compatFallbackPatterns)) {
      return 'compat_4xx';
    }

    return 'compat_4xx';
  }

  return undefined;
}

export function isQuotaLikeCompatError(status: number, payload: unknown) {
  if (status !== 403) {
    return false;
  }

  const message = extractErrorMessage(payload)?.toLowerCase();
  if (!message) {
    return false;
  }

  return [
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
    'disallowed ip address',
    'local or disallowed ip address',
    'dns records resolve to a local',
    'dns resolution failed',
    'dns lookup failed',
    'upstream unavailable',
    'origin unreachable',
    'host unreachable',
  ].some(pattern => message.includes(pattern));
}
