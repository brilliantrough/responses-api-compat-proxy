# Responses API Compatibility Proxy

[English](./README.md) | [中文](./docs/zh/README.md)

A TypeScript compatibility proxy for upstream providers exposing OpenAI-style `/v1/responses` and `/v1/models` endpoints.

It normalizes Responses API requests and JSON/SSE responses, routes each canonical model through an ordered channel list, exposes aliases, and keeps channel and model-channel health in memory. The proxy is not an official OpenAI project.

## Quick Start

Create a local runtime instance from the tracked template:

```bash
npm install
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
```

Edit `instances/proxy-11234/fallback.json` with the upstream channel credentials and model route:

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
  "aliases": {}
}
```

Channel and model configuration lives in `fallback.json`; `.env` contains listener, timeout, stream, debug, and health settings. The example keeps `HOST=0.0.0.0` for Docker. Use `HOST=127.0.0.1` for a local-only process.

Build and start:

```bash
npm run build
```

Send a request whose `model` is configured in `models` or `aliases`:

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"my-model-v2","input":"Reply with exactly OK.","stream":false}'
```

Open `http://127.0.0.1:11234/admin` for config editing and `http://127.0.0.1:11234/admin/monitor` for health monitoring.

Persistent usage analytics is available at `/admin/usage` (Node.js 22.13+). It supports hourly/daily ranges, channel/model filters, stacked request/token charts, cache-hit trends, and CSV export. Each instance stores numeric upstream-attempt records in `usage.sqlite` beside its `PROXY_ENV_PATH` file (beside the routing config if no env path is supplied). History starts when the upgraded instance is launched; the existing monitor counters are process-local. See [usage accounting and storage](docs/project_memory/decisions.sdoc).

## Docker Quick Start

```bash
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
```

Fill `fallback.json`, then run:

```bash
docker compose up --build
```

Compose mounts the instance directory, loads `.env`, and binds the proxy to `127.0.0.1:11234`. Keep the admin-capable port on a trusted host.

## Routing Model

- `channels` contains inline credentials and normalized provider base URLs.
- `models` maps each canonical model to an ordered `channel_ids` list.
- `aliases` maps client-facing names to canonical models and shares their route and health state.
- `default_model` is used when a request omits `model` and may name an alias.

The proxy scans the complete configured route within request and fallback time budgets. A request with no selectable channel returns `503` with `model_channels_unavailable`; after at least one upstream attempt fails, the existing `fallback_exhausted` response is preserved.

The admin UI edits channels, ordered model routes, aliases, and the default model. It masks secrets, writes sensitive routing files and backups with mode `0600`, and reloads the validated document atomically. The monitor displays channel rows with model-channel children.

## Claude Code Gateway Compatibility

For traffic passing through Claude Code-oriented gateways, keep:

```env
PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line
```

This removes dynamic billing attribution lines from `instructions` and system/developer text so stable prompt prefixes remain cacheable. `strip_cch` removes only the dynamic `cch=...` field.

## Documentation

- `docs/quickstart.md` - first local run.
- `docs/examples.md` - routing and request examples.
- `docs/configuration.md` - routing document, environment variables, health, and secrets.
- `docs/streaming-compatibility.md` - normalized and raw SSE behavior.
- `docs/operations.md` - multi-instance, migration, systemd, Docker, and admin workflows.

## Repository Layout

- `src/` - production proxy source and compatibility helpers.
- `checks/` - regression and smoke checks.
- `tools/` - manual smoke, load, and migration tools.
- `instances/` - tracked example instance layouts and gitignored runtime copies.
- `deploy/systemd/` - systemd service template.
- `public/admin/` - static admin UI assets.
- `docs/` - public documentation.

## Security Notes

- Never commit real `.env` files, `instances/proxy-*`, API keys, logs, captures, or raw debug dumps.
- Keep `/admin` on localhost or a trusted network.
- Treat `fallback.json` and `fallback.json.bak` as sensitive files and preserve mode `0600`.
- Prompt cache keys must be stable; do not include timestamps, random IDs, or request IDs.

## License

MIT. See `LICENSE`.
