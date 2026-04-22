# 运维说明

[English](../operations.md) | [中文](./operations.md)

本文覆盖 Responses API Compatibility Proxy 的部署、进程管理与运维操作。

在把仓库推送到公开远端之前，建议先看一遍 [发布检查清单](./publishing-checklist.md)。

---

## 目录

- [多实例目录结构](#多实例目录结构)
- [不要提交真实运行实例目录](#不要提交真实运行实例目录)
- [构建与运行命令](#构建与运行命令)
- [开发模式命令](#开发模式命令)
- [健康检查与管理端点](#健康检查与管理端点)
- [本地管理后台](#本地管理后台)
- [日志与调试输出目录](#日志与调试输出目录)
- [Docker 部署](#docker-部署)
- [安全重启模式](#安全重启模式)
- [systemd 模板](#systemd-模板)
- [从本地工作目录迁移](#从本地工作目录迁移)

---

## 多实例目录结构

每个代理实例都通过 `instances/` 下的独立目录配置。目录名通常会包含端口，方便识别：

```text
instances/
  example-11234/
    .env.example
    fallback.json.example
    model-map.json.example
  example-11235/
    .env.example
    fallback.json.example
    model-map.json.example
  proxy-11234/
    .env
    fallback.json
    model-map.json
  proxy-11235/
    .env
    fallback.json
    model-map.json
```

新增实例的基本步骤：

1. 复制一个 example 目录
2. 编辑 `instances/proxy-NEWPORT/.env`
3. 编辑 `fallback.json` 和 `model-map.json`
4. 使用 `npm run proxy:start`、Docker 或 systemd 启动

```bash
cp -r instances/example-11234 instances/proxy-NEWPORT
```

## 不要提交真实运行实例目录

`.gitignore` 已经排除了 `instances/proxy-*/`，因为这些目录通常包含：

- 真实 API key
- 本地运行路径
- 真实 provider 配置

永远不要提交：

- `instances/proxy-*`
- 真实 `.env`
- 带真实凭据的 `fallback.json` 或 `model-map.json`
- `logs/`、`captures/`、`sse-failures/`

---

## 构建与运行命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 编译 TypeScript 到 `dist/` |
| `npm run proxy:start` | 运行编译后的 `dist/json-proxy.js` |
| `npm run proxy` | 使用 `tsx` 直接运行源码 |

生产环境通常先执行：

```bash
npm run build
npm run proxy:start
```

如果你有单独的实例 `.env` 文件，也可以这样加载后再启动：

```bash
env $(grep -v '^#' instances/proxy-11234/.env | xargs) npm run proxy:start
```

---

## 开发模式命令

| 命令 | 作用 |
| --- | --- |
| `npm run proxy:dev` | 用 `tsx` 运行源码，适合本地开发 |

---

## 健康检查与管理端点

### `GET /healthz`

返回实例当前状态、配置摘要和 `activeRequests` 等信息。示例：

```json
{
  "ok": true,
  "instanceName": "proxy-11234",
  "activeRequests": 3,
  "maxConcurrentRequests": 128,
  "cachedResponses": 12,
  "port": 11234,
  "host": "0.0.0.0"
}
```

### `GET /admin/stats`

返回详细运行时统计信息，包括：

- 请求总量
- JSON/SSE 统计
- fallback 原因分布
- usage 聚合
- endpoint health

### `POST /admin/cache/clear`

清理内存中的响应缓存，返回清掉了多少条。

### `GET /v1/models`

代理上游 `/v1/models`，并应用模型别名映射。

### `GET /v1/responses/:id`

按 ID 查询缓存中的历史响应，未命中则返回 `404`。

### `POST /v1/responses`

主代理入口。接受 OpenAI Responses API 风格请求，并转发到上游，同时执行规范化、fallback、流式处理等逻辑。

> 警告：这些 admin 端点只适合本地或受信网络环境，不应在没有认证/鉴权的情况下直接暴露到公网。

---

## 本地管理后台

访问地址：

```text
http://127.0.0.1:<PORT>/admin
```

### localhost-only 约束

默认情况下，所有 `/admin` 路由只允许这些来源：

- `127.0.0.1`
- `::1`
- `::ffff:127.0.0.1`

远程访问会得到 `403 Forbidden`。如果你需要远程访问，建议使用 SSH tunnel 或带认证的本地反代。不要直接把 `/admin` 暴露到公网。

### UI 页面内容

管理后台包含：

1. 概览：runtime version、restart-required 字段、实例信息
2. Providers：primary provider env 字段和 fallback provider 列表
3. Model Mappings：模型别名到目标模型的映射
4. Runtime / Compatibility：只读运行时参数
5. Review & Apply：Validate / Save / Reload / Rollback

### Draft 模式

前端编辑全部先停留在本地 draft 中，页面会显示 `Unsaved changes`。刷新页面会丢弃 draft，并从服务器重新加载配置。

### 工作流

#### Validate

调用 `POST /admin/config/validate`，只校验 draft，不改文件。

#### Save

1. 前端把 draft 发送到 `PUT /admin/config`
2. 服务端先写 `.bak` 备份，再写入配置，再触发 runtime reload
3. 成功后前端重新读取配置
4. 如果修改涉及 `PORT` 或 `HOST`，会显示“需要重启”提示

#### Reload

调用 `POST /admin/config/reload`，适合手工改过文件后重新加载。

#### Rollback

调用 `POST /admin/config/rollback`，恢复最近一次保存前的 `.bak` 文件并 reload。

### Provider Monitor

监控页面：

```text
http://127.0.0.1:<PORT>/admin/monitor
```

它会展示：

- 全局请求统计
- provider 熔断状态
- 冷却剩余时间
- 最近失败原因
- 活跃请求趋势

监控页面通过 `GET /admin/monitor/stats` 每秒轮询一次，但这个 stats 路由本身不会每秒写一条日志。

### Restart Required 提示

如果 reload 检测到 `PORT` 或 `HOST` 变化，后台会显示显眼的 restart-required 提示。这种改动必须重启进程后才真正生效。

### 常见错误场景

- Save 成功写盘，但 reload 失败
- Rollback 时没有 `.bak` 文件
- Draft 校验失败
- 网络或服务端错误

这些情况都会在 UI 中显示明确错误提示。

---

## 日志与调试输出目录

`.gitignore` 默认排除了这些目录：

| 目录 | 内容 | 风险 |
| --- | --- | --- |
| `logs/` | 请求日志 | 可能包含 prompt 片段 |
| `captures/` | SSE failure / missing usage 调试输出 | 可能包含完整 prompt 与上游响应 |
| `sse-failures/` | 原始 SSE 失败文本 | 可能包含完整 prompt 与上游响应 |
| `dist/` | 编译产物 | 可重新构建 |

相关调试环境变量：

```env
PROXY_DEBUG_SSE=0
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=captures/proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=captures/proxy-11234/stream/missing-usage
PROXY_STREAM_MODE=normalized
```

默认不要开启这些调试输出。排障结束后也要尽快删除已经生成的 captures。

---

## Docker 部署

这是目前最简单的公开部署路径。Docker 容器中不需要 systemd，因为容器只运行前台单进程代理。

### 准备运行实例目录

```bash
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
cp instances/proxy-11234/model-map.json.example instances/proxy-11234/model-map.json
```

编辑 `.env`：

```env
PRIMARY_PROVIDER_NAME=primary-provider
PRIMARY_PROVIDER_BASE_URL=https://provider.example
PRIMARY_PROVIDER_API_KEY=your_api_key_here
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
MODEL_MAP_PATH=./instances/proxy-11234/model-map.json
```

### 启动 compose

```bash
docker compose up --build
```

仓库里的 `docker-compose.yaml` 会：

- 使用本地 `Dockerfile` 构建镜像
- 从 `./instances/proxy-11234/.env` 加载环境变量
- 将 `./instances/proxy-11234` 挂载到容器中的 `/app/instances/proxy-11234`
- 发布 `127.0.0.1:11234:11234`
- 设置 `PROXY_ADMIN_ALLOW_HOST=1`，允许宿主机浏览器访问 `/admin`

如果宿主机 `11234` 已被占用，可以手动修改 compose 文件里 `ports:` 的宿主机侧映射。

### 宿主机访问地址

- API：`http://127.0.0.1:11234/v1/responses`
- Config UI：`http://127.0.0.1:11234/admin`
- Provider Monitor：`http://127.0.0.1:11234/admin/monitor`

### 日志与生命周期

```bash
docker compose logs -f
docker compose down
```

### 编辑挂载配置

admin UI 对 `.env`、`fallback.json`、`model-map.json` 的修改会直接落到宿主机挂载目录中。

### admin 访问安全

`PROXY_ADMIN_ALLOW_HOST=1` 只适合 Docker 场景下通过宿主机访问 `/admin`。它应该始终是显式 opt-in。

当前 compose 文件绑定到 `127.0.0.1`，因此 `/admin` 只会暴露给宿主机本地。如果你改成 `0.0.0.0` 或发布到更广的网络范围，也会把 admin 一起暴露出去，此时应额外加保护。

---

## 安全重启模式

如果你使用 systemd 部署，并且想等所有进行中的请求结束后再重启，可以使用 `wait-proxy-idle.sh`：

```bash
./wait-proxy-idle.sh proxy-NEWPORT NEWPORT
systemctl --user restart responses-proxy@proxy-NEWPORT
```

它会轮询 `/healthz`，直到 `activeRequests === 0` 为止。

支持的环境变量覆盖：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `WAIT_PROXY_IDLE_PORT` | 从实例名后缀提取 | 覆盖 health check 端口 |
| `WAIT_PROXY_IDLE_INTERVAL` | `0.5` | 轮询间隔（秒） |
| `WAIT_PROXY_IDLE_SERVICE` | `responses-proxy@<INSTANCE_NAME>` | systemd 服务名 |
| `WAIT_PROXY_IDLE_STATUS_URL` | `http://127.0.0.1:<PORT>/healthz` | 健康检查 URL |

---

## systemd 模板

仓库提供了模板：

`deploy/systemd/responses-proxy@.service.example`

内容大致如下：

```ini
[Unit]
Description=Responses API Compatibility Proxy (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/responses-api-compat-proxy
EnvironmentFile=/opt/responses-api-compat-proxy/instances/%i/.env
ExecStart=/usr/bin/env npm run proxy:start
Restart=on-failure
RestartSec=5
TimeoutStopSec=120

[Install]
WantedBy=default.target
```

### 安装方式

用户级服务：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/responses-proxy@.service.example ~/.config/systemd/user/responses-proxy@.service
```

系统级服务：

```bash
sudo cp deploy/systemd/responses-proxy@.service.example /etc/systemd/system/responses-proxy@.service
```

启用：

```bash
systemctl --user daemon-reload
systemctl --user enable --now responses-proxy@proxy-NEWPORT
```

或：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now responses-proxy@proxy-NEWPORT
```

需要按你的部署环境调整：

- `WorkingDirectory`
- `EnvironmentFile`
- `WantedBy`
- 实例命名方式

不要把你本地私有的 host、绝对路径、systemd unit 名回写到仓库里。

### `%i` 的含义

systemd 服务名中的 `%i` 会被实例目录名替换。例如：

- `responses-proxy@proxy-11234`

会读取：

- `instances/proxy-11234/.env`

### `TimeoutStopSec`

默认的 `TimeoutStopSec=120` 给正在运行的流式请求预留了最多两分钟结束时间。如果你的 `PROXY_TOTAL_REQUEST_TIMEOUT_MS` 更大，可能需要同步调大 `TimeoutStopSec`。

---

## 从本地工作目录迁移

如果你之前一直在个人工作目录中直接运行代理，后续准备迁移到正式部署路径：

1. 在目标目录重新安装依赖并构建

```bash
cd /opt/responses-api-compat-proxy
npm install --omit=dev
npm run build
```

2. 复制运行实例配置

```bash
mkdir -p instances/proxy-NEWPORT
cp /path/to/old/instances/proxy-NEWPORT/.env instances/proxy-NEWPORT/.env
cp /path/to/old/instances/proxy-NEWPORT/fallback.json instances/proxy-NEWPORT/fallback.json
cp /path/to/old/instances/proxy-NEWPORT/model-map.json instances/proxy-NEWPORT/model-map.json
```

3. 更新 `.env` 里的路径

```env
PROXY_ENV_PATH=./instances/proxy-NEWPORT/.env
FALLBACK_CONFIG_PATH=./instances/proxy-NEWPORT/fallback.json
MODEL_MAP_PATH=./instances/proxy-NEWPORT/model-map.json
PROXY_SSE_FAILURE_DIR=captures/proxy-NEWPORT/sse-failures
PROXY_STREAM_MISSING_USAGE_DIR=captures/proxy-NEWPORT/stream/missing-usage
```

4. 按前面的 systemd 模板安装并启动

5. 验证服务是否健康

```bash
curl -s http://127.0.0.1:NEWPORT/healthz
curl -s http://127.0.0.1:NEWPORT/admin/stats
curl -s http://127.0.0.1:NEWPORT/admin/monitor/stats
```

6. 确认没问题后，停掉旧进程

7. 清理旧工作目录中的真实实例配置、日志和 captures，避免遗留敏感信息
