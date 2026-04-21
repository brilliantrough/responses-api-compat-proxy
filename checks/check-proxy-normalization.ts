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

import type { JsonValue } from '../src/responses-input-normalization.js';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeResponseBody() {
  return {
    id: 'resp_mock_proxy_normalization',
    object: 'response',
    status: 'completed',
    model: 'mock-model',
    output: [
      {
        id: 'msg_mock_proxy_normalization',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      },
    ],
  };
}

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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-check-'));
  const fallbackConfigPath = path.join(tempDir, 'fallback.empty.json');
  await writeFile(fallbackConfigPath, JSON.stringify({ fallback_api_config: [] }, null, 2), 'utf8');

  let capturedRequestBody: JsonValue | undefined;

  const upstream = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      capturedRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonValue;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(makeResponseBody()));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
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

  const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  const proxyPort = upstreamAddress.port + 1;
  const tsxCliPath = require.resolve('tsx/cli');

  const proxy = spawn(process.execPath, [tsxCliPath, 'src/json-proxy.ts'], {
    cwd: workspaceRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(proxyPort),
        INSTANCE_NAME: 'responses-proxy-regression-check',
        PRIMARY_PROVIDER_NAME: 'mock-primary',
        PRIMARY_PROVIDER_BASE_URL: upstreamBaseUrl,
        PRIMARY_PROVIDER_API_KEY: 'mock-key',
        PROXY_PROMPT_CACHE_RETENTION: '24h',
        PROXY_PROMPT_CACHE_KEY: 'proxy-default-cache-key',
        PROXY_CLEAR_DEVELOPER_CONTENT: '1',
        PROXY_CLEAR_SYSTEM_CONTENT: '1',
        PROXY_CLEAR_INSTRUCTIONS: '1',
        PROXY_OVERRIDE_INSTRUCTIONS_TEXT: 'x',
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
        model: 'mock-model',
        instructions: 'Top-level hidden instructions',
        input: [
          {
            role: 'system',
            content: [{ type: 'input_text', text: 'Do not forward system rule' }],
          },
          {
            role: 'developer',
            content: [{ type: 'input_text', text: 'Do not forward me' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'input_text', text: 'Prior assistant turn' }],
          },
          {
            role: 'user',
            content: [{ type: 'output_text', text: 'Current user turn', annotations: [] }],
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.ok(capturedRequestBody && typeof capturedRequestBody === 'object' && !Array.isArray(capturedRequestBody));

    const upstreamBody = capturedRequestBody as {
      input?: unknown;
      stream?: unknown;
      instructions?: unknown;
      prompt_cache_key?: unknown;
      prompt_cache_retention?: unknown;
    };
    assert.equal(upstreamBody.stream, false);
    assert.equal(upstreamBody.instructions, 'x');
    assert.equal(upstreamBody.prompt_cache_key, 'proxy-default-cache-key');
    assert.equal(upstreamBody.prompt_cache_retention, '24h');
    assert.deepEqual(upstreamBody.input, [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '' }],
      },
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Prior assistant turn' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Current user turn' }],
      },
    ]);

    console.log('Proxy normalization regression check passed.');
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

  if (stderr.length > 0) {
    const stderrText = stderr.join('').trim();
    if (stderrText.length > 0) {
      console.error(stderrText);
    }
  }

  if (stdout.length > 0) {
    const stdoutText = stdout.join('').trim();
    if (stdoutText.length > 0) {
      console.log(stdoutText);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
