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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-admin-model-reload-'));
  let seenUpstreamModel: string | undefined;

  const primary = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string };
      seenUpstreamModel = body.model;

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'resp_admin_reload',
        object: 'response',
        status: 'completed',
        model: body.model,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        output: [
          {
            id: 'msg_admin_reload',
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
    JSON.stringify({
      model_mappings: { 'alias': 'old-target' },
    }, null, 2),
    'utf8',
  );

  const envPath = path.join(tempDir, '.env');
  const envContent = [
    'PRIMARY_PROVIDER_NAME=reload-test-primary',
    `PRIMARY_PROVIDER_BASE_URL=http://127.0.0.1:${primaryAddress.port}`,
    'PRIMARY_PROVIDER_API_KEY=test-key-123',
    `FALLBACK_CONFIG_PATH=${fallbackConfigPath}`,
    `MODEL_MAP_PATH=${modelMapPath}`,
  ].join('\n');
  await writeFile(envPath, envContent, 'utf8');

  const proxyPort = primaryAddress.port + 1;
  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/json-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'admin-model-reload-check',
      PRIMARY_PROVIDER_NAME: 'reload-test-primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'test-key-123',
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
      MODEL_MAP_PATH: modelMapPath,
      PROXY_ENV_PATH: envPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  proxy.stdout.on('data', chunk => stdout.push(String(chunk)));
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    // Step 1: First request with alias -> old-target
    console.log('=== Step 1: First request with alias maps to old-target ===');
    seenUpstreamModel = undefined;
    const res1 = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alias', input: 'hello' }),
    });
    assert.equal(res1.status, 200, `first request should return 200, got ${res1.status}`);
    assert.equal(seenUpstreamModel, 'old-target', `first request should forward model=old-target, got ${seenUpstreamModel}`);

    // Step 2: Check initial runtimeVersion
    console.log('=== Step 2: Check initial runtimeVersion ===');
    const configRes1 = await fetch(`http://127.0.0.1:${proxyPort}/admin/config`);
    assert.equal(configRes1.status, 200);
    const configBody1 = (await configRes1.json()) as Record<string, unknown>;
    const versionBefore = configBody1.runtimeVersion as number;
    console.log(`  runtimeVersion before reload: ${versionBefore}`);

    // Step 3: Modify model-map to map alias -> new-target
    console.log('=== Step 3: Modify model-map to alias -> new-target ===');
    await writeFile(
      modelMapPath,
      JSON.stringify({
        model_mappings: { 'alias': 'new-target' },
      }, null, 2),
      'utf8',
    );

    // Step 4: POST /admin/config/reload
    console.log('=== Step 4: POST /admin/config/reload ===');
    const reloadRes = await fetch(`http://127.0.0.1:${proxyPort}/admin/config/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(reloadRes.status, 200, `reload should return 200, got ${reloadRes.status}`);
    const reloadBody = (await reloadRes.json()) as Record<string, unknown>;
    assert.equal(reloadBody.ok, true, 'reload should return ok:true');
    const versionAfter = reloadBody.runtimeVersion as number;
    assert.ok(versionAfter > versionBefore, `runtimeVersion should increment: ${versionAfter} > ${versionBefore}`);

    // Step 5: Second request with alias -> new-target (without process restart)
    console.log('=== Step 5: Second request with alias maps to new-target ===');
    seenUpstreamModel = undefined;
    const res2 = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alias', input: 'hello after reload' }),
    });
    assert.equal(res2.status, 200, `second request should return 200, got ${res2.status}`);
    assert.equal(seenUpstreamModel, 'new-target', `after reload, alias should map to new-target, got ${seenUpstreamModel}`);

    // Step 6: Confirm runtimeVersion in /admin/config also incremented
    console.log('=== Step 6: Confirm runtimeVersion in GET /admin/config ===');
    const configRes2 = await fetch(`http://127.0.0.1:${proxyPort}/admin/config`);
    const configBody2 = (await configRes2.json()) as Record<string, unknown>;
    assert.ok(
      (configBody2.runtimeVersion as number) > versionBefore,
      `GET /admin/config runtimeVersion should be > ${versionBefore}`,
    );

    console.log('\nAll admin-model-reload checks passed.');
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
    if (stderrText.length > 0) {
      console.error(stderrText);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
