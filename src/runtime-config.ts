import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as dotenvParse } from 'dotenv';
import type { HealthRegistry, HealthTopology } from './channel-health.js';
import { createProxyRuntimeConfig, type ProxyRuntimeConfig } from './proxy-config.js';
import { configureCacheKeyHistory } from './cache-key-history.js';
import {
  compactHealthKey,
  compactV2HealthKey,
  type RoutingConfig,
} from './routing-config.js';

export type RuntimeSnapshot = {
  runtimeVersion: number;
  config: ProxyRuntimeConfig;
  routingConfig: RoutingConfig;
  envPath: string;
  restartRequiredFields: string[];
};

export type RuntimeConfigStore = {
  getSnapshot(): RuntimeSnapshot;
  reloadFromFiles(): { ok: true } | { ok: false; error: string };
  registerHealthRegistry?(registry: HealthRegistry): void;
};

type RuntimeConfigStoreOptions = Readonly<{
  envPath: string;
  routingConfigPath?: string;
}>;

type BuildSnapshotInput = Readonly<{
  envPath: string;
  routingConfigPath: string | undefined;
  version: number;
  previous: RuntimeSnapshot | null;
}>;

export function createEndpointStateKey(endpoint: { name: string; url: string }): string {
  return `${endpoint.name}::${endpoint.url}`;
}

export function buildHealthTopology(config: RoutingConfig): HealthTopology {
  const modelChannels: Array<Readonly<{ channelId: string; canonicalModel: string }>> = [];
  for (const route of config.modelRoutes.values()) {
    for (const channelId of route.channelIds) {
      modelChannels.push({ channelId, canonicalModel: route.canonicalModel });
    }
  }
  if (config.compactRoute !== undefined) {
    const compactKey = compactHealthKey(config.compactRoute.canonicalModel);
    for (const channelId of config.compactRoute.channelIds) {
      modelChannels.push({ channelId, canonicalModel: compactKey });
    }
    for (const model of config.modelRoutes.keys()) {
      for (const channelId of config.compactRoute.v2ChannelIds) {
        modelChannels.push({ channelId, canonicalModel: compactV2HealthKey(model) });
      }
    }
  }

  return {
    channels: Array.from(config.channelsById.values()).map(channel => ({
      channelId: channel.id,
      fingerprint: channel.fingerprint,
      disableCooldown: channel.disableCooldown,
    })),
    modelChannels,
  };
}

export function createRuntimeConfigStore(options: RuntimeConfigStoreOptions): RuntimeConfigStore {
  const { envPath, routingConfigPath } = options;
  let current = buildSnapshot({ envPath, routingConfigPath, version: 1, previous: null });
  let healthRegistry: HealthRegistry | undefined;

  function reconcileHealth(snapshot: RuntimeSnapshot): void {
    configureCacheKeyHistory(snapshot.config.cacheKeyPoolSize, snapshot.config.routingConfig);
    if (healthRegistry === undefined) {
      return;
    }

    healthRegistry.configure(snapshot.config);
    healthRegistry.reconcile(buildHealthTopology(snapshot.routingConfig));
  }

  return {
    getSnapshot(): RuntimeSnapshot {
      return current;
    },
    reloadFromFiles(): { ok: true } | { ok: false; error: string } {
      try {
        const nextVersion = current.runtimeVersion + 1;
        const next = buildSnapshot({ envPath, routingConfigPath, version: nextVersion, previous: current });
        current = next;
        reconcileHealth(next);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    registerHealthRegistry(registry: HealthRegistry): void {
      healthRegistry = registry;
      reconcileHealth(current);
    },
  };
}

function buildSnapshot(input: BuildSnapshotInput): RuntimeSnapshot {
  const parsed = loadAndMergeEnv(input.envPath);
  parsed.FALLBACK_CONFIG_PATH ??= input.routingConfigPath;
  const config = createProxyRuntimeConfig(parsed);

  const restartRequiredFields: string[] = [];
  if (input.previous) {
    if (config.port !== input.previous.config.port) {
      restartRequiredFields.push('PORT');
    }
    if (config.host !== input.previous.config.host) {
      restartRequiredFields.push('HOST');
    }
  }

  return {
    runtimeVersion: input.version,
    config,
    routingConfig: config.routingConfig,
    envPath: resolve(input.envPath),
    restartRequiredFields,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function loadAndMergeEnv(envPath: string): NodeJS.ProcessEnv {
  let fileEnv: Record<string, string> = {};
  try {
    const raw = readFileSync(envPath, 'utf8');
    fileEnv = dotenvParse(raw);
  } catch (err) {
    if (!hasErrorCode(err, 'ENOENT')) {
      throw err;
    }
  }

  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(fileEnv)) {
    merged[k] = v;
  }
  return merged;
}
