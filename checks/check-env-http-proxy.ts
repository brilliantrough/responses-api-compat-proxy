import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-env-http-proxy-'));
  const envPath = path.join(tempDir, '.env');
  const fallbackPath = path.join(tempDir, 'fallback.json');
  const modelMapPath = path.join(tempDir, 'model-map.json');

  let proxied = false;
  const proxy = createHttpServer((req, res) => {
    proxied = true;
    const absolute = new URL(req.url || 'http://invalid');
    const upstreamSocket = net.connect(Number(absolute.port || 80), absolute.hostname, () => {
      upstreamSocket.write(`${req.method} ${absolute.pathname}${absolute.search} HTTP/1.1\r\nHost: ${absolute.host}\r\nConnection: close\r\n\r\n`);
    });
    let buffer = '';
    upstreamSocket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
    });
    upstreamSocket.on('end', () => {
      const splitIndex = buffer.indexOf('\r\n\r\n');
      const body = splitIndex >= 0 ? buffer.slice(splitIndex + 4) : buffer;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
    });
    upstreamSocket.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(error.message || error));
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === 'string') {
    throw new Error('Failed to resolve fake proxy address');
  }

  const target = createHttpServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(Buffer.byteLength('TARGET_OK')),
    });
    res.end('TARGET_OK');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const targetAddress = target.address();
  if (!targetAddress || typeof targetAddress === 'string') {
    throw new Error('Failed to resolve target address');
  }

  await writeFile(
    envPath,
    [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://example.invalid',
      'PRIMARY_PROVIDER_API_KEY=test-key',
      `FALLBACK_CONFIG_PATH=${fallbackPath}`,
      `MODEL_MAP_PATH=${modelMapPath}`,
      `HTTP_PROXY=http://127.0.0.1:${proxyAddress.port}`,
      `HTTPS_PROXY=http://127.0.0.1:${proxyAddress.port}`,
      'NO_PROXY=',
    ].join('\n') + '\n',
    'utf8',
  );
  await writeFile(fallbackPath, JSON.stringify({ fallback_api_config: [] }, null, 2) + '\n', 'utf8');
  await writeFile(modelMapPath, JSON.stringify({ model_mappings: {} }, null, 2) + '\n', 'utf8');

  const originalEnvPath = process.env.PROXY_ENV_PATH;
  const originalHttpProxy = process.env.HTTP_PROXY;
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  const originalNoProxy = process.env.NO_PROXY;
  const originalAllProxy = process.env.ALL_PROXY;
  const originalHttpProxyLower = process.env.http_proxy;
  const originalHttpsProxyLower = process.env.https_proxy;
  const originalNoProxyLower = process.env.no_proxy;
  const originalAllProxyLower = process.env.all_proxy;
  process.env.PROXY_ENV_PATH = envPath;
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.NO_PROXY;
  delete process.env.ALL_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.no_proxy;
  delete process.env.all_proxy;

  try {
    const mod = await import('../src/http-proxy-bootstrap.js');
    mod.bootstrapHttpProxySupport();
    const res = await fetch(`http://127.0.0.1:${targetAddress.port}/through-proxy`);
    const body = await res.text();

    assert.equal(proxied, true, 'bootstrap should route fetch through HTTP proxy from PROXY_ENV_PATH env file');
    assert.match(body, /TARGET_OK/, 'response body should still come from target through proxy');
  } finally {
    if (originalEnvPath === undefined) {
      delete process.env.PROXY_ENV_PATH;
    } else {
      process.env.PROXY_ENV_PATH = originalEnvPath;
    }
    if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = originalHttpProxy;
    if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = originalHttpsProxy;
    if (originalNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = originalNoProxy;
    if (originalAllProxy === undefined) delete process.env.ALL_PROXY; else process.env.ALL_PROXY = originalAllProxy;
    if (originalHttpProxyLower === undefined) delete process.env.http_proxy; else process.env.http_proxy = originalHttpProxyLower;
    if (originalHttpsProxyLower === undefined) delete process.env.https_proxy; else process.env.https_proxy = originalHttpsProxyLower;
    if (originalNoProxyLower === undefined) delete process.env.no_proxy; else process.env.no_proxy = originalNoProxyLower;
    if (originalAllProxyLower === undefined) delete process.env.all_proxy; else process.env.all_proxy = originalAllProxyLower;
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => target.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
