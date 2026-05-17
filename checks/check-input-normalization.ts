import assert from 'node:assert/strict';

import { normalizeInput } from '../src/responses-input-normalization.js';

function main() {
  assert.deepEqual(normalizeInput('Hello'), [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Hello' }],
    },
  ]);

  assert.deepEqual(normalizeInput([
    {
      role: 'user',
      content: 'Hello',
    },
  ]), [
    {
      type: 'message',
      role: 'user',
      content: 'Hello',
    },
  ]);

  assert.deepEqual(normalizeInput([
    {
      role: 'assistant',
      content: 'Hi there',
    },
  ]), [
    {
      type: 'message',
      role: 'assistant',
      content: 'Hi there',
    },
  ]);

  assert.deepEqual(normalizeInput([
    {
      role: 'assistant',
      content: [{ type: 'input_text', text: 'Prior answer' }],
    },
  ]), [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Prior answer' }],
    },
  ]);

  assert.deepEqual(normalizeInput([
    {
      role: 'user',
      content: [{ type: 'output_text', text: 'Should be input', annotations: [] }],
    },
  ]), [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Should be input' }],
    },
  ]);

  assert.deepEqual(normalizeInput([
    {
      role: 'developer',
      content: 'secret policy',
    },
    {
      role: 'user',
      content: 'Hello',
    },
  ], { clearDeveloperContent: true }), [
    {
      type: 'message',
      role: 'developer',
      content: '',
    },
    {
      type: 'message',
      role: 'user',
      content: 'Hello',
    },
  ]);

  assert.deepEqual(normalizeInput([
    {
      role: 'developer',
      content: [
        { type: 'input_text', text: 'hidden directive' },
        { type: 'input_image', image_url: 'https://example.com/x.png' },
      ],
    },
  ], { clearDeveloperContent: true }), [
    {
      type: 'message',
      role: 'developer',
      content: [
        { type: 'input_text', text: '' },
        { type: 'input_image', image_url: 'https://example.com/x.png' },
      ],
    },
  ]);

  assert.deepEqual(normalizeInput([
    {
      role: 'system',
      content: 'top level system policy',
    },
    {
      role: 'user',
      content: 'Hello',
    },
  ], { clearSystemContent: true }), [
    {
      type: 'message',
      role: 'developer',
      content: '',
    },
    {
      type: 'message',
      role: 'user',
      content: 'Hello',
    },
  ]);

  assert.deepEqual(normalizeInput([
    {
      role: 'system',
      content: [
        { type: 'input_text', text: 'internal system rule' },
        { type: 'input_file', file_id: 'file_123' },
      ],
    },
  ], { clearSystemContent: true }), [
    {
      type: 'message',
      role: 'developer',
      content: [
        { type: 'input_text', text: '' },
        { type: 'input_file', file_id: 'file_123' },
      ],
    },
  ]);

  assert.deepEqual(normalizeInput([
    {
      role: 'system',
      content: 'keep system role',
    },
  ], { convertSystemToDeveloper: false }), [
    {
      type: 'message',
      role: 'system',
      content: 'keep system role',
    },
  ]);

  assert.deepEqual(normalizeInput([
    {
      role: 'system',
      content: 'x-anthropic-billing-header: cc_version=2.1.119.47e; cc_entrypoint=sdk-cli; cch=abc123;\n\nstable system',
    },
    {
      role: 'developer',
      content: [{ type: 'input_text', text: 'x-anthropic-billing-header: cc_version=2.1.119.47e; cch=def456;\nstable developer' }],
    },
    {
      role: 'user',
      content: 'x-anthropic-billing-header: cch=user;\nuser text',
    },
  ], { claudeBillingHeaderMode: 'strip_line' }), [
    {
      type: 'message',
      role: 'developer',
      content: 'stable system',
    },
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'stable developer' }],
    },
    {
      type: 'message',
      role: 'user',
      content: 'x-anthropic-billing-header: cch=user;\nuser text',
    },
  ]);

  assert.deepEqual(normalizeInput([
    {
      role: 'system',
      content: 'x-anthropic-billing-header: cc_version=2.1.119.47e; cc_entrypoint=sdk-cli; cch=abc123;\nstable system',
    },
  ], { claudeBillingHeaderMode: 'strip_cch' }), [
    {
      type: 'message',
      role: 'developer',
      content: 'x-anthropic-billing-header: cc_version=2.1.119.47e; cc_entrypoint=sdk-cli;\nstable system',
    },
  ]);

  console.log('Input normalization checks passed.');
}

main();
