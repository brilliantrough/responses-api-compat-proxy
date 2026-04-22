# 配置说明

[English](../configuration.md) | [中文](./configuration.md)

代理会从环境变量读取标量运行参数，从 JSON 文件读取 fallback 与 model mapping 这类结构化配置。

建议按两步阅读：

1. 先填必需字段，把服务跑起来
2. 再根据上游 provider 的行为调整推荐参数

## 必需字段

要调用上游 provider，最少需要下面这些变量：

```env
PRIMARY_PROVIDER_NAME=primary-provider
PRIMARY_PROVIDER_BASE_URL=https://provider.example
PRIMARY_PROVIDER_API_KEY=your_api_key_here
```

代理会拼接并调用：

- `PRIMARY_PROVIDER_BASE_URL + /v1/responses`
- `PRIMARY_PROVIDER_BASE_URL + /v1/models`

如果这个 base URL 本身不提供这两个端点，代理就无法正常工作。

## 大多数人会改的常用字段

```env
PRIMARY_PROVIDER_DEFAULT_MODEL=my-model-v2
PORT=11234
HOST=0.0.0.0
INSTANCE_NAME=proxy-11234
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
MODEL_MAP_PATH=./instances/proxy-11234/model-map.json
```

- `PRIMARY_PROVIDER_DEFAULT_MODEL`：便于测试时使用的默认模型名
- `PORT` / `HOST`：监听地址
- `INSTANCE_NAME`：日志、管理后台、captures 中使用的逻辑实例名
- `PROXY_ENV_PATH`：告诉 `/admin` 后台该读写哪个 `.env`
- `FALLBACK_CONFIG_PATH` / `MODEL_MAP_PATH`：通常应指向 gitignored 的运行时文件，而不是仓库里的 `*.example`

### 需要重启才生效的字段

`PORT` 或 `HOST` 改动后，runtime reload 会检测到，但仍然需要完整重启进程才会真正生效。管理后台会把这些字段列在 `restartRequiredFields` 中，并显示重启提示。

`PROXY_ENV_PATH` 同样需要重启，因为它只在启动时读取一次。

## 进阶运行参数

第一次跑通时，大多数人不需要修改这一节。

### 运行时参考表

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `11234` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `INSTANCE_NAME` | `responses-proxy-${PORT}` | 日志、captures、admin 中显示的实例名 |
| `PROXY_ENV_PATH` | `.env` | 启动和 admin 编辑时使用的 `.env` 路径 |
| `PROXY_ADMIN_ALLOW_HOST` | `0` | 显式开启时允许非 localhost 访问 `/admin`，主要用于 Docker 宿主机访问 |
| `FALLBACK_CONFIG_PATH` | `config.json` | fallback provider JSON 路径 |
| `MODEL_MAP_PATH` | `model-map.json` | 模型映射 JSON 路径 |
| `PROXY_MAX_CONCURRENT_REQUESTS` | `512` | 最大并发请求数 |
| `PROXY_MAX_CACHED_RESPONSES` | `200` | 缓存响应条目上限 |
| `PROXY_FORCE_STORE_FALSE` | `0` | 必要时向上游注入 `store: false` |

仓库中的 `instances/example-*` 是模板。真实部署请复制到 gitignored 的运行时目录，例如 `instances/proxy-11234/.env`、`instances/proxy-11234/fallback.json`、`instances/proxy-11234/model-map.json`。

`PROXY_ADMIN_ALLOW_HOST=1` 主要用于 Docker 场景：服务发布到宿主机 `127.0.0.1`，同时希望宿主机浏览器访问 `/admin`。默认保持关闭即可，保持原有 localhost-only 行为。

### 超时参数

代码默认值：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `8000` | 等待上游返回初始响应头 |
| `PROXY_NON_STREAM_TIMEOUT_MS` | `20000` | 非流式请求整体超时 |
| `PROXY_FIRST_BYTE_TIMEOUT_MS` | `8000` | 等待响应体首个字节 |
| `PROXY_FIRST_TEXT_TIMEOUT_MS` | `0` | 等待识别到首段文本；`0` 表示关闭这一层保护 |
| `PROXY_STREAM_IDLE_TIMEOUT_MS` | `15000` | 流式响应 chunk 间最大空闲间隔 |
| `PROXY_TOTAL_REQUEST_TIMEOUT_MS` | `45000` | 整个请求生命周期硬上限 |
| `PROXY_MAX_FALLBACK_ATTEMPTS` | fallback endpoint 数量，最少 `1` | 最多尝试几个 fallback 端点 |
| `PROXY_MAX_FALLBACK_TOTAL_MS` | `30000` | fallback 总耗时预算 |

### 推荐配置档位

#### 本地开发

适合单机快速联调：

```env
PROXY_STREAM_MODE=normalized
PROXY_MAX_CONCURRENT_REQUESTS=32
PROXY_MAX_CACHED_RESPONSES=50
```

#### 通用稳定代理

适合大多数公开使用场景：

