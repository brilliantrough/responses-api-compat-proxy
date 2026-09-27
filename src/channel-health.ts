import { extractErrorMessage, type FallbackReason } from './responses-errors.js';

// allow: SIZE_OK - standalone health module required by the routing plan; one private state machine is shared by both scopes.

export type HealthScope = 'channel' | 'model_channel' | 'none';

export type FailureEvidence = Readonly<{
  fallbackReason?: import('./responses-errors.js').FallbackReason;
  status?: number;
  payload?: unknown;
  error?: unknown;
  abortReason?: unknown;
  upstreamResponseObserved: boolean;
}>;

export type HealthDecision = Readonly<{
  scope: HealthScope;
  reason: string;
  channelReachabilityProven: boolean;
}>;

export type HealthOutcome = Readonly<{
  scope: HealthScope;
  success: boolean;
  reason: string;
  channelReachabilityProven: boolean;
}>;

const healthLeaseBrand: unique symbol = Symbol('HealthLease');

export type HealthLease = Readonly<{
  readonly [healthLeaseBrand]: true;
}>;

export type HealthTopology = Readonly<{
  channels: readonly Readonly<{ channelId: string; fingerprint: string; disableCooldown?: boolean }>[];
  modelChannels: readonly Readonly<{ channelId: string; canonicalModel: string }>[];
}>;

export type HealthRegistryOptions = Readonly<{
  healthWindowMs?: number;
  healthFailureThreshold?: number;
  healthFailureRateThreshold?: number;
  healthCooldownMs?: number;
  quotaCooldownMs?: number;
  now?: () => number;
}>;

type CircuitSnapshot = Readonly<{
  state: 'closed' | 'open';
  failureCount: number;
  successCount: number;
  totalFailures: number;
  windowFailures: number;
  windowSuccesses: number;
  windowFailureRate: number | null;
  cooldownUntil: number;
  remainingMs: number;
  remainingSeconds: number;
  lastFailureReason: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  halfOpenProbeInFlight: number;
}>;

export type HealthSnapshot = Readonly<{
  topologyGeneration: number;
  channels: readonly (CircuitSnapshot & Readonly<{
    channelId: string;
    fingerprint: string;
    disableCooldown: boolean;
    manualCooldownUntil: number;
    manualRemainingSeconds: number;
    quotaCooldownUntil: number;
    quotaRemainingMs: number;
    quotaRemainingSeconds: number;
    quotaFailureCount: number;
    lastQuotaFailureAt: number | null;
  }>)[];
  modelChannels: readonly (CircuitSnapshot & Readonly<{
    channelId: string;
    canonicalModel: string;
    channelFingerprint: string;
    modelWindowFailures: number;
    modelWindowSuccesses: number;
  }>)[];
}>;

type HealthInput = Readonly<{ channelId: string; channelFingerprint: string; canonicalModel: string; disableCooldown?: boolean }>;
type Availability = Readonly<{ ok: true }> | Readonly<{ ok: false; retryAfterMs: number; unavailableScopes: readonly Exclude<HealthScope, 'none'>[] }>;

export type HealthRegistry = Readonly<{
  availability(input: HealthInput): Availability;
  acquire(input: HealthInput):
    | Readonly<{ ok: true; lease: HealthLease }>
    | Readonly<{ ok: false; retryAfterMs: number; unavailableScopes: readonly Exclude<HealthScope, 'none'>[] }>;
  complete(lease: HealthLease, outcome: HealthOutcome): void;
  configure(options: HealthRegistryOptions): void;
  control(channelId: string, action: 'open' | 'close'): boolean;
  reconcile(topology: HealthTopology): void;
  snapshot(): HealthSnapshot;
}>;

type UnknownRecord = Readonly<Record<string, unknown>>;

type CircuitRecord = {
  fingerprint: string;
  successCount: number;
  totalFailures: number;
  cooldownUntil: number;
  lastFailureReason: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  epoch: number;
  samples: { at: number; success: boolean }[];
  sampleHead: number;
  windowFailures: number;
  windowSuccesses: number;
};

