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
    } catch {}
    await delay(150);
  }
  throw new Error(`Timed out waiting for proxy health at ${url}`);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-reload-race-'));
  let seenUpstreamModels: string[] = [];

  // Upstream that delays 500ms before responding
  const primary = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string };
      seenUpstreamModels.push(body.model);

      // Delay so the request stays in-flight across a reload
      await delay(500);

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'resp_race',
        object: 'response',
        status: 'completed',
        model: body.model,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        output: [
          {
            id: 'msg_race',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'ok', annotations: [] }],
          },
        ],
      }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  primary.listen(0, '127.0.0.1');
  await once(primary, 'listening');
  const primaryAddress = primary.address();
  if (!primaryAddress || typeof primaryAddress === 'string') {
    throw new Error('Failed to resolve primary address');
  }

  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  await writeFile(fallbackConfigPath, JSON.stringify({ fallback_api_config: [] }, null, 2), 'utf8');

  const modelMapPath = path.join(tempDir, 'model-map.json');
  await writeFile(
    modelMapPath,
    JSON.stringify({ model_mappings: { 'alias': 'old-target' } }, null, 2),
    'utf8',
  );

  const envPath = path.join(tempDir, '.env');
  await writeFile(envPath, [
    'PRIMARY_PROVIDER_NAME=race-primary',
    `PRIMARY_PROVIDER_BASE_URL=http://127.0.0.1:${primaryAddress.port}`,
    'PRIMARY_PROVIDER_API_KEY=test-key-123',
    `FALLBACK_CONFIG_PATH=${fallbackConfigPath}`,
    `MODEL_MAP_PATH=${modelMapPath}`,
  ].join('\n'), 'utf8');

  const proxyPort = primaryAddress.port + 1;
  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/json-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'admin-model-reload-race',
      PRIMARY_PROVIDER_NAME: 'race-primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'test-key-123',
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
      MODEL_MAP_PATH: modelMapPath,
      PROXY_ENV_PATH: envPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr: string[] = [];
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    // Step 1: Fire request A (with old mapping), it will delay 500ms upstream
    console.log('=== Step 1: Fire request A with old mapping ===');
    seenUpstreamModels = [];
    const reqAPromise = fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alias', input: 'hello A' }),
    });

    // Wait a bit so request A is in-flight
    await delay(100);

    // Step 2: Change model-map and reload
    console.log('=== Step 2: Modify model-map and reload ===');
    await writeFile(
      modelMapPath,
      JSON.stringify({ model_mappings: { 'alias': 'new-target' } }, null, 2),
      'utf8',
    );

    const reloadRes = await fetch(`http://127.0.0.1:${proxyPort}/admin/config/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(reloadRes.status, 200);

    // Step 3: Fire request B (should use new mapping)
    console.log('=== Step 3: Fire request B with new mapping ===');
    const reqBPromise = fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alias', input: 'hello B' }),
    });

    // Step 4: Wait for both
    const [resA, resB] = await Promise.all([reqAPromise, reqBPromise]);
    assert.equal(resA.status, 200, 'request A should return 200');
    assert.equal(resB.status, 200, 'request B should return 200');

    // Step 5: Assert request A used old-target, request B used new-target
    console.log('=== Step 4: Assert request isolation ===');
    console.log(`  seenUpstreamModels: ${JSON.stringify(seenUpstreamModels)}`);
    assert.equal(seenUpstreamModels.length, 2, 'should have exactly 2 upstream requests');
    assert.equal(seenUpstreamModels[0], 'old-target', 'request A should use old-target');
    assert.equal(seenUpstreamModels[1], 'new-target', 'request B should use new-target');

    console.log('\nAll admin-model-reload-race checks passed.');
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([
      once(proxy, 'exit'),
      delay(3000).then(() => { proxy.kill('SIGKILL'); }),
    ]);
    primary.close();
    await once(primary, 'close');
    await rm(tempDir, { recursive: true, force: true });
  }

  if (stderr.length > 0) {
    const stderrText = stderr.join('').trim();
    if (stderrText.length > 0) console.error(stderrText);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
