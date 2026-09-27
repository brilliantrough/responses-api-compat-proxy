# 快速开始

[English](../quickstart.md) | [中文](./quickstart.md)

这份指南使用新的路由配置格式，从干净仓库启动一个本地代理实例。

## 1. 安装依赖

```bash
npm install
```

## 2. 创建运行实例

```bash
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
```

`instances/proxy-11234/` 已被 git 忽略。真实凭据请放在这里，不要写入仓库跟踪的 example 文件。

## 3. 配置 Channels 和 Models

编辑 `instances/proxy-11234/fallback.json`：

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

客户端请求里的 `model` 必须存在于 `models` 或 `aliases` 中。每个 channel 的 `base_url` 必须提供 `/v1/responses`；`/v1/models` 由本地配置生成。

示例 `.env` 已经把 `FALLBACK_CONFIG_PATH` 指向运行实例的 `fallback.json`。默认 `HOST=0.0.0.0` 方便 Docker 使用；只想本机访问时改成 `HOST=127.0.0.1`。

## 4. 构建并启动

```bash
npm run build
```

## 5. 检查健康状态

```bash
curl -s http://127.0.0.1:11234/healthz
```

期望形状：

```json
{
  "ok": true,
  "instanceName": "proxy-11234",
  "port": 11234
}
```

## 6. 发送请求

非流式：

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"my-model-v2","input":"Reply with exactly OK.","stream":false}'
```

流式：

```bash
curl -N http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"model":"public-alias-model","input":"Count to three.","stream":true}'
```

`normalized` 模式下可以看到 `response.created`、`response.output_text.delta`、`response.completed` 等 Responses 风格 SSE 事件。

## 7. 打开管理页面

- 配置页面：`http://127.0.0.1:11234/admin`
- Channel 监控：`http://127.0.0.1:11234/admin/monitor`

默认只允许 localhost 访问。如果启用 `PROXY_ADMIN_ALLOW_HOST=1`，请确保端口只暴露在受信主机或网络内。

## 推荐起步值

示例 `.env` 使用偏保守的默认值：

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

## 常见错误

- 修改了仓库里的 `*.example`，而不是 gitignored 的运行实例文件。
- 请求了没有配置在 `models` 或 `aliases` 里的模型。
- 忘记 `api_key` 现在内联在 `fallback.json`，该文件应保持 `0600` 权限。
- 启动时没有加载实例 `.env`。
- 以为 `PORT`、`HOST` 或 `PROXY_ENV_PATH` 修改后无需重启。

## 下一步

- 查看 [示例](./examples.md) 获取更多路由配置。
- 查看 [配置说明](./configuration.md) 了解完整配置。
- 查看 [运维说明](./operations.md) 了解迁移、Docker、systemd 和多实例工作流。