type ChannelRecord = CircuitRecord & {
  readonly channelId: string;
  disableCooldown: boolean;
  manualEpoch: number;
  manualCooldownUntil: number;
  quotaCooldownUntil: number;
  quotaFailureCount: number;
  lastQuotaFailureAt: number | null;
};
type ModelChannelRecord = CircuitRecord & { readonly channelId: string; readonly canonicalModel: string };
type LeaseState = {
  consumed: boolean;
  readonly channel: ChannelRecord;
  readonly model: ModelChannelRecord;
  readonly topologyGeneration: number;
  readonly manualEpoch: number;
  readonly circuitEpoch: number;
  readonly disableCooldown: boolean;
};

type RegistrySettings = Required<HealthRegistryOptions>;

const QUOTA_EXHAUSTED_REASON = 'quota_exhausted';

const RETRYABLE_4XX = [408, 409, 423, 425, 429] as const;
const INVALID_RESPONSE_REASONS: readonly FallbackReason[] = ['empty_response', 'stream_missing_usage', 'stream_no_text_content', 'sse_reconstruction_failure'];
const AUTH_PATTERNS = ['invalid api key', 'invalid_api_key', 'api key revoked', 'api key has been revoked', 'revoked api key', 'unauthorized', 'authentication failed'] as const;
const ACCOUNT_PATTERNS = ['account disabled', 'billing account', 'billing required', 'insufficient balance', 'credit exhausted', 'quota exhausted', '不允许使用余额', '无可用套餐'] as const;
// Quota exhaustion is a channel-wide state with its own cooldown that must also break channels
// flagged disableCooldown. Structured error codes are trusted on any status (relays sometimes
// stream quota errors with HTTP 200); message-only matches require a 4xx status to avoid false hits.
const QUOTA_EXHAUSTED_CODE_PATTERNS = ['quota_exhausted', 'quota-exhausted', 'quota_exceeded', 'quota-exceeded', 'insufficient_quota', 'insufficient-quota', 'usage_limit_reached', 'spend_limit'] as const;
const QUOTA_EXHAUSTED_MESSAGE_PATTERNS = ['额度已用完', '额度已耗尽', '额度已用尽', '额度不足', '额度均不足', '余额已用完', '余额不足', '令牌额度', 'quota exhausted', 'quota exceeded', 'insufficient quota', 'insufficient account balance', 'usage limit reached', 'spend limit', 'daily quota', 'credit balance too low'] as const;
const MODEL_PATTERNS = ['unsupported model', 'model not found', 'model_not_found', 'model unavailable', 'unavailable model', 'model is unavailable'] as const;
const CLIENT_PATTERNS = ['maximum context length', 'invalid tool schema', 'json schema is invalid', 'invalid client input'] as const;
const TRANSPORT_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'] as const;

function decide(scope: HealthScope, reason: string, channelReachabilityProven: boolean): HealthDecision {
  return { scope, reason, channelReachabilityProven };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const nested = value[key];
  return typeof nested === 'string' ? nested : undefined;
}

function readNestedString(value: unknown, firstKey: string, secondKey: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readString(value[firstKey], secondKey);
}

function lowerText(value: unknown): string {
  const values: string[] = [];
  const payloadMessage = extractErrorMessage(value);
  if (payloadMessage) {
    values.push(payloadMessage);
  }
  const code = readString(value, 'code') ?? readNestedString(value, 'error', 'code');
  if (code) {
    values.push(code);
  }
  return values.join(' ').toLowerCase();
}

function lowerEvidenceText(evidence: FailureEvidence): string {
  const values = [lowerText(evidence.payload), lowerText(evidence.error)];
  if (evidence.error instanceof Error) {
    values.push(evidence.error.name.toLowerCase(), evidence.error.message.toLowerCase());
  }
  return values.join(' ').toLowerCase();
}

