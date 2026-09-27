# 运维说明

[English](../operations.md) | [中文](./operations.md)

本文覆盖 Responses API Compatibility Proxy 的部署、进程管理、迁移和运维流程。

## 多实例目录结构

每个实例在 `instances/` 下拥有独立目录：

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

新增实例：

```bash
cp -r instances/example-11234 instances/proxy-NEWPORT
cp instances/proxy-NEWPORT/.env.example instances/proxy-NEWPORT/.env
cp instances/proxy-NEWPORT/fallback.json.example instances/proxy-NEWPORT/fallback.json
```

`.env` 保存监听和运行标量设置；`fallback.json` 保存 channels、model routes、aliases 和 default model。

## 不要提交运行时 Secret

`.gitignore` 已排除 `instances/proxy-*/`。不要提交真实 `.env`、真实 `fallback.json`、备份、日志、captures 或 SSE 调试输出。`fallback.json` 内含 API key，应保持 `0600` 权限。

## 构建与运行

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 编译 TypeScript 到 `dist/` |
| `npm run proxy:start` | 运行 `dist/json-proxy.js` |
| `npm run proxy` | 使用 `tsx` 运行源码 |

本地单实例：

```bash
env $(grep -v '^#' instances/proxy-11234/.env | xargs) npm run proxy:start
```

## Admin 与健康端点

- `GET /healthz` 返回监听、配置健康和活跃请求数量。
- `GET /v1/models` 从本地配置返回 canonical models 和 aliases，不查询上游。
- `POST /v1/responses` 解析 alias，选择 canonical model route，并按顺序扫描配置的 channel IDs。
- `GET /admin/stats` 暴露 configured models、channel details、model routes、health snapshot、计数器和 timeout 设置。
- `POST /admin/config/reload` 校验文件后，原子刷新 runtime config 与 health topology。

Admin 路由默认只允许 localhost。只有在受信主机绑定、SSH tunnel 或带认证反代后，才启用 `PROXY_ADMIN_ALLOW_HOST=1`。

## Admin UI 工作流

`/admin` 编辑 `.env` 标量设置和 `fallback.json` 中的 channels、有序 model routes、aliases、`default_model`。Secret 读取时被掩码，替换时必须显式输入。

动作：

- Validate：只校验 draft，不写文件。
- Save：写备份，校验，把敏感 JSON 写成 `0600`，reload runtime config，并返回需要重启的字段。
- Reload：从磁盘重读文件。
- Rollback：恢复最近的 `.bak` 并 reload。

`/admin/monitor` 以 channel 行和 model-channel 子行展示健康状态，方便区分 channel-wide failure 与单模型单 channel failure。

## 迁移工具

旧实例目录如果仍包含旧 provider env、旧 fallback 配置和旧 model mappings，可先 dry-run：

```bash
npx tsx tools/migrate-routing-config.ts instances/proxy-11234
```

Dry-run 默认不改文件，只打印 API key 已掩码为 `****1234` 的候选新路由文档和摘要。

写入模式：

```bash
npx tsx tools/migrate-routing-config.ts instances/proxy-11234 --write
```

写入模式会把旧 `fallback.json` 备份为 `fallback.json.bak`，写入新的 `fallback.json` 并保持 `0600`，在 `.env` 中注释旧 provider 变量，然后打印掩码结果。缺少必需的旧主 channel base URL 或 API key 时会拒绝迁移。

生成配置会让每个发现的 canonical model 先走所有转换后的 channel。迁移后应人工检查并收窄每个 model 的 route 顺序。

## Docker 部署

准备 `instances/proxy-11234/.env` 和 `instances/proxy-11234/fallback.json` 后运行：

```bash
docker compose up --build
```

Compose 会构建本地镜像、加载 `.env`、挂载 `instances/proxy-11234`、设置 `FALLBACK_CONFIG_PATH=/app/instances/proxy-11234/fallback.json`、发布 `127.0.0.1:11234:11234`，并通过 `PROXY_ADMIN_ALLOW_HOST=1` 允许宿主机访问 `/admin`。

```bash
docker compose logs -f
docker compose down
```

## systemd 模板

`deploy/systemd/responses-proxy@.service.example` 会加载实例 `.env`，并把 `FALLBACK_CONFIG_PATH` 指向该实例的 `fallback.json`：

```ini
[Service]
WorkingDirectory=/opt/responses-api-compat-proxy
EnvironmentFile=/opt/responses-api-compat-proxy/instances/%i/.env
Environment=FALLBACK_CONFIG_PATH=/opt/responses-api-compat-proxy/instances/%i/fallback.json
ExecStart=/usr/bin/env npm run proxy:start
```

用户级服务安装：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/responses-proxy@.service.example ~/.config/systemd/user/responses-proxy@.service
systemctl --user daemon-reload
systemctl --user enable --now responses-proxy@proxy-NEWPORT
```

按主机实际情况调整 `WorkingDirectory`、`EnvironmentFile`、`WantedBy` 和安装模式。

## 安全重启模式

重启繁忙的 systemd 实例前可使用 `wait-proxy-idle.sh`：

```bash
./wait-proxy-idle.sh proxy-NEWPORT NEWPORT && systemctl --user restart responses-proxy@proxy-NEWPORT
```

脚本轮询 `/healthz`，直到 `activeRequests` 为零或服务已停止。

## 移动运行目录

1. 在目标目录构建项目。
2. 把 `.env` 和 `fallback.json` 复制到 `instances/proxy-NEWPORT/`。
3. 更新 `.env` 中的 `PROXY_ENV_PATH`、`FALLBACK_CONFIG_PATH` 和 captures 目录路径。
4. 启动新进程或 systemd 服务。
5. 验证 `GET /healthz`、`GET /v1/models`、`POST /v1/responses` 和 `/admin/monitor`。
6. 停掉旧进程，清理旧 secret、日志和 captures。
