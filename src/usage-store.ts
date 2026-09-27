import { Worker } from 'node:worker_threads';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { UsageAttempt } from './usage-tracking.js';
import type { UptimeQuery, UptimeSample } from './uptime.js';

export type UsageQuery = { from: number; to: number; bucket: 'hour' | 'day'; offset: number; channels: string[]; models: string[]; kind: string };

export function parseUsageQuery(params: URLSearchParams): UsageQuery {
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  const bucket = params.get('bucket') ?? 'day';
  const offset = Number(params.get('offset') ?? 0);
  const kind = params.get('kind') ?? 'all';
  const channels = params.getAll('channel');
  const models = params.getAll('model');
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to <= from || to > 8.64e15 ||
      !['hour', 'day'].includes(bucket) || to - from > (bucket === 'hour' ? 31 : 366) * 86400000 ||
      !Number.isInteger(offset) || Math.abs(offset) > 840 || !['all', 'responses', 'compact', 'compact-v2'].includes(kind) ||
      channels.length > 100 || models.length > 100 || [...channels, ...models].some(value => !value || value.length > 256)) {
    throw new Error('Invalid filters: use an increasing time range (hour ≤31 days, day ≤366 days), UTC offset in minutes, and up to 100 channels/models.');
  }
  return { from, to, bucket: bucket as 'hour' | 'day', offset, channels, models, kind };
}

export function createUsageStore(path: string) {
  path = resolve(path);
  mkdirSync(dirname(path), { recursive: true });
  const source = import.meta.url.endsWith('.ts');
  const entry = new URL(source ? './usage-db.ts' : './usage-db.js', import.meta.url);
  const worker = source
    ? new Worker(`import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)}))`, { eval: true, workerData: { path } })
    : new Worker(entry, { workerData: { path } });
  let error: string | null = null;
  let dead = false;
  let closing = false;
  let sequence = 0;
  const pending = new Map<number, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  function fail(message: string) {
    error = message;
    console.error(`Usage database: ${message}`);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
    pending.clear();
  }
  worker.on('error', err => { dead = true; fail(err.message); });
  worker.on('exit', code => { dead = true; if (!closing) fail(`worker exited (${code})`); });
  worker.on('message', message => {
    if (message.error && !message.id) { fail(message.error); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve({ ...message.data, database: path, writeError: error });
  });
  function request(type: string, query?: UsageQuery | UptimeQuery): Promise<unknown> {
      if (dead) return Promise.reject(new Error(error ?? 'Usage database is unavailable'));
      if (pending.size >= 8) return Promise.reject(new Error('Usage queries are busy; retry shortly'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Usage query timed out')); }, 30000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ type, id, query });
      });
  }
  return {
    path,
    write(row: UsageAttempt) { if (!dead && !closing) worker.postMessage({ type: 'write', row }); },
    query(query: UsageQuery) { return request('query', query); },
    writeUptime(rows: UptimeSample[]) { if (!dead && !closing) worker.postMessage({ type: 'write-uptime', rows }); },
    queryUptime(query: UptimeQuery) { return request('query-uptime', query); },
    async close() {
      closing = true;
      try { await request('close'); } finally { await worker.terminate(); }
    },
  };
}