```env
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

#### 长流式输出

适合生成内容很长、chunk 间停顿明显的 provider：

```env
PROXY_FIRST_TEXT_TIMEOUT_MS=120000
PROXY_STREAM_IDLE_TIMEOUT_MS=70000
PROXY_TOTAL_REQUEST_TIMEOUT_MS=700000
```

如果你的上游 provider 首字节慢、首段文本慢，或者流式间隔容易长时间空闲，就需要把这些值调大。如果你更倾向“快速失败并尽快 fallback”，则可以调小。

始终建议保持：

- `PROXY_TOTAL_REQUEST_TIMEOUT_MS > PROXY_MAX_FALLBACK_TOTAL_MS`

这样即便 fallback 全部耗尽，也还能返回一个可控的失败结果。

示例模板当前使用的稳定起步值：

```env
PROXY_UPSTREAM_TIMEOUT_MS=50000
PROXY_NON_STREAM_TIMEOUT_MS=240000
PROXY_FIRST_BYTE_TIMEOUT_MS=40000
PROXY_FIRST_TEXT_TIMEOUT_MS=120000
PROXY_STREAM_IDLE_TIMEOUT_MS=70000
PROXY_TOTAL_REQUEST_TIMEOUT_MS=700000
PROXY_MAX_FALLBACK_TOTAL_MS=480000
```

### 流模式

```env
PROXY_STREAM_MODE=normalized
```

支持值：

- `normalized`：解析上游 SSE，规范化为 Responses 风格事件，并在识别到文本前缓冲元数据事件
- `raw`：尽量原样透传上游 SSE，减少代理侧解释

客户端也可以通过以下方式覆盖默认流模式：

- 请求体中的 `proxy_stream_mode`
- 请求头中的 `X-Proxy-Stream-Mode`

### Fallback 策略与熔断相关参数

```env
PROXY_FALLBACK_ON_RETRYABLE_4XX=1
PROXY_FALLBACK_ON_COMPAT_4XX=1
PROXY_FALLBACK_COMPAT_PATTERNS=model not found,unsupported model,store must be false
PROXY_NO_FALLBACK_CLIENT_ERROR_PATTERNS=maximum context length,input too large
PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS=120000
PROXY_ENDPOINT_INVALID_RESPONSE_COOLDOWN_MS=120000
PROXY_ENDPOINT_AUTH_COOLDOWN_MS=1800000
PROXY_ENDPOINT_FAILURE_THRESHOLD=1
PROXY_ENDPOINT_HALF_OPEN_MAX_PROBES=1
```

这组参数决定：

- 哪些上游错误会触发 fallback
- 某个 endpoint 失败后要冷却多久
- 半开状态最多允许多少次探测

### 请求规范化

```env
PROXY_CONVERT_SYSTEM_TO_DEVELOPER=1
PROXY_CLEAR_DEVELOPER_CONTENT=0
PROXY_CLEAR_SYSTEM_CONTENT=0
PROXY_CLEAR_INSTRUCTIONS=0
PROXY_OVERRIDE_INSTRUCTIONS_TEXT=
```

只有当某些 provider 需要额外兼容处理时才建议改这里。默认会启用 `PROXY_CONVERT_SYSTEM_TO_DEVELOPER`。

## fallback provider 配置

更推荐使用 `api_key_env`，把密钥保存在 env 文件中：

```json
{
  "fallback_api_config": [
    {
      "name": "fallback-a",
      "base_url": "https://fallback-a.example",
      "api_key_env": "FALLBACK_A_API_KEY"
    }
  ]
}
```

## 模型映射

模型映射会改写发给上游的真实模型名，同时尽量保留客户端请求时的模型别名：

```json
{
  "model_mappings": {
    "public-alias-model": "my-model-v2"
  }
}
```

## 配置文件路径与 admin 编辑

代理会根据环境变量定位三类配置文件：

| 文件 | 默认路径 | 环境变量 | 是否可通过 admin 编辑 |
| --- | --- | --- | --- |
| `.env` | `.env` | `PROXY_ENV_PATH` | Yes |
| fallback JSON | `config.json` | `FALLBACK_CONFIG_PATH` | Yes |
| model map JSON | `model-map.json` | `MODEL_MAP_PATH` | Yes |

`PROXY_ENV_PATH` 会覆盖 `.env` 位置。设置后，`/admin` 页面会从这个路径读取并写回 `.env`。

### Secret 处理

所有包含 `KEY`、`TOKEN`、`SECRET` 的环境变量会被视为 secret：

- 读取：`GET /admin/config` 返回 `***`，不会返回真实值
- 编辑：secret 字段在 UI 中显示为掩码输入框，需要显式替换
- 保存：`PUT /admin/config` 支持 `keep`、`replace`、`clear` 三种动作；未指定时默认为 `keep`

### `.env` 写回限制

admin API 写 `.env` 时会做格式归一化：

- 注释、引号、多行值不会被保留
- 从 `.env` 中删除某个键，不会立刻清掉进程启动时继承的 `process.env` 值

如果你是在清理敏感配置，建议保存后重启代理。

### 运行时路径解析

fallback JSON 与 model-map JSON 的 admin 路径来自当前 runtime snapshot，而不是进程启动时一次性固定。所以 reload 后，如果你修改了 `FALLBACK_CONFIG_PATH` 或 `MODEL_MAP_PATH`，后续 admin 请求会自动使用新路径。

## Prompt Cache Hints

代理会保留客户端传入的 `prompt_cache_retention` 和 `prompt_cache_key`。如果客户端没带，也可以通过环境变量注入默认值：

```env
PROXY_PROMPT_CACHE_RETENTION=in_memory
PROXY_PROMPT_CACHE_KEY=stable-prefix-key
```

`PROXY_PROMPT_CACHE_KEY` 只能用于稳定的 prompt 前缀 key，不要加入时间戳、UUID、request id 或其他按请求变化的熵，否则 cache hit rate 会非常差。

上游 provider 是否真的支持这些 hint，仍取决于它自身实现。

## 调试参数（默认关闭）

```env
PROXY_LOG_REQUEST_BODY=0
PROXY_DEBUG_SSE=0
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=captures/proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=captures/proxy-11234/stream/missing-usage
```

`PROXY_LOG_REQUEST_BODY` 会记录原始请求内容，除非你正在本地排障，否则应保持关闭。各种 debug capture 目录可能包含完整 prompt 和上游响应，默认不要开启，也绝不要提交这些输出。
