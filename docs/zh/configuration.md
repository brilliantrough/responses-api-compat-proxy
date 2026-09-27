# 配置说明

[English](../configuration.md) | [中文](./configuration.md)

代理从环境变量读取标量运行参数，从 `FALLBACK_CONFIG_PATH` 指向的一个 JSON 文件读取所有 channel/model 路由配置。

## 路由文档

`fallback.json` 是 upstream channels、canonical model routes、aliases 和 default model 的唯一配置源：

```json
{
  "default_model": "gpt-5.4",
  "channels": [
    {
      "id": "provider-a",
      "name": "Provider A",
      "base_url": "https://provider-a.example",
      "api_key": "replace-me"
    },
    {
      "id": "provider-b",
      "base_url": "https://provider-b.example",
      "api_key": "replace-me"
    }
  ],
  "models": {
    "gpt-5.4": { "channel_ids": ["provider-a", "provider-b"] },
    "gpt-5.2": { "channel_ids": ["provider-b", "provider-a"] }
  },
  "aliases": {
    "gpt-latest": "gpt-5.4"
  }
}
```

规则：

- Channel ID 是稳定唯一标识；`name` 只用于展示，缺省时等于 `id`。
- 每个 model route 拥有自己的有序 `channel_ids`；`channels` 数组顺序不决定路由优先级。
- Alias 只能指向 canonical model，不拥有独立 route 或 health state。
- `default_model` 可以是 canonical model 或 alias；运行时会保存 canonical 目标。
- 同一次 routed request 会把同一个 canonical model 字符串发给所有 channel。
- `fallback.json` 和 `fallback.json.bak` 含 inline credentials，必须保持 `0600` 权限。

校验会拒绝旧结构字段、env-key 引用、重复 channel、未知 channel ID、alias 链和未知 default model。渠道可配置 `disable_cooldown: true`（No breaker），仅豁免普通自动熔断，额度和人工熔断仍生效。

## 常用 `.env` 字段

```env
PORT=11234
HOST=0.0.0.0
INSTANCE_NAME=proxy-11234
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
```

`PORT`、`HOST` 和 `PROXY_ENV_PATH` 需要进程重启才完整生效。Admin API 可以在校验通过后 runtime reload 路由和多数标量设置。

## 运行时参考

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `11234` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；本机运行可用 `127.0.0.1` |
| `INSTANCE_NAME` | `responses-proxy-${PORT}` | 日志、captures、admin 中显示的实例名 |
| `PROXY_ENV_PATH` | `.env` | 启动和 admin 编辑使用的 `.env` |
| `FALLBACK_CONFIG_PATH` | `fallback.json` | 路由配置文件路径 |
| `PROXY_ADMIN_ALLOW_HOST` | `0` | 显式允许非 localhost 访问 `/admin` |
| `PROXY_MAX_CONCURRENT_REQUESTS` | `512` | 最大活跃代理请求数 |
| `PROXY_MAX_CACHED_RESPONSES` | `200` | 缓存响应查询条数 |
| `PROXY_FORCE_STORE_FALSE` | `0` | 必要时向上游注入 `store: false` |

## 超时设置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `8000` | 初始 stream 连接建立 |
| `PROXY_NON_STREAM_TIMEOUT_MS` | `20000` | 非流式上游请求生命周期 |
| `PROXY_FIRST_BYTE_TIMEOUT_MS` | `8000` | 等待响应体首个 chunk |
| `PROXY_FIRST_TEXT_TIMEOUT_MS` | `0` | normalized stream 中等待识别文本；`0` 表示关闭 |
| `PROXY_STREAM_IDLE_TIMEOUT_MS` | `15000` | stream chunk 间最大空闲 |
| `PROXY_TOTAL_REQUEST_TIMEOUT_MS` | `45000` | 整个代理请求生命周期 |
| `PROXY_MAX_FALLBACK_TOTAL_MS` | `30000` | 扫描已配置 route channels 的时间预算 |

建议保持 `PROXY_TOTAL_REQUEST_TIMEOUT_MS` 大于 `PROXY_MAX_FALLBACK_TOTAL_MS`，这样 fallback exhausted 仍能返回受控错误。

