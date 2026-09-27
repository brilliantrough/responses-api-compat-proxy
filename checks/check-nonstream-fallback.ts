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

async function getPrimaryHealth(url: string) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const body = await response.json() as {
    healthSnapshot?: {
      channels?: Array<{ channelId?: string; state?: string; successCount?: number }>;
      modelChannels?: Array<{ channelId?: string; canonicalModel?: string; state?: string; failureCount?: number; lastFailureReason?: string | null }>;
    };
  };
  const primaryChannel = body.healthSnapshot?.channels?.find(item => item.channelId === 'primary');
  const primaryModelChannel = body.healthSnapshot?.modelChannels?.find(
    item => item.channelId === 'primary' && item.canonicalModel === MODEL,
  );
  assert.ok(primaryChannel);
  assert.ok(primaryModelChannel);
  return { channel: primaryChannel, modelChannel: primaryModelChannel };
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-nonstream-fallback-'));

  let primaryRequests = 0;
  let fallbackRequests = 0;

  const primary = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      primaryRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'resp_primary_empty',
        object: 'response',
        status: 'completed',
        model: 'primary-model',
        output: [],
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'primary-model', object: 'model' }] }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const fallback = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      fallbackRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'resp_fallback_ok',
        object: 'response',
        status: 'completed',
        model: 'fallback-model',
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        output: [
          {
            id: 'msg_fallback_ok',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'fallback ok', annotations: [] }],
          },
        ],
      }));
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
        { id: 'primary', name: 'empty-primary', base_url: `http://127.0.0.1:${primaryAddress.port}`, api_key: 'primary-key' },
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
      INSTANCE_NAME: 'responses-proxy-nonstream-fallback-check',
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        input: 'hello',
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { id?: string };
    assert.equal(body.id, 'resp_fallback_ok');
    assert.equal(primaryRequests, 3);
    assert.equal(fallbackRequests, 1);
    const primaryAfterFirstFailure = await getPrimaryHealth(`http://127.0.0.1:${proxyPort}/admin/stats`);
    assert.equal(primaryAfterFirstFailure.channel.state, 'closed');
    assert.equal(primaryAfterFirstFailure.channel.successCount, 0, 'reachability-proven failure resets the breaker but is not a request success');
    assert.equal(primaryAfterFirstFailure.modelChannel.state, 'closed');
    assert.equal(primaryAfterFirstFailure.modelChannel.failureCount, 3);
    assert.equal(primaryAfterFirstFailure.modelChannel.lastFailureReason, 'invalid_response');

    const secondResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        input: 'hello again',
      }),
    });

    assert.equal(secondResponse.status, 200);
    const secondBody = await secondResponse.json() as { id?: string };
    assert.equal(secondBody.id, 'resp_fallback_ok');
    assert.equal(primaryRequests, 6, 'next request receives a fresh three-attempt budget');
    assert.equal(fallbackRequests, 2);
    const primaryAfterSecondFailure = await getPrimaryHealth(`http://127.0.0.1:${proxyPort}/admin/stats`);
    assert.equal(primaryAfterSecondFailure.channel.state, 'closed');
    assert.equal(primaryAfterSecondFailure.modelChannel.state, 'closed');
    assert.equal(primaryAfterSecondFailure.modelChannel.failureCount, 6);
    assert.equal(primaryAfterSecondFailure.modelChannel.lastFailureReason, 'invalid_response');

    const output = stdout.join('');
    assert.match(output, /upstream json response incomplete, falling back/);
    assert.match(output, /fallbackReason":"empty_response"/);

    console.log('Non-stream fallback check passed.');
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
