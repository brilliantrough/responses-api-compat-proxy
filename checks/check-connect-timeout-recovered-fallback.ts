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

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-timeout-recovered-fallback-'));

  const primarySockets = new Set<import('node:net').Socket>();
  let fallbackARequests = 0;
  let fallbackBRequests = 0;

  const primary = createNetServer(socket => {
    primarySockets.add(socket);
    socket.on('close', () => {
      primarySockets.delete(socket);
    });
  });

  primary.listen(0, '127.0.0.1');
  await once(primary, 'listening');
  const primaryAddress = primary.address();
  if (!primaryAddress || typeof primaryAddress === 'string') {
    throw new Error('Failed to resolve primary address');
  }

  const fallbackA = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      fallbackARequests += 1;

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      if (fallbackARequests === 1) {
        res.end(JSON.stringify({
          id: 'resp_empty_seed',
          object: 'response',
          status: 'completed',
          model: 'fallback-a-model',
          output: [],
        }));
        return;
      }

      res.end(JSON.stringify({
        id: 'resp_recovered_success',
        object: 'response',
        status: 'completed',
        model: 'fallback-a-model',
        output: [
          {
            id: 'msg_recovered_success',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'recovered fallback ok', annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fallback-a-model', object: 'model' }] }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  fallbackA.listen(0, '127.0.0.1');
  await once(fallbackA, 'listening');
  const fallbackAAddress = fallbackA.address();
  if (!fallbackAAddress || typeof fallbackAAddress === 'string') {
    throw new Error('Failed to resolve fallback-a address');
  }

  const hangingFallbackBSockets = new Set<import('node:net').Socket>();
  const fallbackB = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      fallbackBRequests += 1;

      if (fallbackBRequests === 1) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          id: 'resp_seed_success',
          object: 'response',
          status: 'completed',
          model: 'fallback-b-model',
          output: [
            {
              id: 'msg_seed_success',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'seed ok', annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        }));
        return;
      }

      hangingFallbackBSockets.add(req.socket);
      req.socket.on('close', () => {
        hangingFallbackBSockets.delete(req.socket);
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fallback-b-model', object: 'model' }] }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  fallbackB.listen(0, '127.0.0.1');
  await once(fallbackB, 'listening');
  const fallbackBAddress = fallbackB.address();
  if (!fallbackBAddress || typeof fallbackBAddress === 'string') {
    throw new Error('Failed to resolve fallback-b address');
  }

  const proxyPort = fallbackBAddress.port + 1;
  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  await writeFile(
    fallbackConfigPath,
    JSON.stringify({
      fallback_api_config: [
        {
          name: 'fallback-a',
          base_url: `http://127.0.0.1:${fallbackAAddress.port}`,
          api_key: 'fallback-a-key',
        },
        {
          name: 'fallback-b',
          base_url: `http://127.0.0.1:${fallbackBAddress.port}`,
          api_key: 'fallback-b-key',
        },
      ],
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
      INSTANCE_NAME: 'responses-proxy-timeout-recovered-fallback-check',
      PRIMARY_PROVIDER_NAME: 'blackhole-primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'primary-key',
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
      PROXY_UPSTREAM_TIMEOUT_MS: '1000',
      PROXY_NON_STREAM_TIMEOUT_MS: '1000',
      PROXY_FIRST_BYTE_TIMEOUT_MS: '1000',
      PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS: '2000',
      PROXY_ENDPOINT_INVALID_RESPONSE_COOLDOWN_MS: '1500',
      PROXY_MAX_FALLBACK_TOTAL_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  proxy.stdout.on('data', chunk => stdout.push(String(chunk)));
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    const seedResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fallback-b-model',
        input: 'seed',
      }),
    });

    assert.equal(seedResponse.status, 200);
    const seedBody = await seedResponse.json() as { id?: string };
    assert.equal(seedBody.id, 'resp_seed_success');

    const recoveredResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fallback-a-model',
        input: 'hello after cooldown',
      }),
    });

    assert.equal(recoveredResponse.status, 200);
    const recoveredBody = await recoveredResponse.json() as { id?: string };
    assert.equal(recoveredBody.id, 'resp_recovered_success');
    assert.equal(fallbackARequests, 2);
    assert.equal(fallbackBRequests, 2);

    const output = stdout.join('');
    assert.match(output, /skipping upstream during circuit cooldown.*fallback-a/);
    assert.match(output, /upstream connect timeout encountered, falling back/);
    assert.match(output, /nextFallbackName":"fallback-a"/);
    assert.match(output, /fallback upstream succeeded.*fallback-a/);

    console.log('Recovered-fallback connect-timeout check passed.');
  } finally {
    proxy.kill('SIGTERM');
    for (const socket of primarySockets) {
      socket.destroy();
    }
    for (const socket of hangingFallbackBSockets) {
      socket.destroy();
    }
    primary.close();
    fallbackA.close();
    fallbackB.close();
    await Promise.race([
      once(proxy, 'exit'),
      delay(3000).then(() => {
        proxy.kill('SIGKILL');
      }),
    ]);
    await Promise.all([once(primary, 'close'), once(fallbackA, 'close'), once(fallbackB, 'close')]);
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
