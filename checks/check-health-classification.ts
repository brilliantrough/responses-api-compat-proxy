import assert from 'node:assert/strict';

import {
  classifyHealthDecision,
  type FailureEvidence,
  type HealthDecision,
} from '../src/channel-health.js';

type ClassificationCase = Readonly<{
  name: string;
  evidence: FailureEvidence;
  expected: HealthDecision;
}>;

function assertDecision(name: string, evidence: FailureEvidence, expected: HealthDecision): void {
  const actual = classifyHealthDecision(evidence);
  assert.equal(actual.scope, expected.scope, `${name}: scope`);
  assert.equal(actual.channelReachabilityProven, expected.channelReachabilityProven, `${name}: reachability`);
  assert.equal(typeof actual.reason, 'string', `${name}: reason is serializable`);
  assert.equal(actual.reason.length > 0, true, `${name}: reason is populated`);
}

const cases = [
  {
    name: '401 marks channel when an upstream response was observed',
    evidence: { status: 401, upstreamResponseObserved: true },
    expected: { scope: 'channel', reason: 'auth', channelReachabilityProven: true },
  },
  {
    name: 'explicit revoked API key marks channel without reachability proof when no response was observed',
    evidence: {
      payload: { error: { message: 'API key has been revoked' } },
      upstreamResponseObserved: false,
    },
    expected: { scope: 'channel', reason: 'auth', channelReachabilityProven: false },
  },
  {
    name: 'billing account failure marks channel',
    evidence: {
      status: 403,
      payload: { error: { message: 'Billing account disabled for this token' } },
      fallbackReason: 'compat_4xx',
      upstreamResponseObserved: true,
    },
    expected: { scope: 'channel', reason: 'account', channelReachabilityProven: true },
  },
  {
    name: 'DNS ENOTFOUND marks channel without reachability proof',
    evidence: { fallbackReason: 'connect_error', error: { cause: { code: 'ENOTFOUND' } }, upstreamResponseObserved: false },
    expected: { scope: 'channel', reason: 'transport', channelReachabilityProven: false },
  },
  {
    name: 'HTTP 429 marks model-channel',
    evidence: { status: 429, upstreamResponseObserved: true },
    expected: { scope: 'model_channel', reason: 'retryable_4xx', channelReachabilityProven: true },
  },
  {
    name: 'generic fallback-compatible 4xx marks model-channel',
    evidence: { status: 422, fallbackReason: 'compat_4xx', payload: { error: 'store must be false' }, upstreamResponseObserved: true },
    expected: { scope: 'model_channel', reason: 'fallback_4xx', channelReachabilityProven: true },
  },
  {
    name: 'HTTP 5xx marks model-channel',
    evidence: { status: 503, upstreamResponseObserved: true },
    expected: { scope: 'model_channel', reason: 'upstream_5xx', channelReachabilityProven: true },
  },
  {
    name: 'explicit unsupported model marks model-channel',
    evidence: {
      status: 400,
      fallbackReason: 'compat_4xx',
      payload: { error: { message: 'unsupported model for this provider' } },
      upstreamResponseObserved: true,
    },
    expected: { scope: 'model_channel', reason: 'model_unavailable', channelReachabilityProven: true },
  },
  {
    name: 'first-byte timeout marks model-channel without reachability proof',
    evidence: { abortReason: { kind: 'timeout', phase: 'first-byte' }, upstreamResponseObserved: false },
    expected: { scope: 'model_channel', reason: 'timeout', channelReachabilityProven: false },
  },
  {
    name: 'malformed SSE marks model-channel with reachability only when observed',
    evidence: { fallbackReason: 'sse_reconstruction_failure', upstreamResponseObserved: true },
    expected: { scope: 'model_channel', reason: 'invalid_response', channelReachabilityProven: true },
  },
  {
    name: 'ambiguous read error with observed response preserves reachability proof',
    evidence: { fallbackReason: 'unknown_upstream_error', upstreamResponseObserved: true },
    expected: { scope: 'model_channel', reason: 'ambiguous_upstream', channelReachabilityProven: true },
  },
  {
    name: 'client disconnect does not mutate health',
    evidence: { abortReason: { kind: 'client_disconnect', source: 'request' }, upstreamResponseObserved: false },
    expected: { scope: 'none', reason: 'client_disconnect', channelReachabilityProven: false },
  },
] satisfies readonly ClassificationCase[];

function main(): void {
  for (const testCase of cases) {
    assertDecision(testCase.name, testCase.evidence, testCase.expected);
  }

  assertDecision(
    'compat_4xx alone never selects channel scope',
    { fallbackReason: 'compat_4xx', upstreamResponseObserved: true },
    { scope: 'model_channel', reason: 'fallback_4xx', channelReachabilityProven: true },
  );

  assertDecision(
    'ambiguous errors default to model-channel without reachability proof',
    { error: { message: 'socket closed unexpectedly' }, upstreamResponseObserved: false },
    { scope: 'model_channel', reason: 'ambiguous', channelReachabilityProven: false },
  );

  assertDecision(
    'matched client error patterns do not mutate health',
    {
      status: 400,
      payload: { error: { message: 'maximum context length exceeded for this model' } },
      upstreamResponseObserved: true,
    },
    { scope: 'none', reason: 'client_error', channelReachabilityProven: false },
  );

  assertDecision(
    'proxy-internal failures do not mutate health',
    { fallbackReason: 'proxy_unhandled_error', upstreamResponseObserved: false },
    { scope: 'none', reason: 'proxy_internal', channelReachabilityProven: false },
  );

  console.log('Health classification checks passed.');
}

main();
