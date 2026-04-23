import assert from 'node:assert/strict';
import { classifyProxyTerminalError } from '../src/responses-errors.js';

const timeoutLike = {
  abortReason: { kind: 'timeout', phase: 'connect' },
  endpoint: { name: 'local fallback', url: 'http://127.0.0.1:18080/v1/responses' },
};

const normalized = classifyProxyTerminalError(timeoutLike);

assert.equal(normalized.statusCode, 504);
assert.match(normalized.body.error.message, /No upstream endpoint produced a usable response/);
assert.equal(normalized.body.error.type, 'server_error');
assert.match(JSON.stringify(normalized.body.error.details), /local fallback/);
assert.match(JSON.stringify(normalized.body.error.details), /connect/);

const generic = classifyProxyTerminalError({ foo: 'bar' });
assert.equal(generic.statusCode, 500);
assert.equal(generic.body.error.message, 'Unknown proxy error');

console.log('Proxy terminal error check passed.');
