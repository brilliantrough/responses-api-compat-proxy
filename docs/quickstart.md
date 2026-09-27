# Quickstart

This guide starts a local proxy instance from a clean checkout using the new routing config format.

## 1. Install Dependencies

```bash
npm install
```

## 2. Create a Runtime Instance

```bash
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
```

`instances/proxy-11234/` is gitignored. Put real credentials there, not in tracked example files.

## 3. Configure Channels and Models

Edit `instances/proxy-11234/fallback.json`:

```json
{
  "default_model": "my-model-v2",
  "channels": [
    {
      "id": "primary",
      "name": "Primary Provider",
      "base_url": "https://provider.example",
      "api_key": "your_api_key_here"
    }
  ],
  "models": {
    "my-model-v2": { "channel_ids": ["primary"] }
  },
  "aliases": {
    "public-alias-model": "my-model-v2"
  }
}
```

Every `model` in client requests must be either a key in `models` or a key in `aliases`. Each channel base URL must serve `/v1/responses`; `/v1/models` is generated from this config.

The example `.env` already points `FALLBACK_CONFIG_PATH` at this runtime `fallback.json`. It also keeps `HOST=0.0.0.0` for Docker; use `HOST=127.0.0.1` for local-only testing.

## 4. Build and Start

```bash
npm run build
```

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

## 6. Send Requests

Non-streaming:

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"my-model-v2","input":"Reply with exactly OK.","stream":false}'
```

Streaming:

```bash
curl -N http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"model":"public-alias-model","input":"Count to three.","stream":true}'
```

In `normalized` mode, the stream contains Responses-style SSE events such as `response.created`, `response.output_text.delta`, and `response.completed`.

## 7. Open Admin Pages

- Config UI: `http://127.0.0.1:11234/admin`
- Channel monitor: `http://127.0.0.1:11234/admin/monitor`

By default both are localhost-only. If you enable `PROXY_ADMIN_ALLOW_HOST=1`, keep the published port on a trusted host.

## Recommended Starting Values

The example `.env` uses conservative defaults:

```env
PROXY_STREAM_MODE=normalized
PROXY_UPSTREAM_TIMEOUT_MS=50000
PROXY_NON_STREAM_TIMEOUT_MS=240000
PROXY_FIRST_BYTE_TIMEOUT_MS=40000
PROXY_FIRST_TEXT_TIMEOUT_MS=120000
PROXY_STREAM_IDLE_TIMEOUT_MS=70000
PROXY_TOTAL_REQUEST_TIMEOUT_MS=700000
PROXY_MAX_FALLBACK_TOTAL_MS=480000
PROXY_CHANNEL_COOLDOWN_MS=300000
PROXY_MODEL_CHANNEL_COOLDOWN_MS=120000
PROXY_CHANNEL_FAILURE_THRESHOLD=1
PROXY_MODEL_CHANNEL_FAILURE_THRESHOLD=1
PROXY_HALF_OPEN_MAX_PROBES=1
PROXY_MAX_CONCURRENT_REQUESTS=128
PROXY_MAX_CACHED_RESPONSES=200
```

## Common Mistakes

- Editing tracked `*.example` files instead of gitignored runtime files.
- Sending a request for a model absent from `models` and `aliases`.
- Forgetting that `api_key` is inline in `fallback.json`; keep that file mode `0600`.
- Starting without loading the instance `.env` values.
- Expecting `PORT`, `HOST`, or `PROXY_ENV_PATH` changes to apply without a process restart.

## Next Steps

- See `docs/examples.md` for more routing examples.
- See `docs/configuration.md` for the full config reference.
- See `docs/operations.md` for migration, Docker, systemd, and multi-instance workflows.