function matches(text: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => text.includes(pattern));
}

function readErrorCode(error: unknown): string | undefined {
  return readString(error, 'code') ?? readNestedString(error, 'cause', 'code');
}

function abortKind(value: unknown): string | undefined {
  return readString(value, 'kind');
}

function timeoutPhase(value: unknown): string | undefined {
  return abortKind(value) === 'timeout' ? readString(value, 'phase') : undefined;
}

function evidenceErrorCode(value: unknown): string {
  if (isRecord(value) && isRecord(value.response)) return evidenceErrorCode(value.response);
  return [readString(value, 'code'), readNestedString(value, 'error', 'code'), readNestedString(value, 'cause', 'code')]
    .filter((code): code is string => code !== undefined)
    .join(' ')
    .toLowerCase();
}

export function isQuotaExhaustedEvidence(evidence: FailureEvidence): boolean {
  const code = `${evidenceErrorCode(evidence.payload)} ${evidenceErrorCode(evidence.error)}`;
  if (matches(code, QUOTA_EXHAUSTED_CODE_PATTERNS)) {
    return true;
  }

  if (evidence.status === undefined || evidence.status < 400 || evidence.status >= 500) {
    return false;
  }

  const message = [lowerText(evidence.payload), lowerText(evidence.error)].join(' ');
  return matches(message, QUOTA_EXHAUSTED_MESSAGE_PATTERNS);
}

export function classifyHealthDecision(evidence: FailureEvidence): HealthDecision {
  const text = lowerEvidenceText(evidence);
  const status = evidence.status;
  const fallbackReason = evidence.fallbackReason;

  if (abortKind(evidence.abortReason) === 'client_disconnect') {
    return decide('none', 'client_disconnect', false);
  }
  if (fallbackReason === 'proxy_unhandled_error') {
    return decide('none', 'proxy_internal', false);
  }
  if (isQuotaExhaustedEvidence(evidence)) {
    return decide('channel', 'quota_exhausted', evidence.upstreamResponseObserved);
  }
  if ((status !== undefined && status >= 400 && status < 500 && matches(text, CLIENT_PATTERNS)) || (status !== undefined && !evidence.upstreamResponseObserved && status >= 400 && status < 500)) {
    return decide('none', 'client_error', false);
  }
  if (timeoutPhase(evidence.abortReason) !== undefined || fallbackReason === 'headers_only_timeout') {
    return decide('model_channel', 'timeout', false);
  }
  const errorCode = readErrorCode(evidence.error);
  if ((errorCode && TRANSPORT_CODES.some(code => code === errorCode)) || matches(text, ['certificate', 'cert ', 'econnrefused', 'enotfound', 'eai_again'])) {
    return decide('channel', 'transport', false);
  }
  if (status !== 401 && matches(text, MODEL_PATTERNS)) {
    return decide('model_channel', 'model_unavailable', true);
  }
  if (status === 401 || matches(text, AUTH_PATTERNS)) {
    return decide('channel', 'auth', evidence.upstreamResponseObserved);
  }
  if (matches(text, ACCOUNT_PATTERNS)) {
    return decide('channel', 'account', evidence.upstreamResponseObserved);
  }
  if (status !== undefined && RETRYABLE_4XX.some(retryableStatus => retryableStatus === status)) {
    return decide('model_channel', 'retryable_4xx', true);
  }
  if ((status !== undefined && status >= 500) || fallbackReason === 'upstream_5xx') {
    return decide('model_channel', 'upstream_5xx', true);
  }
  if (fallbackReason === 'retryable_4xx' || fallbackReason === 'compat_4xx') {
    return decide('model_channel', 'fallback_4xx', true);
  }
  if (fallbackReason !== undefined && INVALID_RESPONSE_REASONS.includes(fallbackReason)) {
    return decide('model_channel', 'invalid_response', evidence.upstreamResponseObserved);
  }
  if (fallbackReason === 'unknown_upstream_error' || fallbackReason === 'connect_error') {
    return decide('model_channel', 'ambiguous_upstream', evidence.upstreamResponseObserved);
  }
  return decide('model_channel', 'ambiguous', false);
}

