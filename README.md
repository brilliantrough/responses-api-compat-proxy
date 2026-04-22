# Responses API Compatibility Proxy

[English](./README.md) | [中文](./docs/zh/README.md)

A TypeScript proxy for exploring and operating against upstream providers that expose OpenAI-style `/v1/responses` and `/v1/models` endpoints.

This project focuses on request compatibility, JSON and SSE response handling, fallback routing, stream normalization, runtime admin tooling, and prompt cache hint passthrough. It is not an official OpenAI project.

## What It Helps With

- Proxy `POST /v1/responses` for JSON and streaming clients.
- Proxy `GET /v1/models` with optional model alias exposure.
- Normalize OpenAI Responses-style requests before forwarding upstream.
- Normalize SSE streams or pass them through in `raw` mode.
- Fall back across multiple providers with cooldown and circuit-breaker behavior.
- Inspect and edit runtime config locally through `/admin`.
- Watch provider health and proxy activity through `/admin/monitor`.

## Quick Start

Install dependencies and create a local runtime instance from the tracked example files:

```bash
npm install
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
cp instances/proxy-11234/model-map.json.example instances/proxy-11234/model-map.json
```

Edit `instances/proxy-11234/.env` and fill at least these required fields:

```env
PRIMARY_PROVIDER_NAME=primary-provider
PRIMARY_PROVIDER_BASE_URL=https://provider.example
PRIMARY_PROVIDER_API_KEY=your_api_key_here
```

Optional but commonly changed:

```env
PRIMARY_PROVIDER_DEFAULT_MODEL=my-model-v2
PORT=11234
```

Build and start the proxy with that instance configuration loaded:

```bash
npm run build
env $(grep -v '^#' instances/proxy-11234/.env | xargs) npm run proxy:start
```

Verify a non-streaming request:

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"my-model-v2","input":"Reply with exactly OK.","stream":false}'
```

Verify a streaming request:

```bash
curl -N http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"model":"my-model-v2","input":"Count to three.","stream":true}'
```

Open the local admin pages:

- `http://127.0.0.1:11234/admin`
- `http://127.0.0.1:11234/admin/monitor`

For the full first-run workflow, see `docs/quickstart.md`.

## Docker Quick Start

Docker does not need systemd for this project. The container runs the proxy directly as a single foreground process.

Prepare a local runtime instance directory first:

```bash
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
cp instances/proxy-11234/model-map.json.example instances/proxy-11234/model-map.json
```

Edit `instances/proxy-11234/.env` and fill your provider credentials, then start the container:

```bash
docker compose up --build
```

The compose example:

- mounts `instances/proxy-11234/` into the container,
- publishes `127.0.0.1:11234`,
- enables Docker-specific host access for `/admin` with `PROXY_ADMIN_ALLOW_HOST=1`.

If `11234` is already in use on your host, edit the host side of the port mapping in `docker-compose.yaml`.

After startup, these endpoints are available from the host:

- `http://127.0.0.1:11234/v1/responses`
- `http://127.0.0.1:11234/admin`
- `http://127.0.0.1:11234/admin/monitor`

Keep the published admin-capable port on a trusted host or behind additional protection if you change the port binding away from `127.0.0.1`.

## Example Requests

Minimal non-streaming request:

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"my-model-v2","input":"Say hello.","stream":false}'
```

Minimal streaming request:

```bash
curl -N http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"model":"my-model-v2","input":"Say hello.","stream":true}'
```

More examples, including model aliases, fallback, and prompt cache hints, are in `docs/examples.md`.

## Admin UI

The built-in admin UI is available at `http://127.0.0.1:<PORT>/admin`.

- `/admin` lets you inspect and edit `.env`, fallback config, and model mappings.
- `/admin/monitor` shows provider health, circuit-breaker state, and recent request activity.
- All `/admin` routes are localhost-only.
- Secret values are masked and require explicit replacement.
- Changes to `PORT` or `HOST` still require a full process restart.

## Docs Map

- `docs/quickstart.md` - shortest path from clean checkout to first request.
- `docs/examples.md` - copy-paste requests and config snippets.
- `docs/configuration.md` - required fields, recommended values, advanced knobs.
- `docs/streaming-compatibility.md` - SSE behavior, raw vs normalized mode, timeout phases.
- `docs/operations.md` - multi-instance layout, systemd, admin workflow, safe restarts.
- `Dockerfile` and `docker-compose.yaml` - container build and local Docker deployment.
- `docs/publishing-checklist.md` - final pre-push checklist before publishing to a public remote.

## Repository Layout

- `src/` - production proxy source and compatibility helpers.
- `checks/` - regression and smoke checks.
- `tools/` - manual smoke and load tools.
- `instances/` - tracked example instance layouts and local runtime copies.
- `deploy/systemd/` - systemd service template.
- `public/admin/` - static admin UI assets.
- `docs/` - public documentation.

## Security Notes

- Never commit real `.env` files, real `instances/proxy-*` directories, API keys, logs, captures, or raw debug dumps.
- Admin routes are intended for local or trusted-network use only. Do not expose them directly to the public internet.
- Prompt cache keys must be stable. Do not include timestamps, random IDs, or request IDs.
- Debug capture directories can contain full prompts and provider responses. Keep debug toggles off unless actively investigating an issue.

## License

MIT. See `LICENSE`.
