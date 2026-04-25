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

function createFallbackServer() {
  return createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_connect_error_fallback","object":"response","status":"completed","model":"fallback-model","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"fallback ok","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}',
        '',
      ].join('\n'));
      return;
    }
    res.writeHead(404).end();
  });
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-connect-error-fallback-'));
  const fallback = createFallbackServer();
  const closedPrimary = createServer((_req, res) => res.writeHead(500).end());
  const proxyPortHolder = createServer((_req, res) => res.writeHead(500).end());
  fallback.listen(0, '127.0.0.1');
  closedPrimary.listen(0, '127.0.0.1');
  proxyPortHolder.listen(0, '127.0.0.1');
  await Promise.all([once(fallback, 'listening'), once(closedPrimary, 'listening'), once(proxyPortHolder, 'listening')]);

  const fallbackAddress = fallback.address();
  const closedPrimaryAddress = closedPrimary.address();
  const proxyAddress = proxyPortHolder.address();
  if (
    !fallbackAddress || typeof fallbackAddress === 'string' ||
    !closedPrimaryAddress || typeof closedPrimaryAddress === 'string' ||
    !proxyAddress || typeof proxyAddress === 'string'
  ) {
    throw new Error('Failed to resolve mock server addresses');
  }

  const unusedPrimaryPort = closedPrimaryAddress.port;
  const proxyPort = proxyAddress.port;
  await Promise.all([
    new Promise<void>(resolve => closedPrimary.close(() => resolve())),
    new Promise<void>(resolve => proxyPortHolder.close(() => resolve())),
  ]);

  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  await writeFile(
    fallbackConfigPath,
    JSON.stringify({
      fallback_api_config: [
        { name: 'working-fallback', base_url: `http://127.0.0.1:${fallbackAddress.port}`, api_key: 'fallback-key' },
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
      INSTANCE_NAME: 'responses-proxy-connect-error-fallback-check',
      PRIMARY_PROVIDER_NAME: 'closed-primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${unusedPrimaryPort}`,
      PRIMARY_PROVIDER_API_KEY: 'primary-key',
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
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
      body: JSON.stringify({ model: 'fallback-model', input: 'hello', stream: true }),
    });

    assert.equal(response.status, 200, 'connect-level primary failure should fallback instead of returning 500');
    const body = await response.text();
    assert.match(body, /fallback ok/);

    const output = stdout.join('');
    assert.match(output, /upstream connect error encountered, falling back/);
    assert.match(output, /fallback upstream succeeded/);
    assert.doesNotMatch(output, /unhandled proxy error/);

    console.log('Connect error fallback check passed.');
  } finally {
    proxy.kill('SIGTERM');
    fallback.close();
    await Promise.race([once(proxy, 'exit'), delay(3000).then(() => proxy.kill('SIGKILL'))]);
    await once(fallback, 'close');
    await rm(tempDir, { recursive: true, force: true });
  }

  const stderrText = stderr.join('').trim();
  if (stderrText.length > 0) console.error(stderrText);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
