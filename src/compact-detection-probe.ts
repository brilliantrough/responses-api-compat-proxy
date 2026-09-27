import { extractErrorMessage } from './responses-errors.js';
import { isJsonRecord } from './responses-input-normalization.js';
import { parseSse, parseStreamPayload } from './responses-sse.js';
import type { ChannelConfig } from './routing-config.js';

export type DetectionProtocol = 'v1' | 'v2';

export type DetectionStatus =
  | 'supported'
  | 'bridge_only'
  | 'unsupported_route'
  | 'model_unsupported'
  | 'auth_failed'
  | 'timeout'
  | 'error';

export type DetectionResult = Readonly<{
  channelId: string;
  protocol: DetectionProtocol;
  status: DetectionStatus;
  detail?: string;
  probedAt: number;
}>;

export type CompactFetch = (url: string, init: RequestInit) => Promise<Response>;

const defaultProbeInput = {
  input: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }],
    },
  ],
} as const;

const v2ProbeInput = {
  model: '',
  stream: true,
  store: false,
  input: [
    ...defaultProbeInput.input,
    { type: 'compaction_trigger' },
  ],
} as const;

export function detectionDetail(value: unknown, apiKey: string): string | undefined {
  const message = extractErrorMessage(value);
  if (!message) {
    return undefined;
  }

  const redacted = message
    .replaceAll(apiKey, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .trim();
  return redacted.length > 0 ? redacted.slice(0, 300) : undefined;
}

export function detectionResult(
  channel: ChannelConfig,
  result: Readonly<{
    protocol: DetectionProtocol;
    status: DetectionStatus;
    probedAt: number;
    detail?: string;
  }>,
): DetectionResult {
  return {
    channelId: channel.id,
    protocol: result.protocol,
    status: result.status,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    probedAt: result.probedAt,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

type ProbeOptions = Readonly<{
  channel: ChannelConfig;
  model: string;
  protocol: DetectionProtocol;
  timeoutMs: number;
  fetchImpl: CompactFetch;
}>;

type ProbeOutcome = Readonly<{
  status: DetectionStatus;
  probedAt: number;
  detail?: string;
}>;

function result(options: ProbeOptions, outcome: ProbeOutcome): DetectionResult {
  return detectionResult(options.channel, {
    protocol: options.protocol,
    status: outcome.status,
    probedAt: outcome.probedAt,
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  });
}

function responsePayload(responseText: string): unknown {
  try {
    return responseText.trim().length > 0 ? JSON.parse(responseText) : undefined;
  } catch {
    return responseText;
  }
}

type ErrorResponseContext = Readonly<{
  options: ProbeOptions;
  response: Response;
  payload: unknown;
  probedAt: number;
}>;

function classifyErrorResponse(context: ErrorResponseContext): DetectionResult {
  const { options, response, payload, probedAt } = context;
  if (response.status === 404 || response.status === 405) {
    return result(options, { status: 'unsupported_route', probedAt });
  }
  if (response.status === 401 || response.status === 403) {
    return result(options, {
      status: 'auth_failed',
      probedAt,
      detail: detectionDetail(payload, options.channel.apiKey),
    });
  }
  if (response.status >= 400 && response.status < 500) {
    const detail = detectionDetail(payload, options.channel.apiKey);
    if (detail && /(?:compact|not\s+suppor|unsupported)/i.test(detail)) {
      return result(options, { status: 'model_unsupported', probedAt, detail });
    }
    return result(options, { status: 'error', probedAt, detail });
  }
  return result(options, { status: 'error', probedAt, detail: `upstream status ${response.status}` });
}

function classifyV2Success(options: ProbeOptions, responseText: string, probedAt: number): DetectionResult {
  let completed = false;
  for (const event of parseSse(responseText)) {
    const payload = parseStreamPayload(event.data);
    if (!isJsonRecord(payload)) {
      continue;
    }
    if (isJsonRecord(payload.item) && payload.item.type === 'compaction') {
      return result(options, { status: 'supported', probedAt });
    }
    if (payload.type === 'response.completed') {
      completed = true;
      if (
        isJsonRecord(payload.response) &&
        Array.isArray(payload.response.output) &&
        payload.response.output.some(item => isJsonRecord(item) && item.type === 'compaction')
      ) {
        return result(options, { status: 'supported', probedAt });
      }
    }
  }
  return result(options, {
    status: completed ? 'bridge_only' : 'error',
    probedAt,
    ...(completed ? {} : { detail: 'unexpected response stream' }),
  });
}

async function probe(options: ProbeOptions): Promise<DetectionResult> {
  const probedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, options.timeoutMs));
  let response: Response | undefined;

  try {
    const isV2 = options.protocol === 'v2';
    response = await options.fetchImpl(
      `${options.channel.baseUrl}${isV2 ? '/v1/responses' : '/v1/responses/compact'}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.channel.apiKey}`,
          'Content-Type': 'application/json',
          Accept: isV2 ? 'text/event-stream' : 'application/json',
          ...(isV2 ? { 'x-codex-beta-features': 'remote_compaction_v2' } : {}),
        },
        body: JSON.stringify(isV2
          ? { ...v2ProbeInput, model: options.model }
          : { model: options.model, ...defaultProbeInput }),
        signal: controller.signal,
      },
    );

    const responseText = await response.text();
    const payload = responsePayload(responseText);

    if (response.status === 200) {
      if (isV2) {
        return classifyV2Success(options, responseText, probedAt);
      }
      if (isJsonRecord(payload) && payload.object === 'response.compaction') {
        return result(options, { status: 'supported', probedAt });
      }
      return result(options, { status: 'error', probedAt, detail: 'unexpected response object' });
    }
    return classifyErrorResponse({ options, response, payload, probedAt });
  } catch (error) {
    if (response !== undefined) {
      await response.body?.cancel().catch(() => undefined);
    }
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (timedOut || isAbortError(error)) {
      return result(options, { status: 'timeout', probedAt });
    }
    return result(options, {
      status: 'error',
      probedAt,
      detail: detectionDetail(normalizedError, options.channel.apiKey),
    });
  } finally {
    clearTimeout(timeout);
  }
}

type PublicProbeOptions = Readonly<{ timeoutMs: number; fetchImpl: CompactFetch }>;

export function probeCompactChannel(
  channel: ChannelConfig,
  model: string,
  options: PublicProbeOptions,
): Promise<DetectionResult> {
  return probe({ channel, model, protocol: 'v1', ...options });
}

export function probeCompactChannelV2(
  channel: ChannelConfig,
  model: string,
  options: PublicProbeOptions,
): Promise<DetectionResult> {
  return probe({ channel, model, protocol: 'v2', ...options });
}
