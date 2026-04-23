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

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-stream-terminated-'));
  let primaryRequests = 0;
  let fallbackRequests = 0;

  const primary = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      primaryRequests += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('event: response.created\n');
      res.write('data: {"type":"response.created","response":{"id":"resp_terminated","status":"in_progress","model":"primary-model"}}\n\n');
      setTimeout(() => {
        res.socket?.destroy();
      }, 50);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const fallback = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      fallbackRequests += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end([
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_fallback","status":"in_progress","model":"fallback-model"}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"fallback text"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_fallback","status":"completed","model":"fallback-model","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"fallback text","annotations":[]}]}]}}',
        '',
      ].join('\n'));
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
      fallback_api_config: [
        { name: 'fallback-a', base_url: `http://127.0.0.1:${fallbackAddress.port}`, api_key: 'fallback-key' },
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
      INSTANCE_NAME: 'responses-proxy-stream-terminated-check',
      PRIMARY_PROVIDER_NAME: 'terminated-primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'primary-key',
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
      PROXY_STREAM_IDLE_TIMEOUT_MS: '2000',
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
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model: 'fallback-model', input: 'hello', stream: true }),
    });

    const text = await response.text();
    if (response.status !== 200) {
      throw new Error(`Expected 200 but got ${response.status}\nBody: ${text}\nSTDOUT:\n${stdout.join('')}\nSTDERR:\n${stderr.join('')}`);
    }
    assert.match(text, /fallback text/);
    assert.equal(primaryRequests, 1);
    assert.equal(fallbackRequests, 1);

    const output = stdout.join('');
    assert.match(output, /stream read error before usable output, falling back/);
    assert.match(output, /fallbackReason":"stream_no_text_content/);

    console.log('Stream terminated fallback check passed.');
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([once(proxy, 'exit'), delay(3000).then(() => proxy.kill('SIGKILL'))]);
    primary.close();
    fallback.close();
    await Promise.all([once(primary, 'close'), once(fallback, 'close')]);
    await rm(tempDir, { recursive: true, force: true });
  }

  const stderrText = stderr.join('').trim();
  if (stderrText.length > 0) console.error(stderrText);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
