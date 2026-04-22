import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as dotenvParse } from 'dotenv';
import { createProxyRuntimeConfig, type ProxyRuntimeConfig } from './proxy-config.js';

export type RuntimeSnapshot = {
  runtimeVersion: number;
  config: ProxyRuntimeConfig;
  envPath: string;
  restartRequiredFields: string[];
};

export type RuntimeConfigStore = {
  getSnapshot(): RuntimeSnapshot;
  reloadFromFiles(): { ok: true } | { ok: false; error: string };
};

export function createEndpointStateKey(endpoint: { name: string; url: string }): string {
  return `${endpoint.name}::${endpoint.url}`;
}

export function createRuntimeConfigStore(options: { envPath: string }): RuntimeConfigStore {
  const { envPath } = options;
  let current = buildSnapshot(envPath, 1, null);

  function buildSnapshot(
    envFilePath: string,
    version: number,
    previous: RuntimeSnapshot | null,
  ): RuntimeSnapshot {
    const parsed = loadAndMergeEnv(envFilePath);
    const config = createProxyRuntimeConfig(parsed);

    const restartRequiredFields: string[] = [];
    if (previous) {
      if (config.port !== previous.config.port) {
        restartRequiredFields.push('PORT');
      }
      if (config.host !== previous.config.host) {
        restartRequiredFields.push('HOST');
      }
    }

    return {
      runtimeVersion: version,
      config,
      envPath: resolve(envFilePath),
      restartRequiredFields,
    };
  }

  return {
    getSnapshot(): RuntimeSnapshot {
      return current;
    },
    reloadFromFiles(): { ok: true } | { ok: false; error: string } {
      try {
        const nextVersion = current.runtimeVersion + 1;
        const next = buildSnapshot(envPath, nextVersion, current);
        current = next;
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

function loadAndMergeEnv(envPath: string): NodeJS.ProcessEnv {
  let fileEnv: Record<string, string> = {};
  try {
    const raw = readFileSync(envPath, 'utf8');
    fileEnv = dotenvParse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw err;
    }
  }

  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(fileEnv)) {
    merged[k] = v;
  }
  return merged;
}
