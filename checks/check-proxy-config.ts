import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProxyRuntimeConfig } from '../src/proxy-config.js';

function main() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'responses-proxy-config-'));
  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  const modelMapPath = path.join(tempDir, 'model-map.json');
  writeFileSync(fallbackConfigPath, JSON.stringify({ fallback_api_config: [] }), 'utf8');
  writeFileSync(modelMapPath, JSON.stringify({ model_mappings: {} }), 'utf8');

  try {
    const config = createProxyRuntimeConfig({
      PRIMARY_PROVIDER_API_KEY: 'primary-key',
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
      MODEL_MAP_PATH: modelMapPath,
    });

    assert.equal(config.primaryProviderName, 'primary-provider');
    assert.equal(config.primaryProviderBaseUrl, 'https://primary.example');
    assert.equal(config.defaultModel, 'my-model-v2');
    assert.equal(config.upstreamUrl, 'https://primary.example/v1/responses');
    assert.equal(config.upstreamModelsUrl, 'https://primary.example/v1/models');

    const extraEnvConfig = createProxyRuntimeConfig({
      PRIMARY_PROVIDER_API_KEY: 'primary-key',
      UNRELATED_API_KEY: 'unused-key',
      UNRELATED_MODEL: 'unused-model',
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
      MODEL_MAP_PATH: modelMapPath,
    });

    assert.equal(extraEnvConfig.apiKey, 'primary-key');
    assert.equal(extraEnvConfig.defaultModel, 'my-model-v2');

    console.log('Proxy config checks passed.');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
