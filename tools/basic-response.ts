import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';

import { createOpenResponses } from '@ai-sdk/open-responses';
import { streamText } from 'ai';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCliPath = require.resolve('tsx/cli');
const defaultModel = process.env.BASIC_RESPONSE_MODEL ?? 'demo-model';
const model = process.argv[2] ?? defaultModel;
const prompt = process.argv.slice(3).join(' ') || 'Please reply with a short greeting.';

function createSsePayload(modelName: string): string {
  const text = 'Hello from the routing-configured proxy.';
  const message = {
    id: 'msg_basic_tool',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response = {
    id: 'resp_basic_tool',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: modelName,
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
    output: [message],
  };
  const completed = {
    type: 'response.completed',
    sequence_number: 6,
    response,
  };

  return [
    'event: response.created',
    `data: ${JSON.stringify({ type: 'response.created', sequence_number: 1, response })}`,
    '',
    'event: response.output_item.added',
    `data: ${JSON.stringify({ type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { ...message, status: 'in_progress', content: [] } })}`,
    '',
    'event: response.output_text.delta',
    `data: ${JSON.stringify({ type: 'response.output_text.delta', sequence_number: 3, item_id: message.id, output_index: 0, content_index: 0, delta: text })}`,
    '',
    'event: response.output_text.done',
    `data: ${JSON.stringify({ type: 'response.output_text.done', sequence_number: 4, item_id: message.id, output_index: 0, content_index: 0, text })}`,
    '',
    'event: response.output_item.done',
    `data: ${JSON.stringify({ type: 'response.output_item.done', sequence_number: 5, output_index: 0, item: message })}`,
    '',
    'event: response.completed',
    `data: ${JSON.stringify(completed)}`,
    '',
    '',
  ].join('\n');
}

async function waitForHealthy(url: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for proxy health at ${url}`);
}

function createProxyEnv(proxyPort: number, fallbackConfigPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(proxyPort),
    INSTANCE_NAME: 'responses-proxy-basic-tool',
    FALLBACK_CONFIG_PATH: fallbackConfigPath,
  };
  const oldPrimaryPrefix = ['PRIMARY', 'PROVIDER'].join('_');
  for (const suffix of ['NAME', 'BASE_URL', 'API_KEY', 'DEFAULT_MODEL']) {
    delete env[`${oldPrimaryPrefix}_${suffix}`];
  }
  delete env[['MODEL', 'MAP', 'PATH'].join('_')];
  return env;
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-basic-tool-'));
  const upstream = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(createSsePayload(model));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  if (upstreamAddress === null || typeof upstreamAddress === 'string') {
    throw new Error('Failed to resolve mock upstream address');
  }

  const proxyPort = upstreamAddress.port + 1;
  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  await writeFile(fallbackConfigPath, JSON.stringify({
    default_model: model,
    channels: [{ id: 'primary', name: 'Local Mock Provider', base_url: `http://127.0.0.1:${upstreamAddress.port}`, api_key: 'mock-upstream-key' }],
    models: { [model]: { channel_ids: ['primary'] } },
    aliases: {},
  }, null, 2), { encoding: 'utf8', mode: 0o600 });

  const proxy = spawn(process.execPath, [tsxCliPath, 'src/json-proxy.ts'], {
    cwd: workspaceRoot,
    env: createProxyEnv(proxyPort, fallbackConfigPath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr: string[] = [];
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);
    const proxyResponsesUrl = `http://127.0.0.1:${proxyPort}/v1/responses`;
    const provider = createOpenResponses({ name: 'local-proxy', url: proxyResponsesUrl, apiKey: 'proxy-client-key' });

    console.log('Sending request through temporary routing-configured proxy...');
    console.log(`- endpoint: ${proxyResponsesUrl}`);
    console.log(`- model: ${model}`);
    console.log(`- prompt: ${prompt}`);

    const streamEventTypes: string[] = [];
    let finishPayload: unknown;
    const result = streamText({
      model: provider(model),
      prompt,
      onFinish(event) {
        finishPayload = { finishReason: event.finishReason, usage: event.usage, totalUsage: event.totalUsage };
      },
    });

    console.log('\nStreaming text:\n');
    for await (const part of result.fullStream) {
      streamEventTypes.push(part.type);
      if (part.type === 'text-delta') {
        process.stdout.write(part.text);
      }
    }

    console.log('\n\nDebug info:\n');
    console.log(JSON.stringify({ eventTypes: streamEventTypes, finishReason: await result.finishReason, usage: await result.usage, text: await result.text, finishPayload }, null, 2));
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([once(proxy, 'exit'), delay(3000).then(() => proxy.kill('SIGKILL'))]);
    upstream.close();
    await once(upstream, 'close');
    await rm(tempDir, { recursive: true, force: true });
  }

  const stderrText = stderr.join('').trim();
  if (stderrText.length > 0) {
    console.error(stderrText);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
