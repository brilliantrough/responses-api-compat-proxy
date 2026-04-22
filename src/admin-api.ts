import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createConfigFileStoreFromPaths,
  readForAdmin,
  applyAdminDraft,
  validateDraft,
  type AdminConfigDraft,
  type ConfigFileStore,
} from './config-files.js';
import type { RuntimeConfigStore } from './runtime-config.js';

export function isLocalhost(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown) {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) {
    try { res.end(); } catch { /* best-effort */ }
    return;
  }
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body, null, 2));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function getRemoteAddress(req: IncomingMessage): string | undefined {
  return req.socket.remoteAddress;
}

export type AdminHandlerOptions = {
  configStore: ConfigFileStore;
  runtimeStore: RuntimeConfigStore;
  getAdminStats?: () => unknown;
  clearResponseCache?: () => number;
  responseCacheSize?: () => number;
};

function rollbackBakFiles(store: ConfigFileStore): string[] {
  const files = [store.envPath, store.fallbackPath, store.modelMapPath];
  const restored: string[] = [];
  for (const filePath of files) {
    const bakPath = filePath + '.bak';
    if (existsSync(bakPath)) {
      renameSync(bakPath, filePath);
      restored.push(resolve(filePath));
    }
  }
  return restored;
}

function serveAdminStatic(res: ServerResponse, filename: string, contentType: string, subDir?: string) {
  const base = resolve(import.meta.dirname, '..', 'public', 'admin');
  const filePath = subDir ? resolve(base, subDir, filename) : resolve(base, filename);
  const safeBase = base;
  if (!filePath.startsWith(safeBase)) {
    sendJson(res, 403, { error: { message: 'Forbidden', type: 'forbidden' } });
    return;
  }
  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    return;
  }
  try {
    const data = readFileSync(filePath, 'utf8');
    res.writeHead(200, { 'content-type': contentType });
    res.end(data);
  } catch {
    sendJson(res, 500, { error: { message: 'Failed to read static file', type: 'server_error' } });
  }
}

function currentConfigStore(baseStore: ConfigFileStore, runtimeStore: RuntimeConfigStore): ConfigFileStore {
  const snapshot = runtimeStore.getSnapshot();
  return createConfigFileStoreFromPaths({
    envPath: baseStore.envPath,
    fallbackPath: snapshot.config.fallbackConfigPath,
    modelMapPath: snapshot.config.modelMappingPath,
  });
}

