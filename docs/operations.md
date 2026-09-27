# Operations

Deployment, process management, migration, and operational procedures for the Responses API Compatibility Proxy.

## Multi-Instance Layout

Each instance owns one directory under `instances/`:

```text
instances/
  example-11234/
    .env.example
    fallback.json.example
  example-11235/
    .env.example
    fallback.json.example
  proxy-11234/
    .env
    fallback.json
  proxy-11235/
    .env
    fallback.json
```

To add an instance:

```bash
cp -r instances/example-11234 instances/proxy-NEWPORT
cp instances/proxy-NEWPORT/.env.example instances/proxy-NEWPORT/.env
cp instances/proxy-NEWPORT/fallback.json.example instances/proxy-NEWPORT/fallback.json
```

Edit `.env` for listener/runtime settings and `fallback.json` for channels, model routes, aliases, and the default model.

## Do Not Commit Runtime Secrets

`.gitignore` excludes `instances/proxy-*/`. Never commit real `.env`, real `fallback.json`, backups, logs, captures, or SSE debug output. `fallback.json` contains inline API keys and should stay mode `0600`.

## Build and Run

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript source to `dist/`. |
| `npm run proxy:start` | Run `dist/json-proxy.js`. |
| `npm run proxy` | Run the proxy through `tsx`. |

For a single local instance:

```bash
env $(grep -v '^#' instances/proxy-11234/.env | xargs) npm run proxy:start
```

## Admin and Health Endpoints

- `GET /healthz` reports listener/config health and active request counts.
- `GET /v1/models` returns configured canonical models and aliases without querying upstream.
- `POST /v1/responses` resolves aliases, selects the canonical model route, and scans configured channel IDs in order.
- `GET /admin/stats` exposes configured models, channel details, model routes, health snapshot, counters, and timeout settings.
- `POST /admin/config/reload` validates files, then atomically refreshes runtime config and health topology.

Admin routes are localhost-only by default. Use `PROXY_ADMIN_ALLOW_HOST=1` only behind a trusted host binding, SSH tunnel, or authenticated proxy.

## Admin UI Workflow

`/admin` edits scalar `.env` settings plus `fallback.json` channels, ordered model routes, aliases, and `default_model`. Secrets are masked on read and require explicit replacement.

Actions:

- Validate checks a draft without writing files.
- Save writes backups, validates, writes sensitive JSON as `0600`, reloads runtime config, and reports restart-required fields.
- Reload rereads files from disk.
- Rollback restores the latest `.bak` files and reloads.

`/admin/monitor` shows channel rows with model-channel children so operators can distinguish channel-wide failures from one model failing on one channel.

## Migration Tool

Use the migration tool for legacy instance directories that still contain old provider env vars, legacy fallback config, and legacy model mappings:

```bash
npx tsx tools/migrate-routing-config.ts instances/proxy-11234
```

Dry-run is the default. It prints a proposed new routing document with API keys masked as `****1234`, plus a summary. No files are changed.

Write mode applies the migration:

```bash
npx tsx tools/migrate-routing-config.ts instances/proxy-11234 --write
```

Write mode backs up `fallback.json` to `fallback.json.bak`, writes the new `fallback.json` with mode `0600`, comments legacy provider variables in `.env`, and prints the masked result. It refuses partial input when required legacy primary base URL or API key values are missing.

The generated config intentionally routes every discovered canonical model through every converted channel. Review and narrow per-model route order after migration.

## Docker Deployment

Prepare `instances/proxy-11234/.env` and `instances/proxy-11234/fallback.json`, then run:

```bash
docker compose up --build
```

The compose file builds the local image, loads `.env`, mounts `instances/proxy-11234`, sets `FALLBACK_CONFIG_PATH=/app/instances/proxy-11234/fallback.json`, publishes `127.0.0.1:11234:11234`, and enables host access to `/admin` with `PROXY_ADMIN_ALLOW_HOST=1`.

Use:

```bash
docker compose logs -f
docker compose down
```

## Systemd Template

`deploy/systemd/responses-proxy@.service.example` loads instance `.env` and points `FALLBACK_CONFIG_PATH` at that instance's `fallback.json`:

```ini
[Service]
WorkingDirectory=/opt/responses-api-compat-proxy
EnvironmentFile=/opt/responses-api-compat-proxy/instances/%i/.env
Environment=FALLBACK_CONFIG_PATH=/opt/responses-api-compat-proxy/instances/%i/fallback.json
ExecStart=/usr/bin/env npm run proxy:start
```

Install as a user service:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/responses-proxy@.service.example ~/.config/systemd/user/responses-proxy@.service
systemctl --user daemon-reload
systemctl --user enable --now responses-proxy@proxy-NEWPORT
```

Adjust `WorkingDirectory`, `EnvironmentFile`, `WantedBy`, and installation mode for your host.

## Safe Restart Pattern

Use `wait-proxy-idle.sh` before restarting a busy systemd instance:

```bash
./wait-proxy-idle.sh proxy-NEWPORT NEWPORT && systemctl --user restart responses-proxy@proxy-NEWPORT
```

It polls `/healthz` until `activeRequests` reaches zero or the service stops.

## Moving a Runtime Directory

1. Build at the target location.
2. Copy `.env` and `fallback.json` to `instances/proxy-NEWPORT/`.
3. Update `PROXY_ENV_PATH`, `FALLBACK_CONFIG_PATH`, and capture directory paths in `.env`.
4. Start the new process or systemd service.
5. Verify `GET /healthz`, `GET /v1/models`, `POST /v1/responses`, and `/admin/monitor`.
6. Stop the old process and remove old secrets, logs, and captures.
