import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createConfigFileStoreFromPaths } from '../src/config-files.js';
import { createRuntimeConfigStore } from '../src/runtime-config.js';
import { createAdminHandler } from '../src/admin-api.js';

const allTempDirs: string[] = [];
const allServers: import('node:http').Server[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'responses-snap-paths-'));
  allTempDirs.push(dir);
  return dir;
}

function writeDotEnv(envPath: string, lines: string[]) {
  writeFileSync(envPath, lines.join('\n'), 'utf8');
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
    console.log('=== 1. Setup with initial model-map path ===');
    const configDir = makeTempDir();
    const configDir2 = makeTempDir();
    const envPath = path.join(configDir, '.env');
    const fallbackPath = path.join(configDir, 'fallback.json');
    const modelMapPath1 = path.join(configDir, 'model-map.json');
    const modelMapPath2 = path.join(configDir2, 'model-map.json');

    writeFallbackJson(fallbackPath, { fallback_api_config: [] });
    writeModelMapJson(modelMapPath1, { model_mappings: { 'old-alias': 'old-target' } });
    writeModelMapJson(modelMapPath2, { model_mappings: { 'new-alias': 'new-target' } });
    writeDotEnv(envPath, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PRIMARY_PROVIDER_DEFAULT_MODEL=gpt-4o-test',
      'PORT=0',
      'HOST=127.0.0.1',
      `FALLBACK_CONFIG_PATH=${fallbackPath}`,
      `MODEL_MAP_PATH=${modelMapPath1}`,
    ]);

    const runtimeStore = createRuntimeConfigStore({ envPath });
    const snap = runtimeStore.getSnapshot();
    assert.equal(snap.config.modelMappingPath, modelMapPath1);
    const configStore = createConfigFileStoreFromPaths({
      envPath,
      fallbackPath: snap.config.fallbackConfigPath,
      modelMapPath: snap.config.modelMappingPath,
    });
    const adminHandler = createAdminHandler({ configStore, runtimeStore });
    const { port } = await startServer(adminHandler);
    const baseUrl = `http://127.0.0.1:${port}`;

    console.log('=== 2. GET /admin/config reads from initial path ===');
    const config1Res = await fetch(`${baseUrl}/admin/config`);
    const config1Body = (await config1Res.json()) as Record<string, unknown>;
    const config1 = config1Body.config as Record<string, unknown>;
    const mm1 = config1.modelMappings as Record<string, string>;
    assert.equal(mm1['old-alias'], 'old-target', 'should read from initial model-map path');

    console.log('=== 3. Change MODEL_MAP_PATH in .env and reload ===');
    writeDotEnv(envPath, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PRIMARY_PROVIDER_DEFAULT_MODEL=gpt-4o-test',
      'PORT=0',
      'HOST=127.0.0.1',
      `FALLBACK_CONFIG_PATH=${fallbackPath}`,
      `MODEL_MAP_PATH=${modelMapPath2}`,
    ]);

    const reloadRes = await fetch(`${baseUrl}/admin/config/reload`, { method: 'POST' });
    const reloadBody = (await reloadRes.json()) as Record<string, unknown>;
    assert.equal(reloadBody.ok, true, 'reload should succeed');

    console.log('=== 4. GET /admin/config now reads from new path ===');
    const config2Res = await fetch(`${baseUrl}/admin/config`);
    const config2Body = (await config2Res.json()) as Record<string, unknown>;
    const config2 = config2Body.config as Record<string, unknown>;
    const mm2 = config2.modelMappings as Record<string, string>;
    assert.equal(mm2['new-alias'], 'new-target', 'should read from new model-map path after reload');
    assert.ok(!('old-alias' in mm2), 'old-alias should not appear from new path');

    console.log('=== 5. PUT /admin/config writes to new path ===');
    const saveRes = await fetch(`${baseUrl}/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: [
          { key: 'PRIMARY_PROVIDER_NAME', value: 'test-primary' },
          { key: 'PRIMARY_PROVIDER_BASE_URL', value: 'https://api.test.example' },
          { key: 'PRIMARY_PROVIDER_API_KEY', secretAction: 'keep' },
          { key: 'PRIMARY_PROVIDER_DEFAULT_MODEL', value: 'gpt-4o-test' },
          { key: 'PORT', value: '0' },
          { key: 'HOST', value: '127.0.0.1' },
          { key: 'FALLBACK_CONFIG_PATH', value: fallbackPath },
          { key: 'MODEL_MAP_PATH', value: modelMapPath2 },
        ],
        fallbackProviders: [],
        modelMappings: { 'written-alias': 'written-target' },
      }),
    });
    assert.equal(saveRes.status, 200);

    const { readFileSync } = await import('node:fs');
    const written2 = JSON.parse(readFileSync(modelMapPath2, 'utf8'));
    assert.deepEqual(
      written2.model_mappings,
      { 'written-alias': 'written-target' },
      'write should go to new model-map path',
    );

    console.log('\nAll snapshot-paths checks passed.');
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