## Health 与 Fallback 控制

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PROXY_HEALTH_WINDOW_MS` | `180000` | 按上游尝试结束时间统计的滑动窗口，毫秒 |
| `PROXY_HEALTH_FAILURE_THRESHOLD` | `15` | 窗口内至少失败多少次 |
| `PROXY_HEALTH_FAILURE_RATE_THRESHOLD` | `0.5` | 失败率严格大于此比例，并满足次数条件才熔断 |
| `PROXY_HEALTH_COOLDOWN_MS` | `600000` | 普通与人工熔断时长，毫秒 |
| `PROXY_CHANNEL_MAX_ATTEMPTS` | `3` | 每请求每渠道总尝试上限，包含首次 |
| `PROXY_CHANNEL_RETRY_DELAY_MS` | `500` | 同渠道重试间隔，毫秒；换渠道不等待 |
| `PROXY_CACHE_KEY_POOL_SIZE` | `100` | 精确 cache key 的 LRU 历史容量，不覆盖路由优先级 |
| `PROXY_QUOTA_COOLDOWN_MS` | `7200000` | 额度冷却毫秒；No breaker 也必须遵守 |
| `PROXY_FALLBACK_ON_RETRYABLE_4XX` | `1` | 对选定 retryable upstream 4xx 启用 fallback |
| `PROXY_FALLBACK_ON_COMPAT_4XX` | `1` | 对匹配兼容模式的 4xx 启用 fallback |
| `PROXY_FALLBACK_COMPAT_PATTERNS` | 内置列表 | 额外兼容 fallback 消息 |
| `PROXY_NO_FALLBACK_CLIENT_ERROR_PATTERNS` | 内置列表 | 明确不 fallback 的客户端输入错误 |

Health scope：

- 普通 Responses 所有模型合并到渠道窗口；compact 按 `compact:<model>` 与 `compact-v2:<model>` 独立统计。失败两次后成功记 2 失败 + 1 成功。客户端取消、明确输入错误、代理内部错误不参与窗口。
- 每个新请求从最高优先级可用渠道开始，同渠道最多三次再向下 fallback；在途请求只向下走，上位渠道恢复后下一个新请求回切。100-key 池只记历史，不去重、不将会话锁在 fallback 渠道。
- 额度耗尽立即停止剩余重试并全渠道冷却；迟到成功不能清除。人工恢复或到期后可重试，新的额度失败会重新熔断。
- `/admin/monitor` 提供立即熔断/立即恢复；人工熔断默认十分钟，恢复清除所有阻断和失败窗口，保留历史累计统计。操作前的迟到结果不能覆盖人工状态。接口 `POST /admin/channels/breaker` 需要 channelId、当前 fingerprint、action=open|close。
- 已输出的 SSE 不透明重放；有效输出缺失 usage 不触发重试，缺失 token 字段保持未知。

旧 `PROXY_CHANNEL_COOLDOWN_MS`、`PROXY_MODEL_CHANNEL_COOLDOWN_MS`、`PROXY_CHANNEL_FAILURE_THRESHOLD`、`PROXY_MODEL_CHANNEL_FAILURE_THRESHOLD`、`PROXY_HALF_OPEN_MAX_PROBES` 已停用并会警告。新策略参数支持校验与热更新，已有冷却截止时间不随参数修改而提前解除。

如果所有候选都在请求开始前被 health 阻断，代理返回 `503 model_channels_unavailable` 和 `Retry-After`。如果至少开始过一次上游请求，随后所有可用 route 都失败，则保留 `fallback_exhausted` 语义。

Reload 会先校验完整候选配置，再同步提交 runtime snapshot、health settings 与 topology。旧请求里的过期 lease 不能修改新 topology。

## 请求规范化

```env
PROXY_CONVERT_SYSTEM_TO_DEVELOPER=1
PROXY_CLEAR_DEVELOPER_CONTENT=0
PROXY_CLEAR_SYSTEM_CONTENT=0
PROXY_CLEAR_INSTRUCTIONS=0
PROXY_OVERRIDE_INSTRUCTIONS_TEXT=
PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line
```

`PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line` 会删除可能破坏 prompt-cache 前缀稳定性的网关 attribution 行。`strip_cch` 保留整行，只删除动态 `cch=...` 字段。

## 流模式

```env
PROXY_STREAM_MODE=normalized
```

- `normalized`：解析上游 SSE 并转发 Responses 风格事件。
- `raw`：减少解释，更接近原样透传上游 SSE。

客户端可以通过请求体 `proxy_stream_mode` 或请求头 `X-Proxy-Stream-Mode` 覆盖。

## Admin 编辑与 Secret

Admin UI 编辑 `.env` 和 `fallback.json`。Channel API key 读取时会被掩码，替换时必须显式输入。路由保存会创建 `.bak`，把敏感 JSON 写成 `0600`，先校验再 reload；reload 失败时保留旧 runtime snapshot。

Admin API 写 `.env` 时会归一化注释、引号和多行值。从 `.env` 清掉继承的环境值后仍需要重启进程。

## Prompt Cache Hints

代理保留客户端传入的 `prompt_cache_retention` 和 `prompt_cache_key`。缺省时可注入默认值：

```env
PROXY_PROMPT_CACHE_RETENTION=in_memory
PROXY_PROMPT_CACHE_KEY=stable-prefix-key
```

只使用稳定前缀 key。不要包含时间戳、UUID、request ID 或其他按请求变化的熵。

## Debug 设置

```env
PROXY_LOG_REQUEST_BODY=0
PROXY_DEBUG_SSE=0
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=captures/proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=captures/proxy-11234/stream/missing-usage
```

Debug captures 可能包含完整 prompt 和上游响应。除非正在排障，否则保持关闭。