function normalizeOptions(options: HealthRegistryOptions): RegistrySettings {
  return {
    healthWindowMs: options.healthWindowMs ?? 180_000,
    healthFailureThreshold: options.healthFailureThreshold ?? 15,
    healthFailureRateThreshold: options.healthFailureRateThreshold ?? 0.5,
    healthCooldownMs: options.healthCooldownMs ?? 600_000,
    quotaCooldownMs: options.quotaCooldownMs ?? 7_200_000,
    now: options.now ?? (() => Date.now()),
  };
}

function createCircuit(fingerprint: string): CircuitRecord {
  return { fingerprint, successCount: 0, totalFailures: 0, cooldownUntil: 0, lastFailureReason: null, lastFailureAt: null, lastSuccessAt: null, epoch: 0, samples: [], sampleHead: 0, windowFailures: 0, windowSuccesses: 0 };
}

function channelRecord(channelId: string, fingerprint: string): ChannelRecord {
  return { ...createCircuit(fingerprint), channelId, disableCooldown: false, manualEpoch: 0, manualCooldownUntil: 0, quotaCooldownUntil: 0, quotaFailureCount: 0, lastQuotaFailureAt: null };
}

function modelRecord(channelId: string, canonicalModel: string, fingerprint: string): ModelChannelRecord {
  return { ...createCircuit(fingerprint), channelId, canonicalModel };
}

function keyForModel(channelId: string, canonicalModel: string): string {
  return `${channelId}\u0000${canonicalModel}`;
}

export function isCompactHealthScope(model: string): boolean {
  return model.startsWith('compact:') || model.startsWith('compact-v2:');
}

function resetWindow(record: CircuitRecord): void {
  record.epoch += 1;
  record.samples = [];
  record.sampleHead = record.windowFailures = record.windowSuccesses = 0;
}

function refresh(record: CircuitRecord, now: number, windowMs: number): void {
  if (record.cooldownUntil > 0 && record.cooldownUntil <= now) {
    record.cooldownUntil = 0;
    resetWindow(record);
  }
  while (record.sampleHead < record.samples.length && record.samples[record.sampleHead].at <= now - windowMs) {
    const sample = record.samples[record.sampleHead++];
    if (sample.success) record.windowSuccesses -= 1;
    else record.windowFailures -= 1;
  }
  if (record.sampleHead > 1024 || record.sampleHead === record.samples.length) {
    record.samples = record.samples.slice(record.sampleHead);
    record.sampleHead = 0;
  }
}

function countOutcome(record: CircuitRecord, outcome: HealthOutcome, now: number): void {
  if (outcome.success) {
    record.successCount += 1;
    record.lastSuccessAt = now;
  } else {
    record.totalFailures += 1;
    record.lastFailureAt = now;
    record.lastFailureReason = outcome.reason;
  }
}

