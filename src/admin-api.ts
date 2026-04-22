import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, renameSync } from 'node:fs';
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

export function createAdminHandler(options: AdminHandlerOptions) {
  const { configStore, runtimeStore } = options;

  return async function handleAdminRoute(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = req.url ?? '';
    const method = req.method ?? '';

    if (!url.startsWith('/admin/')) return false;

    if (!isLocalhost(getRemoteAddress(req))) {
      sendJson(res, 403, { error: { message: 'Admin endpoints are only accessible from localhost', type: 'forbidden' } });
      return true;
    }

    if (method === 'GET' && url === '/admin/config') {
      try {
        const config = readForAdmin(configStore);
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
        const config = readForAdmin(configStore);
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
      try {
        const draft = body as AdminConfigDraft;
        applyAdminDraft(configStore, draft);
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
        const restored = rollbackBakFiles(configStore);
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

    return false;
  };
}
