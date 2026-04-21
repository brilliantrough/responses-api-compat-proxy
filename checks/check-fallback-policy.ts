import assert from 'node:assert/strict';

import {
  getUpstreamFallbackReason,
  isQuotaLikeCompatError,
  normalizeErrorPayload,
  parseBestEffortErrorPayload,
} from '../src/responses-errors.js';

const options = {
  fallbackOnRetryable4xx: true,
  fallbackOnCompat4xx: true,
  compatFallbackPatterns: [
    'unsupported model',
    'store must be false',
    'try again later',
    'invalid_workspace_selected',
    '不允许使用余额',
    '无可用套餐',
    'disallowed ip address',
    'local or disallowed ip address',
    'dns records resolve to a local',
  ],
  clientErrorPatterns: ['maximum context length', 'invalid tool schema', 'json schema is invalid'],
};

function main() {
  assert.equal(getUpstreamFallbackReason(500, { error: 'boom' }, options), 'upstream_5xx');
  assert.equal(getUpstreamFallbackReason(429, { error: 'rate limited' }, options), 'retryable_4xx');
  assert.equal(
    getUpstreamFallbackReason(422, { error: { message: 'unsupported model for this provider' } }, options),
    'compat_4xx',
  );
  assert.equal(
    getUpstreamFallbackReason(400, { error: { message: 'invalid value for input[0]' } }, options),
    'compat_4xx',
  );
  assert.equal(
    getUpstreamFallbackReason(400, { error: { message: 'maximum context length exceeded for this model' } }, options),
    undefined,
  );
  assert.equal(
    getUpstreamFallbackReason(
      400,
      {
        error: {
          message: 'all 10 attempts failed: HTTP 500: {"error":{"message":"没有可用token"}}',
        },
      },
      options,
    ),
    'upstream_5xx',
  );
  assert.equal(
    getUpstreamFallbackReason(
      400,
      {
        error: {
          message: 'all 3 attempts failed: HTTP 429: {"error":{"message":"rate limit"}}',
        },
      },
      options,
    ),
    'retryable_4xx',
  );
  assert.equal(
    getUpstreamFallbackReason(
      400,
      {
        error: {
          message: 'all 10 attempts failed: HTTP 403: {"error":{"code":"invalid_workspace_selected"}}',
        },
      },
      options,
    ),
    'compat_4xx',
  );
  assert.equal(
    getUpstreamFallbackReason(
      403,
      {
        error: {
          message: 'API Key 不允许使用余额且无可用套餐，请前往令牌管理界面修改令牌权限',
        },
      },
      options,
    ),
    'compat_4xx',
  );
  assert.equal(
    isQuotaLikeCompatError(403, {
      error: {
        message: 'API Key 不允许使用余额且无可用套餐，请前往令牌管理界面修改令牌权限',
      },
    }),
    true,
  );
  assert.equal(
    isQuotaLikeCompatError(403, {
      error: {
        message: 'forbidden: permission denied for this token',
      },
    }),
    false,
  );
  assert.equal(
    getUpstreamFallbackReason(
      403,
      {
        error: {
          message: "The domain's DNS records resolve to a local or disallowed IP address.",
        },
      },
      options,
    ),
    'compat_4xx',
  );
  assert.equal(
    isQuotaLikeCompatError(403, {
      error: {
        message: "The domain's DNS records resolve to a local or disallowed IP address.",
      },
    }),
    true,
  );
  assert.equal(
    getUpstreamFallbackReason(
      403,
      {
        error: {
          message: 'forbidden: permission denied for this token',
        },
      },
      {
        ...options,
        clientErrorPatterns: [...options.clientErrorPatterns, 'forbidden', 'permission denied'],
      },
    ),
    'compat_4xx',
  );

  const ssePayload = parseBestEffortErrorPayload([
    'event: error',
    'data: {"error":{"message":"store must be false","type":"invalid_request_error"}}',
    '',
  ].join('\n'), 'text/event-stream');
  assert.deepEqual(normalizeErrorPayload(400, ssePayload), {
    error: {
      message: 'store must be false',
      type: 'invalid_request_error',
    },
  });
  assert.equal(getUpstreamFallbackReason(400, ssePayload, options), 'compat_4xx');

  console.log('Fallback policy checks passed.');
}

main();
