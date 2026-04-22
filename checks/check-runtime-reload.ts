import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createRuntimeConfigStore,
  createEndpointStateKey,
} from '../src/runtime-config.js';

const allTempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'responses-runtime-'));
  allTempDirs.push(dir);
  return dir;
}

function writeDotEnv(dir: string, lines: string[]) {
  const envPath = path.join(dir, '.env');
  const fallbackPath = path.join(dir, 'fallback.json');
  const modelMapPath = path.join(dir, 'model-map.json');
  const full = [
    ...lines,
    `FALLBACK_CONFIG_PATH=${fallbackPath}`,
    `MODEL_MAP_PATH=${modelMapPath}`,
  ].join('\n');
  writeFileSync(envPath, full, 'utf8');
}

function writeFallbackJson(dir: string, content: unknown) {
  writeFileSync(path.join(dir, 'fallback.json'), JSON.stringify(content, null, 2), 'utf8');
}

function writeModelMapJson(dir: string, content: unknown) {
  writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify(content, null, 2), 'utf8');
}

function main() {
  try {
    // === 1. Initial runtimeVersion 1 and default model from env file ===
    console.log('=== 1. Initial runtimeVersion 1 and default model ===');
    const dir1 = makeTempDir();
    writeFallbackJson(dir1, { fallback_api_config: [] });
    writeModelMapJson(dir1, { model_mappings: {} });
    writeDotEnv(dir1, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PRIMARY_PROVIDER_DEFAULT_MODEL=gpt-4o-test',
      'PORT=8080',
      'HOST=0.0.0.0',
    ]);

    const store1 = createRuntimeConfigStore({ envPath: path.join(dir1, '.env') });
    const snap1 = store1.getSnapshot();

    assert.equal(snap1.runtimeVersion, 1, 'initial runtimeVersion should be 1');
    assert.equal(snap1.config.defaultModel, 'gpt-4o-test', 'default model from env');
    assert.equal(snap1.config.port, 8080, 'port from env');
    assert.equal(snap1.envPath, path.join(dir1, '.env'), 'envPath in snapshot');
    assert.deepEqual(snap1.restartRequiredFields, [], 'no restart required on initial load');
    assert.deepEqual(snap1.config.fallbackEndpoints, [], 'no fallback endpoints initially');
    assert.deepEqual(snap1.config.modelMappings, {}, 'no model mappings initially');

    // === 2. Successful reload increments version and changes config values ===
    console.log('=== 2. Successful reload increments version ===');
    writeDotEnv(dir1, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PRIMARY_PROVIDER_DEFAULT_MODEL=gpt-4o-updated',
      'PORT=8080',
      'HOST=0.0.0.0',
    ]);

    const result2 = store1.reloadFromFiles();
    assert.equal(result2.ok, true, 'reload should succeed');
    const snap2 = store1.getSnapshot();
    assert.equal(snap2.runtimeVersion, 2, 'version incremented after reload');
    assert.equal(snap2.config.defaultModel, 'gpt-4o-updated', 'model updated after reload');

    // === 3. Changing PORT reports restartRequiredFields ["PORT"] ===
    console.log('=== 3. PORT change reports restartRequiredFields ===');
    writeDotEnv(dir1, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PORT=9090',
      'HOST=0.0.0.0',
    ]);

    const result3 = store1.reloadFromFiles();
    assert.equal(result3.ok, true, 'reload with port change should succeed');
    const snap3 = store1.getSnapshot();
    assert.ok(snap3.restartRequiredFields.includes('PORT'), 'PORT should be in restartRequiredFields');

    // === 3b. Changing HOST reports restartRequiredFields ["HOST"] ===
    console.log('=== 3b. HOST change reports restartRequiredFields ===');
    writeDotEnv(dir1, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PORT=9090',
      'HOST=127.0.0.1',
    ]);

    const result3b = store1.reloadFromFiles();
    assert.equal(result3b.ok, true);
    const snap3b = store1.getSnapshot();
    assert.ok(snap3b.restartRequiredFields.includes('HOST'), 'HOST should be in restartRequiredFields');

    // === 4. Failed reload keeps prior snapshot/version ===
    console.log('=== 4. Failed reload keeps prior snapshot ===');
    writeDotEnv(dir1, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
    ]);

    const result4 = store1.reloadFromFiles();
    assert.equal(result4.ok, false, 'reload without API key should fail');
    if (!result4.ok) {
      assert.ok(result4.error, 'should have error message');
    }
    const snap4 = store1.getSnapshot();
    assert.equal(snap4.runtimeVersion, snap3b.runtimeVersion, 'version unchanged after failed reload');
    assert.equal(snap4.config.host, '127.0.0.1', 'config unchanged after failed reload');
    assert.equal(snap4.config.port, 9090, 'port unchanged after failed reload');

    // === 5. createEndpointStateKey stability ===
    console.log('=== 5. createEndpointStateKey ===');
    const key1 = createEndpointStateKey({ name: 'primary', url: 'https://api.example/v1/responses' });
    const key2 = createEndpointStateKey({ name: 'primary', url: 'https://api.example/v1/responses' });
    assert.equal(key1, key2, 'same name+url produces same key');

    const key3 = createEndpointStateKey({ name: 'primary', url: 'https://other.example/v1/responses' });
    assert.notEqual(key1, key3, 'different url produces different key');

    // === 6. Fallback endpoints and model mappings loaded from files ===
    console.log('=== 6. Fallback + model-map loaded from temp files ===');
    const dir6 = makeTempDir();
    writeFallbackJson(dir6, {
      fallback_api_config: [
        { name: 'fb-alpha', base_url: 'https://fb-alpha.example', api_key: 'fb-alpha-key' },
      ],
    });
    writeModelMapJson(dir6, {
      model_mappings: {
        'alias-a': 'real-model-a',
        'alias-b': 'real-model-b',
      },
    });
    writeDotEnv(dir6, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PRIMARY_PROVIDER_DEFAULT_MODEL=gpt-4o-test',
    ]);

    const store6 = createRuntimeConfigStore({ envPath: path.join(dir6, '.env') });
    const snap6 = store6.getSnapshot();

    assert.equal(snap6.config.fallbackEndpoints.length, 1, 'one fallback endpoint loaded');
    assert.equal(snap6.config.fallbackEndpoints[0].name, 'fb-alpha', 'fallback endpoint name');
    assert.equal(snap6.config.fallbackEndpoints[0].url, 'https://fb-alpha.example/v1/responses', 'fallback endpoint url');
    assert.equal(snap6.config.modelMappings['alias-a'], 'real-model-a', 'model mapping alias-a');
    assert.equal(snap6.config.modelMappings['alias-b'], 'real-model-b', 'model mapping alias-b');

    // === 7. Unreadable env file causes reload to fail ===
    console.log('=== 7. Unreadable env file fails reload ===');
    const dir7 = makeTempDir();
    writeFallbackJson(dir7, { fallback_api_config: [] });
    writeModelMapJson(dir7, { model_mappings: {} });
    writeDotEnv(dir7, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PORT=8080',
      'HOST=0.0.0.0',
    ]);

    const store7 = createRuntimeConfigStore({ envPath: path.join(dir7, '.env') });
    assert.equal(store7.getSnapshot().runtimeVersion, 1, 'initial version');

    chmodSync(path.join(dir7, '.env'), 0o000);
    const result7 = store7.reloadFromFiles();
    assert.equal(result7.ok, false, 'reload should fail on unreadable env file');
    if (!result7.ok) {
      assert.ok(result7.error.length > 0, 'error message present');
    }
    assert.equal(store7.getSnapshot().runtimeVersion, 1, 'version preserved after read failure');
    chmodSync(path.join(dir7, '.env'), 0o644);

    console.log('\nAll runtime-reload checks passed.');
  } finally {
    for (const d of allTempDirs) {
      try { chmodSync(path.join(d, '.env'), 0o644); } catch {}
      rmSync(d, { recursive: true, force: true });
    }
  }
}

main();
