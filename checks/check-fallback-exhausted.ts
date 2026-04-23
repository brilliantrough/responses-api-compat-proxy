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
      if (response.ok) return;
    } catch {
      // proxy not ready yet
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for proxy health at ${url}`);
}

function create524Server(name: string) {
  return createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      res.writeHead(524, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body><h1>${name} timeout</h1></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-fallback-exhausted-'));
  const hangingSockets = new Set<import('node:net').Socket>();

  const primary = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end('event: response.created\ndata: {"type":"response.created"}\n\n');
      return;
    }
    res.writeHead(404).end();
  });

  const badA = create524Server('bad-a');
  const badB = create524Server('bad-b');
  const blackhole = createNetServer(socket => {
    hangingSockets.add(socket);
    socket.on('close', () => hangingSockets.delete(socket));
  });

  primary.listen(0, '127.0.0.1');
  badA.listen(0, '127.0.0.1');
  badB.listen(0, '127.0.0.1');
  blackhole.listen(0, '127.0.0.1');
  await Promise.all([once(primary, 'listening'), once(badA, 'listening'), once(badB, 'listening'), once(blackhole, 'listening')]);

  const primaryAddress = primary.address();
  const badAAddress = badA.address();
  const badBAddress = badB.address();
  const blackholeAddress = blackhole.address();
  if (
    !primaryAddress || typeof primaryAddress === 'string' ||
    !badAAddress || typeof badAAddress === 'string' ||
    !badBAddress || typeof badBAddress === 'string' ||
    !blackholeAddress || typeof blackholeAddress === 'string'
  ) {
    throw new Error('Failed to resolve mock server addresses');
  }

  const proxyPort = blackholeAddress.port + 1;
  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  await writeFile(
    fallbackConfigPath,
    JSON.stringify({
      fallback_api_config: [
        { name: 'bad-a', base_url: `http://127.0.0.1:${badAAddress.port}`, api_key: 'a-key' },
        { name: 'bad-b', base_url: `http://127.0.0.1:${badBAddress.port}`, api_key: 'b-key' },
        { name: 'blackhole-fallback', base_url: `http://127.0.0.1:${blackholeAddress.port}`, api_key: 'c-key' },
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
      INSTANCE_NAME: 'responses-proxy-fallback-exhausted-check',
      PRIMARY_PROVIDER_NAME: 'bad-sse-primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'primary-key',
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
      PROXY_NON_STREAM_TIMEOUT_MS: '300',
      PROXY_UPSTREAM_TIMEOUT_MS: '300',
      PROXY_FIRST_BYTE_TIMEOUT_MS: '300',
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

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fallback-model', input: 'hello', stream: false }),
    });

    assert.equal(response.status, 504);
    const body = await response.json() as { error?: { message?: string; details?: unknown } };
    assert.match(body.error?.message ?? '', /No upstream endpoint produced a usable response/);
    assert.match(JSON.stringify(body.error?.details), /blackhole-fallback/);
    assert.match(JSON.stringify(body.error?.details), /connect_timeout|timeout/);

    const output = stdout.join('');
    assert.match(output, /failed to normalize sse payload, falling back/);
    assert.match(output, /fallback exhausted/);
    assert.doesNotMatch(output, /unhandled proxy error/);

    console.log('Fallback exhausted check passed.');
  } finally {
    proxy.kill('SIGTERM');
    for (const socket of hangingSockets) socket.destroy();
    primary.close();
    badA.close();
    badB.close();
    blackhole.close();
    await Promise.race([once(proxy, 'exit'), delay(3000).then(() => proxy.kill('SIGKILL'))]);
    await Promise.all([once(primary, 'close'), once(badA, 'close'), once(badB, 'close'), once(blackhole, 'close')]);
    await rm(tempDir, { recursive: true, force: true });
  }

  const stderrText = stderr.join('').trim();
  if (stderrText.length > 0) console.error(stderrText);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
