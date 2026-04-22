# Quickstart

This guide gets a local proxy instance running from a clean checkout with public-safe example files.

## 1. Install Dependencies

```bash
npm install
```

## 2. Create a Local Runtime Instance

Copy the tracked example directory and create local runtime files inside it:

```bash
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
cp instances/proxy-11234/model-map.json.example instances/proxy-11234/model-map.json
```

`instances/proxy-11234/` is gitignored. Keep your real credentials there, not in tracked example files.

## 3. Fill the Required Provider Fields

Edit `instances/proxy-11234/.env` and set:

```env
PRIMARY_PROVIDER_NAME=primary-provider
PRIMARY_PROVIDER_BASE_URL=https://provider.example
PRIMARY_PROVIDER_API_KEY=your_api_key_here
```

You will usually also want:

```env
PRIMARY_PROVIDER_DEFAULT_MODEL=my-model-v2
```

The example file already includes:

- `PROXY_ENV_PATH=./instances/proxy-11234/.env`
- `FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json`
- `MODEL_MAP_PATH=./instances/proxy-11234/model-map.json`

That keeps the admin UI pointed at the same runtime files you started with.

## 4. Build and Start

```bash
npm run build
env $(grep -v '^#' instances/proxy-11234/.env | xargs) npm run proxy:start
```

This command loads the instance `.env` values into the current shell process and starts `dist/json-proxy.js`.

## 5. Check Health

```bash
curl -s http://127.0.0.1:11234/healthz
```

Expected shape:

```json
{
  "ok": true,
  "instanceName": "proxy-11234",
  "port": 11234
}
```

## 6. Send a Non-Streaming Request

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"my-model-v2","input":"Reply with exactly OK.","stream":false}'
```

## 7. Send a Streaming Request

```bash
curl -N http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"model":"my-model-v2","input":"Count to three.","stream":true}'
```

In `normalized` mode, you should see Responses-style SSE events such as `response.created`, `response.output_text.delta`, and `response.completed`.

## 8. Open the Local Admin Pages

- Config UI: `http://127.0.0.1:11234/admin`
- Provider monitor: `http://127.0.0.1:11234/admin/monitor`

Both are localhost-only. Remote requests receive `403 Forbidden`.

## Recommended Starting Values

The example `.env` already uses conservative defaults that work well for many providers:

```env
PROXY_STREAM_MODE=normalized
PROXY_UPSTREAM_TIMEOUT_MS=30000
PROXY_FIRST_BYTE_TIMEOUT_MS=30000
PROXY_FIRST_TEXT_TIMEOUT_MS=12000
PROXY_STREAM_IDLE_TIMEOUT_MS=60000
PROXY_TOTAL_REQUEST_TIMEOUT_MS=600000
PROXY_MAX_CONCURRENT_REQUESTS=128
PROXY_MAX_CACHED_RESPONSES=200
```

Leave these alone for your first run unless you already know your upstream needs different limits.

## Common Mistakes

- Forgetting to fill `PRIMARY_PROVIDER_API_KEY`.
- Pointing `PRIMARY_PROVIDER_BASE_URL` at a site root that does not serve `/v1/responses` and `/v1/models`.
- Starting the proxy without loading the instance `.env` values.
- Editing tracked `*.example` files instead of the gitignored `instances/proxy-11234/` runtime files.
- Expecting `PORT` or `HOST` changes in `/admin` to take effect without restarting the process.

## Next Steps

- See `docs/examples.md` for more request patterns.
- See `docs/configuration.md` for full config reference and recommended profiles.
- See `docs/operations.md` for multi-instance layout and systemd deployment.
