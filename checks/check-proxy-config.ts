import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProxyRuntimeConfig } from '../src/proxy-config.js';

const MODEL = 'fallback-model';

function writeRoutingConfig(filePath: string) {
  writeFileSync(filePath, JSON.stringify({
    default_model: MODEL,
    channels: [
      { id: 'primary', name: 'Primary', base_url: 'https://primary.example', api_key: 'primary-key' },
      { id: 'fallback-a', base_url: 'https://stable.example', api_key: 'stable-key' },
    ],
    models: {
      [MODEL]: { channel_ids: ['primary', 'fallback-a'] },
    },
    aliases: {
      'fallback-alias': MODEL,
    },
  }), 'utf8');
}

function main() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'responses-proxy-config-'));
  const routingConfigPath = path.join(tempDir, 'fallback.json');
  writeRoutingConfig(routingConfigPath);

  try {
    const config = createProxyRuntimeConfig({
      FALLBACK_CONFIG_PATH: routingConfigPath,
    });

    assert.equal(config.routingConfigPath, routingConfigPath);
    assert.equal(config.routingConfig.defaultModel, MODEL);
    assert.equal(config.routingConfig.channelsById.size, 2);
    assert.equal(config.routingConfig.channelsById.get('fallback-a')?.responsesUrl, 'https://stable.example/v1/responses');
    assert.deepEqual(config.routingConfig.modelRoutes.get(MODEL)?.channelIds, ['primary', 'fallback-a']);
    assert.equal(config.routingConfig.aliases['fallback-alias'], MODEL);
    assert.equal(config.healthCooldownMs, 600000);
    assert.equal(config.healthWindowMs, 180000);
    assert.equal(config.healthFailureThreshold, 15);
    assert.equal(config.healthFailureRateThreshold, 0.5);
    assert.equal(config.channelMaxAttempts, 3);
    assert.equal(config.cacheKeyPoolSize, 100);
    assert.equal(config.maxFallbackTotalMs, 30000);
    assert.equal(config.compactTimeoutMs, 300000);
    assert.equal(config.compactDetectTimeoutMs, 45000);
    assert.equal(config.compactDetectEnabled, true);
    assert.equal(config.claudeBillingHeaderMode, 'strip_line', 'Claude billing header default mode');

    const extraEnvConfig = createProxyRuntimeConfig({
      FALLBACK_CONFIG_PATH: routingConfigPath,
      PRIMARY_PROVIDER_NAME: 'ignored-primary',
      PRIMARY_PROVIDER_BASE_URL: 'https://ignored.example',
      PRIMARY_PROVIDER_API_KEY: 'ignored-key',
      PRIMARY_PROVIDER_DEFAULT_MODEL: 'ignored-model',
      UNRELATED_API_KEY: 'unused-key',
      UNRELATED_MODEL: 'unused-model',
      PROXY_CHANNEL_COOLDOWN_MS: '111',
      PROXY_MODEL_CHANNEL_COOLDOWN_MS: '222',
      PROXY_CHANNEL_FAILURE_THRESHOLD: '3',
      PROXY_MODEL_CHANNEL_FAILURE_THRESHOLD: '4',
      PROXY_HALF_OPEN_MAX_PROBES: '5',
      PROXY_COMPACT_TIMEOUT_MS: '60000',
      PROXY_COMPACT_DETECT_TIMEOUT_MS: '9000',
      PROXY_COMPACT_DETECT_ENABLED: '0',
    });

    assert.equal(extraEnvConfig.routingConfig.defaultModel, MODEL);
    assert.equal(extraEnvConfig.healthCooldownMs, 600000, 'legacy cooldown knobs are ignored');
    assert.equal(extraEnvConfig.healthFailureThreshold, 15, 'legacy one-failure settings cannot override new policy');
    const tuned = createProxyRuntimeConfig({ FALLBACK_CONFIG_PATH: routingConfigPath, PROXY_HEALTH_FAILURE_THRESHOLD: '20', PROXY_CHANNEL_MAX_ATTEMPTS: '4' });
    assert.equal(tuned.healthFailureThreshold, 20);
    assert.equal(tuned.channelMaxAttempts, 4);
    for (const bad of ['NaN', '-1', '1.5', '']) assert.throws(() => createProxyRuntimeConfig({ FALLBACK_CONFIG_PATH: routingConfigPath, PROXY_HEALTH_FAILURE_THRESHOLD: bad }));
    assert.equal(extraEnvConfig.compactTimeoutMs, 60000);
    assert.equal(extraEnvConfig.compactDetectTimeoutMs, 9000);
    assert.equal(extraEnvConfig.compactDetectEnabled, false);

    const stripCchConfig = createProxyRuntimeConfig({
      FALLBACK_CONFIG_PATH: routingConfigPath,
      PROXY_CLAUDE_BILLING_HEADER_MODE: 'strip-cch',
    });
    assert.equal(stripCchConfig.claudeBillingHeaderMode, 'strip_cch');

    console.log('Proxy config checks passed.');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
