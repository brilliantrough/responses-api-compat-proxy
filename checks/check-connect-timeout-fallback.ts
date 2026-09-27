import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
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
      modelChannels?: Array<{ channelId?: string; canonicalModel?: string; state?: string; failureCount?: number; lastFailureReason?: string | null }>;
    };
  };
  const primary = body.healthSnapshot?.modelChannels?.find(
    item => item.channelId === 'primary' && item.canonicalModel === 'fallback-model',
  );
  assert.ok(primary);
  return primary;
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-timeout-fallback-'));

  let fallbackRequests = 0;
  const hangingSockets = new Set<import('node:net').Socket>();

  const primary = createNetServer(socket => {
    hangingSockets.add(socket);
    socket.on('close', () => {
      hangingSockets.delete(socket);
    });
  });

  primary.listen(0, '127.0.0.1');
  await once(primary, 'listening');
  const primaryAddress = primary.address();
  if (!primaryAddress || typeof primaryAddress === 'string') {
    throw new Error('Failed to resolve primary blackhole address');
  }

  const fallback = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      fallbackRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'resp_fallback_success',
        object: 'response',
        status: 'completed',
        model: 'fallback-model',
        output: [
          {
            id: 'msg_fallback_success',
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

  fallback.listen(0, '127.0.0.1');
  await once(fallback, 'listening');
  const fallbackAddress = fallback.address();
  if (!fallbackAddress || typeof fallbackAddress === 'string') {
    throw new Error('Failed to resolve fallback address');
  }

  const blackholePort = primaryAddress.port;
  const proxyPort = fallbackAddress.port + 1;
  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  await writeFile(
    fallbackConfigPath,
    JSON.stringify({
      default_model: 'fallback-model',
      channels: [
        {
          id: 'primary',
          name: 'blackhole-primary',
          base_url: `http://127.0.0.1:${blackholePort}`,
          api_key: 'primary-key',
        },
        {
          id: 'fallback-a',
          base_url: `http://127.0.0.1:${fallbackAddress.port}`,
          api_key: 'fallback-key',
        },
      ],
      models: {
        'fallback-model': { channel_ids: ['primary', 'fallback-a'] },
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
      INSTANCE_NAME: 'responses-proxy-timeout-fallback-check',
      PRIMARY_PROVIDER_NAME: undefined,
      PRIMARY_PROVIDER_BASE_URL: undefined,
      PRIMARY_PROVIDER_API_KEY: undefined,
      PRIMARY_PROVIDER_DEFAULT_MODEL: undefined,
      MODEL_MAP_PATH: undefined,
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
      PROXY_UPSTREAM_TIMEOUT_MS: '300',
      PROXY_NON_STREAM_TIMEOUT_MS: '300',
      PROXY_FIRST_BYTE_TIMEOUT_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  proxy.stdout.on('data', chunk => stdout.push(String(chunk)));
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);
    console.log('proxy healthy');

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fallback-model',
        input: 'hello',
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { id?: string };
    assert.equal(body.id, 'resp_fallback_success');
    assert.equal(fallbackRequests, 1);
    const primaryAfterFirstFailure = await getPrimaryHealth(`http://127.0.0.1:${proxyPort}/admin/stats`);
    assert.equal(primaryAfterFirstFailure.state, 'open');
    assert.equal(primaryAfterFirstFailure.failureCount, 1);
    assert.equal(primaryAfterFirstFailure.lastFailureReason, 'connect_timeout');

    const secondResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fallback-model',
        input: 'hello again',
      }),
    });

    assert.equal(secondResponse.status, 200);
    const secondBody = await secondResponse.json() as { id?: string };
    assert.equal(secondBody.id, 'resp_fallback_success');
    assert.equal(fallbackRequests, 2);
    const primaryAfterSecondFailure = await getPrimaryHealth(`http://127.0.0.1:${proxyPort}/admin/stats`);
    assert.equal(primaryAfterSecondFailure.state, 'open');
    assert.equal(primaryAfterSecondFailure.failureCount, 1);
    assert.equal(primaryAfterSecondFailure.lastFailureReason, 'connect_timeout');
    console.log('response assertions passed');

    const output = stdout.join('');
    assert.match(output, /upstream connect timeout encountered, falling back/);
    assert.match(output, /endpoint circuit opened/);
    assert.match(output, /skipping upstream during circuit cooldown/);
    assert.match(output, /fallback upstream succeeded/);

    console.log('Connect-timeout fallback check passed.');
  } finally {
    proxy.kill('SIGTERM');
    for (const socket of hangingSockets) {
      socket.destroy();
    }
    primary.close();
    fallback.close();
    await Promise.race([
      once(proxy, 'exit'),
      delay(3000).then(() => {
        proxy.kill('SIGKILL');
      }),
    ]);
    await once(primary, 'close');
    await once(fallback, 'close');
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

process.on('beforeExit', () => {
  if (process.exitCode === undefined || process.exitCode === 0) {
    process.exit(0);
  }
});
