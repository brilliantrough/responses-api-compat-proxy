import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function writeDotEnv(dir: string, content: string) {
  writeFileSync(path.join(dir, '.env'), content, 'utf8');
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
    writeDotEnv(dir1, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PRIMARY_PROVIDER_DEFAULT_MODEL=gpt-4o-test',
      'PORT=8080',
      'HOST=0.0.0.0',
    ].join('\n'));
    writeFallbackJson(dir1, { fallback_api_config: [] });
    writeModelMapJson(dir1, { model_mappings: {} });

    const store1 = createRuntimeConfigStore({ envPath: path.join(dir1, '.env') });
    const snap1 = store1.getSnapshot();

    assert.equal(snap1.runtimeVersion, 1, 'initial runtimeVersion should be 1');
    assert.equal(snap1.config.defaultModel, 'gpt-4o-test', 'default model from env');
    assert.equal(snap1.config.port, 8080, 'port from env');
    assert.equal(snap1.envPath, path.join(dir1, '.env'), 'envPath in snapshot');
    assert.deepEqual(snap1.restartRequiredFields, [], 'no restart required on initial load');

    // === 2. Successful reload increments version and changes config values ===
    console.log('=== 2. Successful reload increments version ===');
    writeDotEnv(dir1, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PRIMARY_PROVIDER_DEFAULT_MODEL=gpt-4o-updated',
      'PORT=8080',
      'HOST=0.0.0.0',
    ].join('\n'));

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
    ].join('\n'));

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
    ].join('\n'));

    const result3b = store1.reloadFromFiles();
    assert.equal(result3b.ok, true);
    const snap3b = store1.getSnapshot();
    assert.ok(snap3b.restartRequiredFields.includes('HOST'), 'HOST should be in restartRequiredFields');

    // === 4. Failed reload keeps prior snapshot/version ===
    console.log('=== 4. Failed reload keeps prior snapshot ===');
    writeDotEnv(dir1, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
    ].join('\n'));

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

    console.log('\nAll runtime-reload checks passed.');
  } finally {
    for (const d of allTempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  }
}

main();
