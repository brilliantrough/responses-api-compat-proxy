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

type JsonRecord = Record<string, unknown>;

function makeResponseBody() {
  return {
    id: 'resp_mock_claude_billing_header',
    object: 'response',
    status: 'completed',
    model: 'mock-model',
    output: [
      {
        id: 'msg_mock_claude_billing_header',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      },
    ],
  };
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate free port');
  }
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
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

async function captureUpstreamBody(mode?: 'strip_cch') {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-billing-header-'));
  const fallbackConfigPath = path.join(tempDir, 'fallback.empty.json');
  await writeFile(fallbackConfigPath, JSON.stringify({ fallback_api_config: [] }, null, 2), 'utf8');

  const capturedRequestBodies: JsonRecord[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      capturedRequestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRecord);
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

  const proxyPort = await getFreePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(proxyPort),
    INSTANCE_NAME: `responses-proxy-billing-header-${mode ?? 'default'}`,
    PRIMARY_PROVIDER_NAME: 'mock-primary',
    PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`,
    PRIMARY_PROVIDER_API_KEY: 'mock-key',
    FALLBACK_CONFIG_PATH: fallbackConfigPath,
    PROXY_CLEAR_DEVELOPER_CONTENT: '0',
    PROXY_CLEAR_SYSTEM_CONTENT: '0',
    PROXY_CLEAR_INSTRUCTIONS: '0',
  };
  delete env.PROXY_OVERRIDE_INSTRUCTIONS_TEXT;
  if (mode) {
    env.PROXY_CLAUDE_BILLING_HEADER_MODE = mode;
  } else {
    delete env.PROXY_CLAUDE_BILLING_HEADER_MODE;
  }

  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/json-proxy.ts'], {
    cwd: workspaceRoot,
    env,
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
        instructions:
          'x-anthropic-billing-header: cc_version=2.1.119.47e; cc_entrypoint=sdk-cli; cch=abc123;\n\nYou are stable.',
        input: [
          {
            role: 'system',
            content:
              'x-anthropic-billing-header: cc_version=2.1.119.47e; cc_entrypoint=sdk-cli; cch=def456;\n\nSystem stable.',
          },
          {
            role: 'developer',
            content: [
              {
                type: 'input_text',
                text: 'x-anthropic-billing-header: cc_version=2.1.119.47e; cc_entrypoint=sdk-cli; cch=ghi789;\nDeveloper stable.',
              },
            ],
          },
          {
            role: 'user',
            content: 'x-anthropic-billing-header: should stay user cch=user;\nUser text.',
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(capturedRequestBodies.length, 1, 'mock upstream should capture exactly one request');
    return capturedRequestBodies[0];
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

    const stderrText = stderr.join('').trim();
    if (stderrText.length > 0) {
      console.error(stderrText);
    }
    const stdoutText = stdout.join('').trim();
    if (stdoutText.length > 0) {
      console.log(stdoutText);
    }
  }
}

function getInput(body: JsonRecord) {
  assert.ok(Array.isArray(body.input), 'upstream body should have input array');
  return body.input as JsonRecord[];
}

async function main() {
  const defaultBody = await captureUpstreamBody();
  assert.equal(defaultBody.instructions, 'You are stable.');
  const defaultInput = getInput(defaultBody);
  assert.equal(defaultInput[0].role, 'developer');
  assert.equal(defaultInput[0].content, 'System stable.');
  assert.deepEqual(defaultInput[1].content, [{ type: 'input_text', text: 'Developer stable.' }]);
  assert.equal(defaultInput[2].content, 'x-anthropic-billing-header: should stay user cch=user;\nUser text.');

  const stripCchBody = await captureUpstreamBody('strip_cch');
  assert.equal(
    stripCchBody.instructions,
    'x-anthropic-billing-header: cc_version=2.1.119.47e; cc_entrypoint=sdk-cli;\n\nYou are stable.',
  );
  const stripCchInput = getInput(stripCchBody);
  assert.equal(
    stripCchInput[0].content,
    'x-anthropic-billing-header: cc_version=2.1.119.47e; cc_entrypoint=sdk-cli;\n\nSystem stable.',
  );
  assert.deepEqual(stripCchInput[1].content, [
    {
      type: 'input_text',
      text: 'x-anthropic-billing-header: cc_version=2.1.119.47e; cc_entrypoint=sdk-cli;\nDeveloper stable.',
    },
  ]);
  assert.equal(stripCchInput[2].content, 'x-anthropic-billing-header: should stay user cch=user;\nUser text.');

  console.log('Claude billing header sanitization check passed.');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
