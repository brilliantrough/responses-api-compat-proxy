import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'keepalive-filter-model';

async function waitForHealthy(url: string) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 15000) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // proxy not ready yet
    }

    await delay(150);
  }

  throw new Error(`Timed out waiting for proxy health at ${url}`);
}

// Upstream emits a stream that interleaves real events with the two hostile
// keep-alive shapes seen in the wild: synthetic output_text.delta events with a
// sentinel item_id ("SSE-Keep-Alive"), and SSE comment-only heartbeats.
function hostileStream() {
  return [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_ka","status":"in_progress","model":"keepalive-filter-model"}}',
    '',
    ': SSE-Keep-Alive',
    ': PING',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","item_id":"SSE-Keep-Alive","output_index":0,"content_index":0,"delta":""}',
    '',
    ': another comment heartbeat',
    '',
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_ka","type":"message","status":"in_progress","role":"assistant","content":[]}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","item_id":"SSE-Keep-Alive","delta":"poison"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","item_id":"msg_ka","output_index":0,"content_index":0,"delta":"real answer"}',
    '',
    'event: response.output_text.done',
    'data: {"type":"response.output_text.done","item_id":"msg_ka","output_index":0,"content_index":0,"text":"real answer"}',
    '',
    'event: response.output_item.done',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_ka","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"real answer","annotations":[]}]}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","item_id":"Keep-Alive-tail","delta":""}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_ka","status":"completed","model":"keepalive-filter-model","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5},"output":[{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"real answer","annotations":[]}]}]}}',
    '',
  ].join('\n');
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-keepalive-filter-'));

  const upstream = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(hostileStream());
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === 'string') {
    throw new Error('Failed to resolve mock upstream address');
  }

  const proxyPort = upstreamAddress.port + 1;
  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  await writeFile(
    fallbackConfigPath,
    JSON.stringify({
      default_model: MODEL,
      channels: [
        { id: 'upstream', name: 'hostile-keepalive-upstream', base_url: `http://127.0.0.1:${upstreamAddress.port}`, api_key: 'upstream-key' },
      ],
      models: {
        [MODEL]: { channel_ids: ['upstream'] },
      },
      aliases: {},
    }, null, 2),
    'utf8',
  );

  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/json-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'responses-proxy-keepalive-filter-check',
      PRIMARY_PROVIDER_NAME: undefined,
      PRIMARY_PROVIDER_BASE_URL: undefined,
      PRIMARY_PROVIDER_API_KEY: undefined,
      PRIMARY_PROVIDER_DEFAULT_MODEL: undefined,
      MODEL_MAP_PATH: undefined,
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  proxy.stdout.on('data', chunk => stdout.push(String(chunk)));
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: MODEL,
        input: 'hello',
        stream: true,
      }),
    });

    assert.equal(response.status, 200);
    const text = await response.text();

    assert.ok(!text.includes('SSE-Keep-Alive'), 'synthetic keep-alive delta events must not reach the client');
    assert.ok(!text.includes('Keep-Alive'), 'any keep-alive sentinel item_id must not reach the client');
    assert.ok(!text.includes('"poison"'), 'keep-alive delta payloads must be dropped entirely');
    assert.ok(!/^: /m.test(text), 'comment-only heartbeat blocks must not be re-emitted');
    assert.ok(!/^event: message$/m.test(text), 'comments must not be converted into empty message events');

    assert.match(text, /response\.created/);
    assert.match(text, /"delta":"real answer"/);
    assert.match(text, /response\.completed/);

    const output = stdout.join('');
    assert.ok(!output.includes('stream completed without usable output'), 'real text must count as usable output');

    console.log('Stream keep-alive filter check passed.');
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([
      once(proxy, 'exit'),
      delay(3000).then(() => {
        proxy.kill('SIGKILL');
      }),
    ]);
    upstream.close();
    await once(upstream, 'close');
    await rm(tempDir, { recursive: true, force: true });
  }

  const stderrText = stderr.join('').trim();
  if (stderrText.length > 0) {
    console.error(stderrText);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
