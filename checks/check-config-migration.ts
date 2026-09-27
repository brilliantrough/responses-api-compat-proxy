import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRoutingConfig } from '../src/routing-config.js';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolPath = path.join(workspaceRoot, 'tools', 'migrate-routing-config.ts');
const tsxCliPath = require.resolve('tsx/cli');

function writeLegacyInstance(instanceDirectory: string, includePrimaryKey = true): void {
  writeFileSync(path.join(instanceDirectory, '.env'), [
    'PRIMARY_PROVIDER_NAME=Primary Provider',
    'PRIMARY_PROVIDER_BASE_URL=https://primary.example///',
    includePrimaryKey ? 'PRIMARY_PROVIDER_API_KEY=primary-secret-1234' : '',
    'PRIMARY_PROVIDER_DEFAULT_MODEL=canonical-model',
    'MODEL_MAP_PATH=./model-map.json',
    'FALLBACK_A_API_KEY=fallback-secret-5678',
  ].join('\n'), 'utf8');
  writeFileSync(path.join(instanceDirectory, 'fallback.json'), JSON.stringify({
    fallback_api_config: [{
      name: 'Fallback A',
      base_url: 'https://fallback-a.example/',
      api_key_env: 'FALLBACK_A_API_KEY',
    }],
  }, null, 2), 'utf8');
  writeFileSync(path.join(instanceDirectory, 'model-map.json'), JSON.stringify({
    model_mappings: {
      public_alias: 'canonical-model',
    },
  }, null, 2), 'utf8');
  chmodSync(path.join(instanceDirectory, 'fallback.json'), 0o644);
}

function runTool(instanceDirectory: string, ...args: string[]) {
  return spawnSync(process.execPath, [tsxCliPath, toolPath, instanceDirectory, ...args], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
}

function main(): void {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'responses-proxy-config-migration-'));
  try {
    const instanceDirectory = path.join(tempRoot, 'instance');
    const missingKeyDirectory = path.join(tempRoot, 'missing-key');
    mkdirSync(instanceDirectory);
    mkdirSync(missingKeyDirectory);
    writeLegacyInstance(instanceDirectory);
    writeLegacyInstance(missingKeyDirectory, false);

    const dryRun = runTool(instanceDirectory);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /"default_model": "canonical-model"/);
    assert.match(dryRun.stdout, /"id": "fallback-a"/);
    assert.match(dryRun.stdout, /\*\*\*\*1234/);
    assert.match(dryRun.stdout, /\*\*\*\*5678/);
    assert.doesNotMatch(dryRun.stdout, /primary-secret-1234|fallback-secret-5678/);
    assert.doesNotMatch(dryRun.stdout, /"fallback_api_config"/);

    const writeRun = runTool(instanceDirectory, '--write');
    assert.equal(writeRun.status, 0, writeRun.stderr);
    const fallbackPath = path.join(instanceDirectory, 'fallback.json');
    const migrated: unknown = JSON.parse(readFileSync(fallbackPath, 'utf8'));
    const parsed = parseRoutingConfig(migrated, fallbackPath);
    assert.equal(parsed.defaultModel, 'canonical-model');
    assert.deepEqual(parsed.modelRoutes.get('canonical-model')?.channelIds, ['primary', 'fallback-a']);
    assert.equal(parsed.aliases['public_alias'], 'canonical-model');
    assert.equal(statSync(fallbackPath).mode & 0o777, 0o600);
    assert.equal(statSync(`${fallbackPath}.bak`).mode & 0o777, 0o600);
    assert.match(readFileSync(path.join(instanceDirectory, '.env'), 'utf8'), /# PRIMARY_PROVIDER_\* removed by migration tool/);
    assert.match(readFileSync(path.join(instanceDirectory, '.env'), 'utf8'), /# PRIMARY_PROVIDER_API_KEY=primary-secret-1234/);

    const missingKeyRun = runTool(missingKeyDirectory);
    assert.equal(missingKeyRun.status, 1);
    assert.match(missingKeyRun.stderr, /PRIMARY_PROVIDER_API_KEY/);
    assert.doesNotMatch(missingKeyRun.stderr, /primary-secret-1234/);

    console.log('Config migration checks passed.');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
