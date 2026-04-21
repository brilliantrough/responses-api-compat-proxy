import { isJsonRecord, type JsonRecord, type JsonValue } from './responses-input-normalization.js';

export type SseEvent = { event: string; data: string };

export function parseSse(text: string) {
  const events: SseEvent[] = [];
  const chunks = text.split(/\r?\n\r?\n/);

  for (const chunk of chunks) {
    if (!chunk.trim()) {
      continue;
    }

    events.push(parseSseChunk(chunk));
  }

  return events;
}

export function parseSseChunk(chunk: string) {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return { event, data: dataLines.join('\n') };
}

export function formatSseEvent(event: SseEvent) {
  const lines = [`event: ${event.event}`];

  if (event.data.length === 0) {
    lines.push('data:');
  } else {
    for (const line of event.data.split('\n')) {
      lines.push(`data: ${line}`);
    }
  }

  return `${lines.join('\n')}\n\n`;
}

export function parseStreamPayload(data: string) {
  if (!data) {
    return undefined;
  }

  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

export function isResponsesStyleEventStream(events: SseEvent[]) {
  return events.some(event => {
    if (event.event.startsWith('response.') || event.event === 'error') {
      return true;
    }

    const payload = parseStreamPayload(event.data);
    return isJsonRecord(payload) && typeof payload.type === 'string' && payload.type.startsWith('response.');
  });
}

export function synthesizeResponseFromEvents(events: SseEvent[]) {
  let lastResponse: JsonRecord | undefined;
  let completedResponse: JsonRecord | undefined;
  const textParts: string[] = [];

  for (const event of events) {
    if (!event.data) {
      continue;
    }

    const parsed = parseStreamPayload(event.data);
    if (!parsed) {
      continue;
    }

    if (isJsonRecord(parsed) && isJsonRecord(parsed.response)) {
      lastResponse = parsed.response;
    }

    if (isJsonRecord(parsed) && parsed.type === 'response.completed' && isJsonRecord(parsed.response)) {
      completedResponse = parsed.response;
    }

    if (isJsonRecord(parsed) && parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
      textParts.push(parsed.delta);
    }

    if (isJsonRecord(parsed) && parsed.type === 'response.output_text.done' && typeof parsed.text === 'string' && textParts.length === 0) {
      textParts.push(parsed.text);
    }
  }

  const base = completedResponse ?? lastResponse;
  if (!base) {
    return undefined;
  }

  if (completedResponse) {
    return completedResponse;
  }

  const text = textParts.join('');
  const output = Array.isArray(base.output)
    ? base.output
    : [
        {
          id: `msg_proxy_${Date.now()}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text,
              annotations: [],
            },
          ],
        },
      ];

  return {
    ...base,
    object: typeof base.object === 'string' ? base.object : 'response',
    status: 'completed',
    output,
  } as JsonRecord;
}

export function normalizeResponseObject(responseObject: JsonRecord, requestBody: JsonRecord) {
  const normalized: JsonRecord = {
    ...responseObject,
    object: 'response',
  };

  if (typeof requestBody.model === 'string') {
    normalized.model = requestBody.model;
  }

  normalized.instructions = typeof requestBody.instructions === 'string' ? requestBody.instructions : null;

  if (typeof normalized.status !== 'string') {
    normalized.status = 'completed';
  }

  if (!Array.isArray(normalized.output)) {
    normalized.output = [];
  }

  return normalized;
}

export function extractUsageMetrics(responseObject: JsonRecord) {
  if (!isJsonRecord(responseObject.usage)) {
    return undefined;
  }

  const usage = responseObject.usage;
  const inputTokenDetails = isJsonRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputTokenDetails = isJsonRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  const usageMetrics: JsonRecord = {};

  if (typeof responseObject.id === 'string') {
    usageMetrics.responseId = responseObject.id;
  }

  if (typeof responseObject.model === 'string') {
    usageMetrics.model = responseObject.model;
  }

  if (typeof usage.input_tokens === 'number') {
    usageMetrics.inputTokens = usage.input_tokens;
  }

  if (typeof usage.output_tokens === 'number') {
    usageMetrics.outputTokens = usage.output_tokens;
  }

  if (typeof usage.total_tokens === 'number') {
    usageMetrics.totalTokens = usage.total_tokens;
  }

  if (typeof inputTokenDetails?.cached_tokens === 'number') {
    usageMetrics.cachedInputTokens = inputTokenDetails.cached_tokens;
  }

  if (typeof outputTokenDetails?.reasoning_tokens === 'number') {
    usageMetrics.reasoningTokens = outputTokenDetails.reasoning_tokens;
  }

  return Object.keys(usageMetrics).length > 0 ? usageMetrics : undefined;
}

export function extractUsageFromStreamPayload(payload: unknown, requestBody: JsonRecord) {
  if (!isJsonRecord(payload)) {
    return undefined;
  }

  if (isJsonRecord(payload.response)) {
    return extractUsageMetrics(normalizeResponseObject(payload.response, requestBody));
  }

  return extractUsageMetrics(normalizeResponseObject(payload, requestBody));
}

export function normalizeStreamEventPayload(payload: unknown, requestBody: JsonRecord) {
  if (!isJsonRecord(payload)) {
    return payload;
  }

  const normalizedPayload: JsonRecord = { ...payload };

  if (isJsonRecord(normalizedPayload.response)) {
    normalizedPayload.response = normalizeResponseObject(normalizedPayload.response, requestBody);
  }

  if (isJsonRecord(normalizedPayload.item) && normalizedPayload.item.type === 'message') {
    normalizedPayload.item = {
      ...normalizedPayload.item,
      role: typeof normalizedPayload.item.role === 'string' ? normalizedPayload.item.role : 'assistant',
    };
  }

  if (typeof requestBody.model === 'string' && typeof normalizedPayload.model === 'string') {
    normalizedPayload.model = requestBody.model;
  }

  return normalizedPayload;
}

export function coerceResponseObject(value: unknown): JsonRecord | undefined {
  return isJsonRecord(value) ? value : undefined;
}

export function writeBufferedResponsesSse(
  res: import('node:http').ServerResponse,
  statusCode: number,
  events: SseEvent[],
  requestBody: JsonRecord,
  streamMode: 'normalized' | 'raw',
) {
  if (!res.headersSent) {
    res.writeHead(statusCode, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
    });
  }

  let usage: JsonRecord | undefined;

  for (const event of events) {
    let normalizedEvent = event;

    if (streamMode === 'normalized') {
      const payload = parseStreamPayload(event.data);
      if (payload !== undefined) {
        usage = extractUsageFromStreamPayload(payload, requestBody) ?? usage;
        normalizedEvent = {
          event: event.event,
          data: JSON.stringify(normalizeStreamEventPayload(payload, requestBody)),
        };
      }
    }

    res.write(formatSseEvent(normalizedEvent));
  }

  res.end();
  return usage;
}

export function makeResponsesStreamErrorEvent(message: string, code = 'server_error', sequenceNumber?: number) {
  const payload: JsonRecord = {
    type: 'error',
    code,
    message,
    param: null,
  };

  if (typeof sequenceNumber === 'number') {
    payload.sequence_number = sequenceNumber;
  }

  return payload;
}

export function sendResponsesStreamError(
  res: import('node:http').ServerResponse,
  message: string,
  options?: { statusCode?: number; code?: string; sequenceNumber?: number },
) {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  if (!res.headersSent) {
    res.writeHead(options?.statusCode ?? 500, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
    });
  }

  res.write(
    formatSseEvent({
      event: 'error',
      data: JSON.stringify(makeResponsesStreamErrorEvent(message, options?.code, options?.sequenceNumber)),
    }),
  );
  res.end();
}
