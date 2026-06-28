import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as dotenvParse } from 'dotenv';
import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';

let initialized = false;
let activeProxyAgent: EnvHttpProxyAgent | null = null;

type FetchLike = typeof globalThis.fetch;

function createProxyFetch(): FetchLike {
  return undiciFetch as unknown as FetchLike;
}

function readProxyEnvFromFile(filePath: string) {
  if (!existsSync(filePath)) {
    return {
      httpProxy: undefined,
      httpsProxy: undefined,
      noProxy: undefined,
      allProxy: undefined,
    };
  }
  const parsed = dotenvParse(readFileSync(filePath, 'utf8'));
  return {
    httpProxy: parsed.http_proxy ?? parsed.HTTP_PROXY,
    httpsProxy: parsed.https_proxy ?? parsed.HTTPS_PROXY,
    noProxy: parsed.no_proxy ?? parsed.NO_PROXY,
    allProxy: parsed.all_proxy ?? parsed.ALL_PROXY,
  };
}

export function bootstrapHttpProxySupport() {
  if (initialized) {
    return;
  }
  initialized = true;

  const envPath = resolve(process.env.PROXY_ENV_PATH ?? '.env');
  const fileProxyEnv = readProxyEnvFromFile(envPath);

  const httpProxy = fileProxyEnv.httpProxy ?? process.env.http_proxy ?? process.env.HTTP_PROXY ?? fileProxyEnv.allProxy ?? process.env.all_proxy ?? process.env.ALL_PROXY;
  const httpsProxy = fileProxyEnv.httpsProxy ?? process.env.https_proxy ?? process.env.HTTPS_PROXY ?? fileProxyEnv.allProxy ?? process.env.all_proxy ?? process.env.ALL_PROXY;
  const noProxy = fileProxyEnv.noProxy ?? process.env.no_proxy ?? process.env.NO_PROXY;
  const proxyUrl = httpProxy || httpsProxy;
  if (proxyUrl) {
    activeProxyAgent = new EnvHttpProxyAgent({
      proxyTunnel: false,
      httpProxy,
      httpsProxy,
      noProxy,
    });
    setGlobalDispatcher(activeProxyAgent);
    globalThis.fetch = createProxyFetch();
  }
}
