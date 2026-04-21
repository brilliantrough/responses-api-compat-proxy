import assert from 'node:assert/strict';

import {
  extractUsageFromStreamPayload,
  isResponsesStyleEventStream,
  normalizeResponseObject,
  parseSse,
  synthesizeResponseFromEvents,
} from '../src/responses-sse.js';
import type { JsonRecord } from '../src/responses-input-normalization.js';

const requestBody: JsonRecord = {
  model: 'gpt-5.4',
  instructions: 'Be concise.',
};

function main() {
  const completedEvents = parseSse([
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress","model":"provider-model"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Hel"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"provider-model","usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18},"output":[{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Hello","annotations":[]}]}]}}',
    '',
  ].join('\n'));

  assert.equal(isResponsesStyleEventStream(completedEvents), true);
  const completedResponse = synthesizeResponseFromEvents(completedEvents);
  assert.ok(completedResponse);
  const normalizedCompleted = normalizeResponseObject(completedResponse, requestBody);
  assert.equal(normalizedCompleted.model, 'gpt-5.4');
  assert.equal(normalizedCompleted.instructions, 'Be concise.');

  const completedUsage = extractUsageFromStreamPayload(JSON.parse(completedEvents[2].data), requestBody);
  assert.deepEqual(completedUsage, {
    responseId: 'resp_1',
    model: 'gpt-5.4',
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
  });

  const deltaOnlyEvents = parseSse([
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_2","model":"provider-model"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Hello"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":" world"}',
    '',
  ].join('\n'));

  const synthesized = synthesizeResponseFromEvents(deltaOnlyEvents);
  assert.ok(synthesized);
  const synthesizedOutput = synthesized.output as Array<{ content?: Array<{ text?: string }> }>;
  assert.equal(synthesizedOutput[0]?.content?.[0]?.text, 'Hello world');

  const noiseEvents = parseSse('event: message\ndata: not-json\n\n');
  assert.equal(isResponsesStyleEventStream(noiseEvents), false);
  assert.equal(synthesizeResponseFromEvents(noiseEvents), undefined);

  console.log('SSE reconstruction checks passed.');
}

main();
