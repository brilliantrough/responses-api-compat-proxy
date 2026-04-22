# 快速开始

这份指南帮助你从一个干净的仓库副本中快速跑起本地代理实例，并使用公开安全的示例配置文件。

[English](../quickstart.md) | [中文](./quickstart.md)

## 1. 安装依赖

```bash
npm install
```

## 2. 创建本地运行实例目录

从仓库中已跟踪的 example 目录复制出一个本地运行实例，并生成运行时文件：

```bash
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
cp instances/proxy-11234/model-map.json.example instances/proxy-11234/model-map.json
```

`instances/proxy-11234/` 已被 `.gitignore` 忽略。真实凭据请放在这里，不要写进仓库跟踪的 example 文件里。

## 3. 填写必需的上游 provider 字段

编辑 `instances/proxy-11234/.env`，至少填写：

```env
PRIMARY_PROVIDER_NAME=primary-provider
PRIMARY_PROVIDER_BASE_URL=https://provider.example
PRIMARY_PROVIDER_API_KEY=your_api_key_here
```

通常你还会一起设置：

```env
PRIMARY_PROVIDER_DEFAULT_MODEL=my-model-v2
```

示例文件已经包含：

- `PROXY_ENV_PATH=./instances/proxy-11234/.env`
- `FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json`
- `MODEL_MAP_PATH=./instances/proxy-11234/model-map.json`

这样 `/admin` 后台会直接读写你当前这套运行时配置文件。

## 4. 构建并启动

```bash
npm run build
env $(grep -v '^#' instances/proxy-11234/.env | xargs) npm run proxy:start
```

这条命令会把实例 `.env` 中的变量加载到当前进程环境，再启动 `dist/json-proxy.js`。

## 5. 检查健康状态

```bash
curl -s http://127.0.0.1:11234/healthz
```

期望返回形状类似：

```json
{
  "ok": true,
  "instanceName": "proxy-11234",
  "port": 11234
}
```

## 6. 发送一个非流式请求

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"my-model-v2","input":"Reply with exactly OK.","stream":false}'
```

## 7. 发送一个流式请求

```bash
curl -N http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"model":"my-model-v2","input":"Count to three.","stream":true}'
```

默认 `normalized` 模式下，你应该能看到 `response.created`、`response.output_text.delta`、`response.completed` 这类 Responses 风格的 SSE 事件。

## 8. 打开本地管理后台

- 配置页面：`http://127.0.0.1:11234/admin`
- provider 监控页面：`http://127.0.0.1:11234/admin/monitor`

这两个页面默认都只允许 localhost 访问，远程请求会收到 `403 Forbidden`。

## 推荐起步参数

example `.env` 里已经放入了一组偏保守、实践可用的默认值：

```env
PROXY_STREAM_MODE=normalized
PROXY_UPSTREAM_TIMEOUT_MS=50000
PROXY_NON_STREAM_TIMEOUT_MS=240000
PROXY_FIRST_BYTE_TIMEOUT_MS=40000
PROXY_FIRST_TEXT_TIMEOUT_MS=120000
PROXY_STREAM_IDLE_TIMEOUT_MS=70000
PROXY_TOTAL_REQUEST_TIMEOUT_MS=700000
PROXY_MAX_FALLBACK_TOTAL_MS=480000
PROXY_MAX_CONCURRENT_REQUESTS=128
PROXY_MAX_CACHED_RESPONSES=200
```

第一次跑通前，除非你已经非常清楚上游特性，否则建议先不要改这些值。

## 常见错误

- 忘记填写 `PRIMARY_PROVIDER_API_KEY`
- `PRIMARY_PROVIDER_BASE_URL` 指向的地址并不提供 `/v1/responses` 和 `/v1/models`
- 启动时没有加载实例 `.env`
- 误改了仓库里的 `*.example` 文件，而不是本地 gitignored 的 `instances/proxy-11234/` 运行时文件
- 误以为 `/admin` 中修改 `PORT` 或 `HOST` 后无需重启即可生效

## 下一步

- 查看 [示例](./examples.md) 获取更多请求样例
- 查看 [配置说明](./configuration.md) 了解全部配置项
- 查看 [运维说明](./operations.md) 了解 Docker 与 systemd 部署方式