export function createHealthRegistry(options: HealthRegistryOptions = {}): HealthRegistry {
  let settings = normalizeOptions(options);
  const channels = new Map<string, ChannelRecord>();
  const modelChannels = new Map<string, ModelChannelRecord>();
  const leases = new WeakMap<HealthLease, LeaseState>();
  let generation = 0;
  const availability = (input: HealthInput): Availability => {
    const channel = channels.get(input.channelId);
    // A request holding an old config snapshot must not resurrect a removed/rotated channel.
    if ((generation > 0 && !channel) || (channel && channel.fingerprint !== input.channelFingerprint)) {
      return { ok: false, retryAfterMs: 0, unavailableScopes: ['channel'] };
    }
    const now = settings.now();
    const model = modelChannels.get(keyForModel(input.channelId, input.canonicalModel));
    if (generation > 0 && !model) return { ok: false, retryAfterMs: 0, unavailableScopes: ['model_channel'] };
    if (channel) refresh(channel, now, settings.healthWindowMs);
    if (model) refresh(model, now, settings.healthWindowMs);
    const circuit = isCompactHealthScope(input.canonicalModel) ? model : channel;
    const globalUntil = Math.max(channel?.manualCooldownUntil ?? 0, channel?.quotaCooldownUntil ?? 0);
    const ordinaryUntil = input.disableCooldown ? 0 : circuit?.cooldownUntil ?? 0;
    const until = Math.max(globalUntil, ordinaryUntil);
    return until > now
      ? { ok: false, retryAfterMs: until - now, unavailableScopes: [globalUntil > now || circuit === channel ? 'channel' : 'model_channel'] }
      : { ok: true };
  };

  return {
    availability,
    acquire(input) {
      const available = availability(input);
      if (!available.ok) return available;
      const channel = channels.get(input.channelId) ?? channelRecord(input.channelId, input.channelFingerprint);
      channels.set(input.channelId, channel);
      channel.disableCooldown = input.disableCooldown === true;
      const key = keyForModel(input.channelId, input.canonicalModel);
      const model = modelChannels.get(key) ?? modelRecord(input.channelId, input.canonicalModel, input.channelFingerprint);
      modelChannels.set(key, model);
      const circuit = isCompactHealthScope(input.canonicalModel) ? model : channel;
      const lease: HealthLease = Object.freeze({ [healthLeaseBrand]: true });
      leases.set(lease, { consumed: false, channel, model, topologyGeneration: generation, manualEpoch: channel.manualEpoch, circuitEpoch: circuit.epoch, disableCooldown: input.disableCooldown === true });
      return { ok: true, lease };
    },
    complete(lease, outcome) {
      const state = leases.get(lease);
      if (!state || state.consumed) return;
      state.consumed = true;
      if (state.topologyGeneration !== generation || outcome.scope === 'none') return;
      const { channel, model } = state;
      const now = settings.now();
      countOutcome(channel, outcome, now);
      countOutcome(model, outcome, now);
      if (state.manualEpoch !== channel.manualEpoch) return;
      if (!outcome.success && outcome.reason === QUOTA_EXHAUSTED_REASON) {
        channel.quotaFailureCount += 1;
        const quotaReset = new Date(now);
        quotaReset.setUTCHours(16, 2, 0, 0); // 北京时间次日 00:02。
        if (quotaReset.getTime() <= now) quotaReset.setUTCDate(quotaReset.getUTCDate() + 1);
        channel.quotaCooldownUntil = Math.min(now + settings.quotaCooldownMs, quotaReset.getTime());
        channel.lastQuotaFailureAt = now;
        return;
      }
      const circuit = isCompactHealthScope(model.canonicalModel) ? model : channel;
      refresh(circuit, now, settings.healthWindowMs);
      if (state.circuitEpoch !== circuit.epoch) return;
      // Per-model observations are for uptime display; ordinary routing still uses the shared channel breaker.
      if (model !== circuit) {
        refresh(model, now, settings.healthWindowMs);
        model.samples.push({ at: now, success: outcome.success });
        if (outcome.success) model.windowSuccesses += 1;
        else model.windowFailures += 1;
      }
      circuit.samples.push({ at: now, success: outcome.success });
      if (outcome.success) circuit.windowSuccesses += 1;
      else circuit.windowFailures += 1;
      if (!state.disableCooldown && circuit.cooldownUntil === 0 &&
          circuit.windowFailures >= settings.healthFailureThreshold &&
          circuit.windowFailures / (circuit.windowFailures + circuit.windowSuccesses) > settings.healthFailureRateThreshold) {
        circuit.cooldownUntil = now + settings.healthCooldownMs;
      }
    },
    configure(options) {
      settings = normalizeOptions({ ...settings, ...options });
    },
    control(channelId, action) {
      const channel = channels.get(channelId);
      if (!channel) return false;
      channel.manualEpoch += 1;
      channel.manualCooldownUntil = action === 'open' ? settings.now() + settings.healthCooldownMs : 0;
      for (const record of [channel, ...Array.from(modelChannels.values()).filter(model => model.channelId === channelId)]) {
        resetWindow(record);
        if (action === 'close') record.cooldownUntil = 0;
      }
      if (action === 'close') channel.quotaCooldownUntil = 0;
      return true;
    },
    reconcile(topology) {
      generation += 1;
      const nextChannels = new Map<string, ChannelRecord>();
      const fingerprints = new Map<string, string>();
      for (const channel of topology.channels) {
        fingerprints.set(channel.channelId, channel.fingerprint);
        const current = channels.get(channel.channelId);
        const record = current && current.fingerprint === channel.fingerprint ? current : channelRecord(channel.channelId, channel.fingerprint);
        record.disableCooldown = channel.disableCooldown === true;
        nextChannels.set(channel.channelId, record);
      }
      channels.clear();
      for (const [key, record] of nextChannels) {
        channels.set(key, record);
      }
      const nextModels = new Map<string, ModelChannelRecord>();
      for (const pair of topology.modelChannels) {
        const fingerprint = fingerprints.get(pair.channelId);
        if (fingerprint === undefined) {
          continue;
        }
        const key = keyForModel(pair.channelId, pair.canonicalModel);
        const current = modelChannels.get(key);
        nextModels.set(key, current && current.fingerprint === fingerprint ? current : modelRecord(pair.channelId, pair.canonicalModel, fingerprint));
      }
      modelChannels.clear();
      for (const [key, record] of nextModels) {
        modelChannels.set(key, record);
      }
    },
    snapshot() {
      const now = settings.now();
      const base = (record: CircuitRecord, circuit = record): CircuitSnapshot => {
        refresh(circuit, now, settings.healthWindowMs);
        const remainingMs = Math.max(0, circuit.cooldownUntil - now);
        const total = circuit.windowFailures + circuit.windowSuccesses;
        return { state: remainingMs > 0 ? 'open' : 'closed', failureCount: circuit.windowFailures, successCount: record.successCount, totalFailures: record.totalFailures, windowFailures: circuit.windowFailures, windowSuccesses: circuit.windowSuccesses, windowFailureRate: total ? circuit.windowFailures / total : null, cooldownUntil: circuit.cooldownUntil, remainingMs, remainingSeconds: Math.ceil(remainingMs / 1000), lastFailureReason: record.lastFailureReason, lastFailureAt: record.lastFailureAt, lastSuccessAt: record.lastSuccessAt, halfOpenProbeInFlight: 0 };
      };
      return {
        topologyGeneration: generation,
        channels: Array.from(channels.values()).map(record => ({ channelId: record.channelId, fingerprint: record.fingerprint, disableCooldown: record.disableCooldown, ...base(record), quotaCooldownUntil: record.quotaCooldownUntil, quotaRemainingMs: Math.max(0, record.quotaCooldownUntil - now), quotaRemainingSeconds: Math.max(0, Math.ceil((record.quotaCooldownUntil - now) / 1000)), quotaFailureCount: record.quotaFailureCount, lastQuotaFailureAt: record.lastQuotaFailureAt, manualCooldownUntil: record.manualCooldownUntil, manualRemainingSeconds: Math.max(0, Math.ceil((record.manualCooldownUntil - now) / 1000)) })),
        modelChannels: Array.from(modelChannels.values()).map(record => {
          const circuit = isCompactHealthScope(record.canonicalModel) ? record : channels.get(record.channelId)!;
          refresh(record, now, settings.healthWindowMs);
          return { channelId: record.channelId, canonicalModel: record.canonicalModel, channelFingerprint: record.fingerprint, ...base(record, circuit), modelWindowFailures: record.windowFailures, modelWindowSuccesses: record.windowSuccesses };
        }),
      };
    },
  };
}
