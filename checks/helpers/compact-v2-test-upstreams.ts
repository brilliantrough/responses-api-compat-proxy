import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { isJsonRecord, type JsonRecord } from '../../src/responses-input-normalization.js';

export type V2UpstreamMode = 'true' | 'bridge' | 'reject' | 'hang' | 'client';

export type V2UpstreamObservation = Readonly<{
  mode: V2UpstreamMode;
  trigger: boolean;
  betaHeader: string | null;
  body: JsonRecord;
}>;

export type V2TestUpstreams = Readonly<{
  ports: ReadonlyMap<V2UpstreamMode, number>;
  observations: V2UpstreamObservation[];
  close(): Promise<void>;
}>;

async function readBody(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isJsonRecord(parsed)) {
    throw new Error('expected request body object');
  }
  return parsed;
}

function hasCompactionTrigger(body: JsonRecord): boolean {
  return Array.isArray(body.input) && body.input.some(
    item => isJsonRecord(item) && item.type === 'compaction_trigger',
  );
}

function readBetaHeader(req: IncomingMessage): string | null {
  const value = req.headers['x-codex-beta-features'];
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value ?? null;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function normalStream(model: string): string {
  return [
    'event: response.output_text.delta',
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'normal text' })}`,
    '',
    'event: response.completed',
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_normal',
        object: 'response',
        status: 'completed',
        model,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'normal text' }] }],
      },
    })}`,
    '',
  ].join('\n');
}

function compactionStream(model: string): string {
  const item = { id: 'cmp_v2', type: 'compaction', encrypted_content: 'encrypted-v2-content' };
  return [
    'event: response.output_item.added',
    `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}`,
    '',
    'event: response.output_item.done',
    `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}`,
    '',
    'event: response.completed',
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_compaction_v2',
        object: 'response.compaction',
        status: 'completed',
        model,
        usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
        output: [item],
      },
    })}`,
    '',
  ].join('\n');
}

function createUpstream(
  mode: V2UpstreamMode,
  observations: V2UpstreamObservation[],
  hangingSockets: Set<Socket>,
): Server {
  return createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      writeJson(res, 404, { error: { message: 'not found' } });
      return;
    }

    const body = await readBody(req);
    const trigger = hasCompactionTrigger(body);
    observations.push({ mode, trigger, betaHeader: readBetaHeader(req), body });

    if (mode === 'hang') {
      hangingSockets.add(req.socket);
      req.socket.once('close', () => hangingSockets.delete(req.socket));
      return;
    }
    if (mode === 'reject' && trigger) {
      writeJson(res, 404, { error: { message: 'remote compaction v2 route missing' } });
      return;
    }
    if (mode === 'client' && trigger) {
      writeJson(res, 400, { error: { message: 'maximum context length exceeded' } });
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    if (mode === 'true' && trigger) {
      res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_compaction_v2","status":"in_progress"}}\n\n');
      await delay(120);
      res.end(compactionStream(typeof body.model === 'string' ? body.model : 'unknown-model'));
      return;
    }
    if (mode === 'bridge') {
      res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_bridge","status":"in_progress"}}\n\n');
      await delay(120);
    }
    res.end(normalStream(typeof body.model === 'string' ? body.model : 'unknown-model'));
  });
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('upstream server did not expose a port');
  }
  return address.port;
}

export async function startV2TestUpstreams(): Promise<V2TestUpstreams> {
  const observations: V2UpstreamObservation[] = [];
  const hangingSockets = new Set<Socket>();
  const servers = new Map<V2UpstreamMode, Server>();
  const ports = new Map<V2UpstreamMode, number>();
  const modes = ['true', 'bridge', 'reject', 'hang', 'client'] as const;
  for (const mode of modes) {
    const server = createUpstream(mode, observations, hangingSockets);
    servers.set(mode, server);
    ports.set(mode, await listen(server));
  }

  return {
    ports,
    observations,
    close: async () => {
      for (const socket of hangingSockets) {
        socket.destroy();
      }
      await Promise.all(Array.from(servers.values()).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      })));
    },
  };
}
