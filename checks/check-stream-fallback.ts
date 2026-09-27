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
const MODEL = 'fallback-model';

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

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-stream-fallback-'));

  let primaryRequests = 0;
  let fallbackRequests = 0;

  const primary = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      primaryRequests += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('event: response.created\n');
      res.write('data: {"type":"response.created","response":{"id":"resp_meta_only","status":"in_progress","model":"broken-model"}}\n\n');
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'broken-model', object: 'model' }] }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const fallback = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      fallbackRequests += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end([
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_good","status":"in_progress","model":"fallback-model"}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"hello"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_good","status":"completed","model":"fallback-model","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hello","annotations":[]}]}]}}',
        '',
      ].join('\n'));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fallback-model', object: 'model' }] }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  primary.listen(0, '127.0.0.1');
  fallback.listen(0, '127.0.0.1');
  await Promise.all([once(primary, 'listening'), once(fallback, 'listening')]);

  const primaryAddress = primary.address();
  const fallbackAddress = fallback.address();
  if (!primaryAddress || typeof primaryAddress === 'string' || !fallbackAddress || typeof fallbackAddress === 'string') {
    throw new Error('Failed to resolve mock server addresses');
  }

  const proxyPort = fallbackAddress.port + 1;
  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  await writeFile(
    fallbackConfigPath,
    JSON.stringify({
      default_model: MODEL,
      channels: [
        { id: 'primary', name: 'meta-only-primary', base_url: `http://127.0.0.1:${primaryAddress.port}`, api_key: 'primary-key' },
        { id: 'fallback-a', base_url: `http://127.0.0.1:${fallbackAddress.port}`, api_key: 'fallback-key' },
      ],
      models: {
        [MODEL]: { channel_ids: ['primary', 'fallback-a'] },
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
      INSTANCE_NAME: 'responses-proxy-stream-fallback-check',
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
    assert.match(text, /response\.output_text\.delta/);
    assert.match(text, /"delta":"hello"/);
    assert.equal(primaryRequests, 3);
    assert.equal(fallbackRequests, 1);

    const output = stdout.join('');
    assert.match(output, /stream completed without usable output, falling back/);
    assert.match(output, /fallbackReason":"stream_no_text_content"/);

    const statsResponse = await fetch(`http://127.0.0.1:${proxyPort}/admin/monitor/stats`);
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json() as {
      healthSnapshot: {
        modelChannels: Array<{ channelId: string; canonicalModel: string; state: string; successCount: number; failureCount: number; totalFailures: number; lastFailureReason: string | null }>;
      };
    };
    const modelRecords = stats.healthSnapshot.modelChannels.filter(entry => entry.canonicalModel === MODEL);
    const primaryRecord = modelRecords.find(entry => entry.channelId === 'primary');
    const fallbackRecord = modelRecords.find(entry => entry.channelId === 'fallback-a');
    assert.ok(primaryRecord, 'primary model-channel record should exist');
    assert.ok(fallbackRecord, 'fallback model-channel record should exist');
    assert.ok(primaryRecord.lastFailureReason !== 'disposed', 'real fallback failures must be reported with their actual reason, not disposed');
    assert.equal(primaryRecord.totalFailures, 3);
    assert.equal(fallbackRecord.successCount, 1, 'streaming success must be counted (dispose must not swallow reportSuccess)');
    assert.equal(fallbackRecord.lastFailureReason, null);

    console.log('Stream fallback check passed.');
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([
      once(proxy, 'exit'),
      delay(3000).then(() => {
        proxy.kill('SIGKILL');
      }),
    ]);
    primary.close();
    fallback.close();
    await Promise.all([once(primary, 'close'), once(fallback, 'close')]);
    await rm(tempDir, { recursive: true, force: true });
  }

  if (stderr.length > 0) {
    const stderrText = stderr.join('').trim();
    if (stderrText.length > 0) {
      console.error(stderrText);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
