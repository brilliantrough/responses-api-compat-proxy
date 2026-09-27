import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import type { UsageQuery } from './usage-store.js';
import type { UsageAttempt } from './usage-tracking.js';
import type { UptimeQuery, UptimeSample } from './uptime.js';

const db = new DatabaseSync(workerData.path);
chmodSync(workerData.path, 0o600);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY, requestId TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER,
    channelId TEXT NOT NULL, channelName TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL,
    outcome TEXT NOT NULL, status INTEGER, reason TEXT,
    inputTokens INTEGER, outputTokens INTEGER, cachedInputTokens INTEGER, totalTokens INTEGER, reasoningTokens INTEGER
  );
  CREATE INDEX IF NOT EXISTS attempts_time ON attempts(startedAt);
  CREATE INDEX IF NOT EXISTS attempts_channel_model_time ON attempts(channelId, model, startedAt);
  CREATE INDEX IF NOT EXISTS attempts_model_time ON attempts(model, startedAt);
  CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS uptime (
    bucket INTEGER NOT NULL, sampledAt INTEGER NOT NULL, model TEXT NOT NULL, channelId TEXT NOT NULL, fingerprint TEXT NOT NULL,
    state TEXT NOT NULL, reason TEXT NOT NULL, successes INTEGER NOT NULL, failures INTEGER NOT NULL,
    failureThreshold INTEGER NOT NULL, rateThreshold REAL NOT NULL, windowMs INTEGER NOT NULL,
    PRIMARY KEY (model, channelId, fingerprint, bucket)
  );
  CREATE INDEX IF NOT EXISTS uptime_time ON uptime(bucket);
  UPDATE attempts SET outcome='interrupted', reason='process_restart' WHERE outcome='pending';
  PRAGMA user_version=1;
`);
const keys = ['id', 'requestId', 'startedAt', 'finishedAt', 'channelId', 'channelName', 'model', 'kind', 'outcome', 'status', 'reason', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens', 'reasoningTokens'] as const;
const insert = db.prepare(`INSERT INTO attempts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${keys.slice(3).map(key => `${key}=excluded.${key}`).join(',')}`);
const channel = db.prepare('INSERT INTO channels VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name');
const model = db.prepare('INSERT OR IGNORE INTO models VALUES (?)');
const uptimeKeys = ['bucket','sampledAt','model','channelId','fingerprint','state','reason','successes','failures','failureThreshold','rateThreshold','windowMs'] as const;
const insertUptime = db.prepare(`INSERT OR IGNORE INTO uptime (${uptimeKeys.join(',')}) VALUES (${uptimeKeys.map(() => '?').join(',')})`);
const pruneUptime = db.prepare('DELETE FROM uptime WHERE bucket < ?');
let lastUptimePrune = 0;

function queryUsage(query: UsageQuery) {
  const clauses = ['startedAt >= ?', 'startedAt < ?'];
  const params: (number | string)[] = [query.from, query.to];
  for (const [column, values] of [['channelId', query.channels], ['model', query.models]] as const) {
    if (values.length) { clauses.push(`${column} IN (${values.map(() => '?').join(',')})`); params.push(...values); }
  }
  if (query.kind !== 'all') { clauses.push('kind = ?'); params.push(query.kind); }
  const where = clauses.join(' AND ');
  const step = query.bucket === 'hour' ? 3600000 : 86400000;
  const shift = query.offset * 60000;
  const rows = db.prepare(`SELECT
    CAST((startedAt + ${shift}) / ${step} AS INTEGER) * ${step} - ${shift} AS bucket,
    channelId, model, kind, COUNT(*) AS attempts,
    SUM(outcome='success') AS success, SUM(outcome='failed') AS failed,
    SUM(outcome='cancelled') AS cancelled, SUM(outcome='interrupted') AS interrupted, SUM(outcome='pending') AS pending,
    SUM(inputTokens IS NOT NULL AND outputTokens IS NOT NULL) AS usageKnown,
    COUNT(inputTokens) AS inputKnown, COUNT(outputTokens) AS outputKnown,
    COUNT(cachedInputTokens) AS cachedKnown, COUNT(totalTokens) AS totalKnown, COUNT(reasoningTokens) AS reasoningKnown,
    SUM(inputTokens IS NOT NULL AND cachedInputTokens IS NOT NULL) AS cacheKnown,
    COALESCE(SUM(inputTokens),0) AS inputTokens, COALESCE(SUM(outputTokens),0) AS outputTokens,
    COALESCE(SUM(cachedInputTokens),0) AS cachedInputTokens, COALESCE(SUM(totalTokens),0) AS totalTokens,
    COALESCE(SUM(reasoningTokens),0) AS reasoningTokens,
    COALESCE(SUM(CASE WHEN cachedInputTokens IS NOT NULL THEN inputTokens ELSE 0 END),0) AS cacheEligibleInput,
    COALESCE(SUM(CASE WHEN inputTokens IS NOT NULL THEN cachedInputTokens ELSE 0 END),0) AS cacheEligibleCached,
    COALESCE(SUM(CASE WHEN cachedInputTokens IS NOT NULL THEN inputTokens-cachedInputTokens ELSE 0 END),0) AS uncachedInputTokens,
    COALESCE(SUM(CASE WHEN cachedInputTokens IS NULL THEN inputTokens ELSE 0 END),0) AS unknownCacheInputTokens,
    COALESCE(SUM(finishedAt-startedAt),0) AS durationMs, COUNT(finishedAt) AS finished
    FROM attempts WHERE ${where} GROUP BY bucket, channelId, model, kind ORDER BY bucket, channelId, model`).all(...params);
  return {
    ok: true, query, rows,
    requests: db.prepare(`SELECT COUNT(DISTINCT requestId) AS count FROM attempts WHERE ${where}`).get(...params)?.count,
    firstRecordedAt: db.prepare('SELECT MIN(startedAt) AS time FROM attempts').get()?.time ?? null,
    channels: db.prepare('SELECT id, name FROM channels ORDER BY name, id').all(),
    models: db.prepare('SELECT id FROM models ORDER BY id').all().map(row => row.id),
    generatedAt: Date.now(),
  };
}

parentPort!.on('message', (message: { type: string; id?: number; row: UsageAttempt; rows: UptimeSample[]; query: UsageQuery & UptimeQuery }) => {
  try {
    if (message.type === 'write') {
      const row = message.row;
      db.exec('BEGIN');
      try {
        insert.run(...keys.map(key => row[key]));
        channel.run(row.channelId, row.channelName); model.run(row.model);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } else if (message.type === 'write-uptime') {
      db.exec('BEGIN');
      try {
        for (const row of message.rows) insertUptime.run(...uptimeKeys.map(key => row[key]));
        if (Date.now() - lastUptimePrune > 86400000) { pruneUptime.run(Date.now() - 30 * 86400000); lastUptimePrune = Date.now(); }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } else if (message.type === 'query-uptime') {
      const q = message.query;
      parentPort!.postMessage({ id: message.id, data: { ok: true, rows: db.prepare('SELECT * FROM uptime WHERE model = ? AND bucket >= ? AND bucket < ? ORDER BY bucket').all(q.model, q.from, q.to) } });
    } else if (message.type === 'query') {
      parentPort!.postMessage({ id: message.id, data: queryUsage(message.query) });
    } else if (message.type === 'close') {
      db.close();
      parentPort!.postMessage({ id: message.id, data: { ok: true } });
    }
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