export function createAdminHandler(options: AdminHandlerOptions) {
  const { configStore, runtimeStore } = options;

  return async function handleAdminRoute(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const rawUrl = req.url ?? '';
    const method = req.method ?? '';
    const url = rawUrl.split(/[?#]/)[0];

    if (url !== '/admin' && !url.startsWith('/admin/')) return false;

    if (!isLocalhost(getRemoteAddress(req))) {
      sendJson(res, 403, { error: { message: 'Admin endpoints are only accessible from localhost', type: 'forbidden' } });
      return true;
    }

    const store = currentConfigStore(configStore, runtimeStore);

    if (method === 'GET' && url === '/admin/config') {
      try {
        const config = readForAdmin(store);
        const snapshot = runtimeStore.getSnapshot();
        sendJson(res, 200, {
          ok: true,
          config,
          runtimeVersion: snapshot.runtimeVersion,
          restartRequiredFields: snapshot.restartRequiredFields,
        });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err), type: 'server_error' },
        });
      }
      return true;
    }

    if (method === 'POST' && url === '/admin/config/validate') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { ok: false, error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
        return true;
      }
      const validation = validateDraft(body);
      if (!validation.ok) {
        sendJson(res, 200, { ok: true, valid: false, errors: validation.errors });
      } else {
        const config = readForAdmin(store);
        sendJson(res, 200, { ok: true, valid: true, warnings: validation.warnings, config });
      }
      return true;
    }

    if (method === 'PUT' && url === '/admin/config') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { ok: false, error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
        return true;
      }
      const validation = validateDraft(body);
      if (!validation.ok) {
        sendJson(res, 400, {
          ok: false,
          error: { message: 'Validation failed', type: 'invalid_request_error' },
          errors: validation.errors,
        });
        return true;
      }
      try {
        const draft = body as AdminConfigDraft;
        applyAdminDraft(store, draft);
        const reloadResult = runtimeStore.reloadFromFiles();
        if (!reloadResult.ok) {
          sendJson(res, 500, {
            ok: false,
            error: { message: `Config saved but reload failed: ${reloadResult.error}`, type: 'server_error' },
          });
          return true;
        }
        const snapshot = runtimeStore.getSnapshot();
        sendJson(res, 200, {
          ok: true,
          runtimeVersion: snapshot.runtimeVersion,
          restartRequiredFields: snapshot.restartRequiredFields,
        });
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err), type: 'invalid_request_error' },
        });
      }
      return true;
    }

    if (method === 'POST' && url === '/admin/config/reload') {
      try {
        const reloadResult = runtimeStore.reloadFromFiles();
        if (!reloadResult.ok) {
          sendJson(res, 500, {
            ok: false,
            error: { message: reloadResult.error, type: 'server_error' },
          });
          return true;
        }
        const snapshot = runtimeStore.getSnapshot();
        sendJson(res, 200, {
          ok: true,
          runtimeVersion: snapshot.runtimeVersion,
          restartRequiredFields: snapshot.restartRequiredFields,
        });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err), type: 'server_error' },
        });
      }
      return true;
    }

    if (method === 'POST' && url === '/admin/config/rollback') {
      try {
        const restored = rollbackBakFiles(store);
        if (restored.length === 0) {
          sendJson(res, 200, { ok: true, restored: [], message: 'No backup files found' });
          return true;
        }
        const reloadResult = runtimeStore.reloadFromFiles();
        if (!reloadResult.ok) {
          sendJson(res, 500, {
            ok: false,
            error: { message: `Rollback restored files but reload failed: ${reloadResult.error}`, type: 'server_error' },
            restored,
          });
          return true;
        }
        const snapshot = runtimeStore.getSnapshot();
        sendJson(res, 200, {
          ok: true,
          restored,
          runtimeVersion: snapshot.runtimeVersion,
          restartRequiredFields: snapshot.restartRequiredFields,
        });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err), type: 'server_error' },
        });
      }
      return true;
    }

    if (method === 'GET' && url === '/admin/stats') {
      if (options.getAdminStats) {
        sendJson(res, 200, options.getAdminStats());
      } else {
        sendJson(res, 200, { ok: true });
      }
      return true;
    }

    if (method === 'POST' && url === '/admin/cache/clear') {
      if (options.clearResponseCache) {
        const clearedResponses = options.clearResponseCache();
        sendJson(res, 200, {
          ok: true,
          clearedResponses,
          cachedResponses: options.responseCacheSize ? options.responseCacheSize() : 0,
        });
      } else {
        sendJson(res, 200, { ok: true });
      }
      return true;
    }

    if (method === 'GET' && url === '/admin/monitor/stats') {
      sendJson(res, 200, {
        ok: true,
        ...(options.getAdminStats ? (options.getAdminStats() as Record<string, unknown>) : {}),
      });
      return true;
    }

    if (method === 'GET' && (url === '/admin' || url === '/admin/')) {
      serveAdminStatic(res, 'admin.html', 'text/html; charset=utf-8');
      return true;
    }

    if (method === 'GET' && (url === '/admin/monitor' || url === '/admin/monitor/')) {
      serveAdminStatic(res, 'monitor.html', 'text/html; charset=utf-8');
      return true;
    }

    if (method === 'GET' && url.startsWith('/admin/assets/')) {
      const assetName = url.slice('/admin/assets/'.length);
      if (!assetName || assetName.includes('..') || assetName.includes('/') || assetName.includes('\\')) {
        sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } });
        return true;
      }
      if (assetName === 'admin.js') {
        serveAdminStatic(res, 'admin.js', 'application/javascript; charset=utf-8', 'assets');
        return true;
      }
      if (assetName === 'admin.css') {
        serveAdminStatic(res, 'admin.css', 'text/css; charset=utf-8', 'assets');
        return true;
      }
      if (assetName === 'monitor.js') {
        serveAdminStatic(res, 'monitor.js', 'application/javascript; charset=utf-8', 'assets');
        return true;
      }
      if (assetName === 'monitor.css') {
        serveAdminStatic(res, 'monitor.css', 'text/css; charset=utf-8', 'assets');
        return true;
      }
      sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } });
      return true;
    }

    return false;
  };
}
