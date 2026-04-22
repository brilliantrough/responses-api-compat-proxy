import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createConfigFileStoreFromPaths } from '../src/config-files.js';
import { createRuntimeConfigStore } from '../src/runtime-config.js';
import { createAdminHandler, isLocalhost } from '../src/admin-api.js';

const allTempDirs: string[] = [];
const allServers: import('node:http').Server[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'responses-admin-api-'));
  allTempDirs.push(dir);
  return dir;
}

function writeDotEnv(envPath: string, lines: string[]) {
  const full = lines.join('\n');
  writeFileSync(envPath, full, 'utf8');
}

function writeFallbackJson(filePath: string, content: unknown) {
  writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
}

function writeModelMapJson(filePath: string, content: unknown) {
  writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
}

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
): Promise<{ server: import('node:http').Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled && !res.headersSent && !res.writableEnded) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    allServers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
  });
}

async function main() {
  try {
    console.log('=== 1. isLocalhost helper ===');
    assert.equal(isLocalhost('127.0.0.1'), true);
    assert.equal(isLocalhost('::1'), true);
    assert.equal(isLocalhost('::ffff:127.0.0.1'), true);
    assert.equal(isLocalhost('192.168.1.1'), false);
    assert.equal(isLocalhost(undefined), false);
    assert.equal(isLocalhost('10.0.0.1'), false);

    // Use two separate dirs: envDir has .env, configDir has fallback.json + model-map.json.
    // This proves the store uses explicit paths from runtime snapshot, not guessed from .env dir.
    console.log('=== 2. Setup with separated env and config dirs ===');
    const envDir = makeTempDir();
    const configDir = makeTempDir();

    const envPath = path.join(envDir, '.env');
    const fallbackPath = path.join(configDir, 'fallback.json');
    const modelMapPath = path.join(configDir, 'model-map.json');

    writeFallbackJson(fallbackPath, { fallback_api_config: [] });
    writeModelMapJson(modelMapPath, { model_mappings: {} });
    writeDotEnv(envPath, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PRIMARY_PROVIDER_DEFAULT_MODEL=gpt-4o-test',
      'PORT=0',
      'HOST=127.0.0.1',
      `FALLBACK_CONFIG_PATH=${fallbackPath}`,
      `MODEL_MAP_PATH=${modelMapPath}`,
    ]);

    const runtimeStore = createRuntimeConfigStore({ envPath });
    const snap = runtimeStore.getSnapshot();
    assert.equal(snap.config.fallbackConfigPath, fallbackPath, 'runtime snapshot should have correct fallback path');
    assert.equal(snap.config.modelMappingPath, modelMapPath, 'runtime snapshot should have correct model-map path');

    // Use explicit paths from snapshot — same pattern as json-proxy.ts
    const configStore = createConfigFileStoreFromPaths({
      envPath,
      fallbackPath: snap.config.fallbackConfigPath,
      modelMapPath: snap.config.modelMappingPath,
    });
    const adminHandler = createAdminHandler({ configStore, runtimeStore });
    const { port } = await startServer(adminHandler);
    const baseUrl = `http://127.0.0.1:${port}`;

    console.log(`Test server started on port ${port}`);
    console.log(`envDir=${envDir}, configDir=${configDir}`);

    console.log('=== 3. GET /admin/config returns 200 with masked secrets ===');
    const getConfigRes = await fetch(`${baseUrl}/admin/config`);
    assert.equal(getConfigRes.status, 200);
    const getConfigBody = (await getConfigRes.json()) as Record<string, unknown>;
    assert.ok(getConfigBody.config, 'response should have config');
    const config = getConfigBody.config as Record<string, unknown>;
    assert.ok(Array.isArray(config.env), 'config should have env array');

    const envArr = config.env as Array<Record<string, unknown>>;
    const apiKeyEntry = envArr.find((e) => e.key === 'PRIMARY_PROVIDER_API_KEY');
    assert.ok(apiKeyEntry, 'API key should appear in env');
    assert.equal(apiKeyEntry.value, '***', 'API key must be masked');
    assert.equal(typeof getConfigBody.runtimeVersion, 'number', 'should have runtimeVersion');
    assert.ok(Array.isArray(getConfigBody.restartRequiredFields), 'should have restartRequiredFields');

    console.log('=== 4. POST /admin/config/validate validates draft without writing files ===');
    const envBeforeValidate = readFileSync(envPath, 'utf8');
    const fbBeforeValidate = readFileSync(fallbackPath, 'utf8');
    const validateRes = await fetch(`${baseUrl}/admin/config/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: [{ key: 'SOME_KEY', value: 'new-value' }],
        fallbackProviders: [{ name: 'fb-1', baseUrl: 'https://fb.example', apiKeyMode: 'none' }],
        modelMappings: { 'test-alias': 'test-model' },
      }),
    });
    assert.equal(validateRes.status, 200);
    const validateBody = (await validateRes.json()) as Record<string, unknown>;
    assert.equal(validateBody.ok, true);
    assert.equal(validateBody.valid, true, 'valid draft should return valid:true');

    assert.equal(readFileSync(envPath, 'utf8'), envBeforeValidate, 'validate must not modify .env');
    assert.equal(readFileSync(fallbackPath, 'utf8'), fbBeforeValidate, 'validate must not modify fallback.json');

    // Validate with bad draft
    const badValidateRes = await fetch(`${baseUrl}/admin/config/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: 'not-an-array',
        fallbackProviders: [{ baseUrl: '' }],
        modelMappings: 'wrong',
      }),
    });
    assert.equal(badValidateRes.status, 200);
    const badValidateBody = (await badValidateRes.json()) as Record<string, unknown>;
    assert.equal(badValidateBody.valid, false, 'invalid draft should return valid:false');
    assert.ok(Array.isArray(badValidateBody.errors), 'invalid draft should list errors');
    assert.ok((badValidateBody.errors as string[]).length > 0, 'should have at least one error');

    console.log('=== 5. PUT /admin/config writes to correct (separated) paths and reloads ===');
    const putRes = await fetch(`${baseUrl}/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: [{ key: 'PRIMARY_PROVIDER_API_KEY', secretAction: 'keep' }],
        fallbackProviders: [],
        modelMappings: { 'new-alias': 'new-target' },
      }),
    });
    assert.equal(putRes.status, 200);
    const putBody = (await putRes.json()) as Record<string, unknown>;
    assert.equal(putBody.ok, true);
    assert.ok(
      (putBody.runtimeVersion as number) >= 2,
      'runtimeVersion should be incremented after save+reload',
    );

    // Verify write went to configDir, NOT envDir
    const modelMapInConfigDir = JSON.parse(readFileSync(modelMapPath, 'utf8'));
    assert.deepEqual(
      modelMapInConfigDir.model_mappings,
      { 'new-alias': 'new-target' },
      'model-map.json in configDir should have new mappings',
    );

    // Verify no spillover into envDir
    const { existsSync } = await import('node:fs');
    assert.ok(
      !existsSync(path.join(envDir, 'model-map.json')),
      'no model-map.json should exist in envDir',
    );
    assert.ok(
      !existsSync(path.join(envDir, 'fallback.json')),
      'no fallback.json should exist in envDir',
    );

    console.log('=== 6. POST /admin/config/reload returns 200 ===');
    const reloadRes = await fetch(`${baseUrl}/admin/config/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(reloadRes.status, 200);
    const reloadBody = (await reloadRes.json()) as Record<string, unknown>;
    assert.equal(reloadBody.ok, true);
    assert.ok(typeof reloadBody.runtimeVersion === 'number');

    console.log('=== 7. POST /admin/config/rollback restores previous config ===');
    const rollbackRes = await fetch(`${baseUrl}/admin/config/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(rollbackRes.status, 200);
    const rollbackBody = (await rollbackRes.json()) as Record<string, unknown>;
    assert.equal(rollbackBody.ok, true);
    const restored = rollbackBody.restored as string[];
    assert.ok(Array.isArray(restored));
    assert.ok(restored.length > 0, 'should have restored some files');

    const modelMapAfterRollback = JSON.parse(readFileSync(modelMapPath, 'utf8'));
    assert.deepEqual(
      modelMapAfterRollback.model_mappings,
      {},
      'model-map should be back to empty after rollback',
    );

    console.log('=== 8. Unknown admin route returns 404 ===');
    const unknownRes = await fetch(`${baseUrl}/admin/unknown`);
    assert.equal(unknownRes.status, 404);

    console.log('=== 9. Invalid JSON body on validate returns 400 ===');
    const badJsonRes = await fetch(`${baseUrl}/admin/config/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{',
    });
    assert.equal(badJsonRes.status, 400);

    console.log('\nAll admin-config-api checks passed.');
  } finally {
    for (const server of allServers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const d of allTempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  }
}

main();
