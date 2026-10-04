这个项目主要用于探索兼容 OpenAI Responses API 的上游 provider，重点是请求规范化、普通 JSON 返回、流式 SSE 事件、模型感知路由与运行时运维。

需要理解 OpenAI Responses API 的请求结构、普通 JSON 返回和流式 SSE 事件格式，尤其要关注流式返回的数据包、异常路径和兼容性处理。

每个实例在 `instances/<instance-name>/` 下维护自己的运行配置：

- `.env`：监听、超时、流模式、debug、prompt cache 和 health 标量配置
- `fallback.json`：唯一的 channel、canonical model route、alias 和 `default_model` 配置源

路由文档使用以下结构：

```json
{
  "default_model": "gpt-5.4",
  "channels": [
    {
      "id": "provider-a",
      "name": "Provider A",
      "base_url": "https://provider-a.example",
      "api_key": "replace-me"
    }
  ],
  "models": {
    "gpt-5.4": { "channel_ids": ["provider-a"] }
  },
  "aliases": {
    "gpt-latest": "gpt-5.4"
  },
  "compact": {
    "model": "gpt-5.4",
    "channel_ids": ["provider-a"],
    "v2_channel_ids": ["provider-b"]
  }
}
```

`channels` 保存 inline credentials；`models` 为每个 canonical model 指定有序 channel 列表；`aliases` 只解析到 canonical model，不拥有独立 route 或 health state；`default_model` 可以是 alias，但运行时会解析为 canonical model。

`compact` 是可选的独立 compact 路由，代理 OpenAI 风格的上下文压缩调用：

- **v1**（一元端点 `POST /v1/responses/compact`）：`compact.channel_ids` 是有序 fallback 列表，`compact.model` 固定 canonical model（可以是 alias，运行时解析），客户端传的 model 会被覆盖
- **v2**（codex remote compaction v2）：普通流式 `POST /v1/responses`，input 数组末尾带 `{"type":"compaction_trigger"}` 条目。`compact.v2_channel_ids`（可选）是独立的 v2 fallback 列表；命中 v2 请求时不覆盖 model（压缩跟随客户端对话模型）；代理会补发/透传 `x-codex-beta-features: remote_compaction_v2` 头
- v1/v2 渠道能力是**相交为零**的两套集合（OAuth 中转通常 v2-only，API-key 中转通常 v1-only），必须分别配置、分别检测
- compact 普通故障使用隔离 scope：v1 用 `compact:<model>`，v2 用 `compact-v2:<model>`；仅额度耗尽和人工熔断跨普通 Responses 与 compact 生效
- 未配置 `compact` 时 v1 端点返回 `501 compact route not configured`；v1 全阻断返回 `503 compact_channels_unavailable`，v2 全阻断返回 `503 compact_v2_channels_unavailable`
- 压缩流没有 output_text：`compaction` 输出项被视为有效输出（不触发 `stream_no_text_content` 假 fallback），v2 请求豁免 first-text 超时，`response.compaction` 的 object 值在归一化中被保留
- compact 支持检测会在配置加载后自动对每个渠道探测 v1+v2 两种协议（有少量 token 成本），结果按 channel fingerprint + model + protocol 缓存在内存中，仅供 admin UI 展示，不会修改熔断器状态；v2 的 `bridge_only` 状态表示端点接受请求但只返回明文 bridge（非真加密 compaction）；可用 `PROXY_COMPACT_DETECT_ENABLED=0` 关闭

每个 channel 使用统一的 `/v1/responses` 与 `/v1/models` 路径。请求只会访问其 canonical model route 中配置的 channel，并使用同一个 canonical model 字符串转发给所有 channel。

健康状态使用同一个内存 registry，同时维护：

- 普通 Responses 各模型共用 channel 滑动窗口；compact v1/v2 按模型与协议隔离。每次真实上游尝试结束计一次，窗口默认 180 秒，失败至少 15 次且失败率严格大于 50% 时熔断 600 秒；成功不清空窗口，恢复后重新统计，无半开一次失败重开机制
- 每请求每渠道最多 3 次（首次 + 2 次重试），同渠道重试默认间隔 500ms，然后顺序 fallback；每个新请求从最高优先级可用渠道开始；100 个精确 cache key 的 LRU 池只记录渠道历史，不覆盖优先级
- No breaker（`disable_cooldown`）只豁免普通自动熔断。额度耗尽立即跳过剩余尝试，默认冷却 2 小时；并发迟到成功不能清除额度冷却
- `/admin/monitor` 支持立即熔断（默认 10 分钟）和立即恢复，`POST /admin/channels/breaker` 接收 channelId、fingerprint、action=open|close。恢复清除该渠道全部阻断与失败窗口，但不删除累计统计/Usage；操作前的迟到结果不能覆盖新状态

如果候选 route 全部被 health 阻断且没有开始请求，返回 `503 model_channels_unavailable` 和 `Retry-After`。如果至少开始过一次上游请求并且所有可用 route 都失败，保留 `fallback_exhausted` 语义。reload 会先完整校验新文档，再同步更新 runtime snapshot、health settings 与 topology；旧请求的过期 lease 不能修改新 topology。策略变量使用 `PROXY_HEALTH_*`、`PROXY_CHANNEL_MAX_ATTEMPTS`、`PROXY_CHANNEL_RETRY_DELAY_MS`、`PROXY_CACHE_KEY_POOL_SIZE`；旧 channel/model-channel 阈值、冷却与半开变量已停用并会警告。已输出的 SSE 不透明重放；有有效输出但缺失 usage 不触发重试，Usage 缺失字段保留 NULL。

请使用 ai-sdk 进行开发，ai-sdk 是由 Vercel 官方推出的套装，具体流程请查阅项目依赖和官方文档。

代理层支持 OpenAI 风格 prompt caching 的 best effort 请求侧增强：

- 客户端请求体已经带有 `prompt_cache_retention` 或 `prompt_cache_key` 时，直接保留并向上游透传
- 客户端没有带而环境变量配置了默认值时，可使用 `PROXY_PROMPT_CACHE_RETENTION=in_memory|24h` 与 `PROXY_PROMPT_CACHE_KEY=<stable-key>` 注入
- 这些只是请求侧 hint，是否命中 cache、是否支持 extended retention 取决于上游 provider
- `prompt_cache_key` 必须稳定，不要把随机值、时间戳、request id 放进去

channel credentials 只存在于 `fallback.json`。`fallback.json` 和 `.bak` 备份属于敏感文件，写入后必须保持 `0600` 权限。

## 实例角色与部署红线

| 端口 | 实例 | 角色 | 运行方式 |
| --- | --- | --- | --- |
| 11240 | proxy-11240 | **生产** | systemd `responses-api-compat-proxy@proxy-11240` |
| 11241 | proxy-11241 | **本地测试** | tmux `proxy-11241`（tsx 源码直跑） |
| 11242 | proxy-11242 | **生产** | systemd `responses-api-compat-proxy@proxy-11242` |
| 11243 | proxy-11243 | **生产**（2026-08-19 从 11240 复制） | systemd `responses-api-compat-proxy@proxy-11243` |

**硬性规则：**

1. **11240、11242 与 11243 是生产服务，未经用户明确批准，禁止重启、停止、reload 或以任何方式动它们的进程与配置**（包括 `systemctl --user restart/stop`、写 `instances/proxy-11240/`、`instances/proxy-11242/`、`instances/proxy-11243/` 下的文件、调用 `/admin/config/reload`）
2. 所有新功能、代码变更、配置实验一律先在 **11241** 部署验证（tmux `proxy-11241`，tsx 热加载，重启无成本）
3. 生产实例的升级发布是**用户驱动的动作**：等用户确认 11241 验证通过并明确说"更新生产"后，才执行 build + 重启
4. 改动 `src/` 后 `npm run build` 只更新 `dist/`，不会自动影响运行中的服务——systemd 实例下次重启才会吃到新代码；tmux 里的 11241 需手动重启才生效。保持这个认知来规划验证节奏
5. **重启即生效就绪（restart-ready）**：每次功能在 11241 验证通过后，必须保证用户直接 `systemctl --user restart` 就能拿到全部更新（run.sh 重启时自动 `npm run build`）。因此工作区必须始终 restart-safe：tsc 干净、全部 check 绿、配置合法——绝不能在 build 会失败或 check 未全绿的状态下报告"验证通过"（详见 docs/project_memory/deployment-redline.md）

<!-- memory-system:start -->
## Project Memory System

This project uses a three-layer memory system (Magic Context + StrictDoc + claude-mem).

- **At session start**: run the `load-mem` skill before doing substantial work.
- **At milestones and before ending work**: run the `save-mem` skill.

### Memory intent

- Use StrictDoc, Magic Context, and claude-mem together; their knowledge may intentionally overlap. Let the Agent choose useful storage, retrieval depth, and timing rather than enforcing a one-store-per-fact pipeline.
- Among project records, **current StrictDoc norms are the source of truth** when memories disagree. The usual `docs/` layout separates `project_memory/` (decisions and journal) from `handbook/` (reference documents). `Active` decisions describe current rules; proposals, retired decisions, journal entries, and historical reports should remain distinguishable from them.
- **当前规范可以维护，但历史节点不直接抹掉。** 用户明确改变决定，或已确定的变化足够清晰时，可新增 successor、标记旧节点 `Superseded` 并简短告知；不因猜测、临时尝试或每次任务就改规范。普通说明文档和非规范记忆可更灵活整理。
- Validate `.sdoc` or StrictDoc config changes with `strictdoc export .` from the docs root. Use the available executable or project environment; resolve export failures before treating the update as complete.

### Technical writing (always applies)

- Before writing or revising any human-facing project technical text, load `readable-docs`: README, specs, design notes, plans, reports, runbooks, changelogs, and memory. This applies regardless of directory or workflow, not just `docs/`, `save-mem`, or `migrate-mem`.
- Write for scanning: Chinese by default, phrases, lists, compact comparison tables; omit subjects or objects only when clear. Preserve facts, conditions, uncertainty, required structure, and instruction strength. Short connected prose is welcome when it explains better; no invented facts or personality.

### Context window (always applies)

- Big output never enters context: bulk commands / multi-file analysis -> `ctxm_batch_execute`, one-off computation -> `ctxm_execute`, reading a file -> `ctxm_execute_file`.
- Web: never the host built-ins (WebSearch, WebFetch, web_search) — they are weaker or unconfigured here. Use the mcphub-web MCP tools: `tavily_search`/`tavily_extract` for facts/news, `firecrawl_search` for ranked results, `firecrawl_scrape` for a known page (exact names carry a host prefix, e.g. `tavily-mcp-tavily_search`). More sit behind the `mcp` gateway (firecrawl crawl/map/research, context7 docs): `mcp({search})` → describe → connect. `ctxm_fetch_and_index` only for a page you will re-query (how-to lives in the `context-mode` skill).
- Magic Context supports recall and durable storage: `ctx_search` can recover earlier decisions before asking the user, `ctx_memory` can preserve useful knowledge, and `ctx_note` can hold reminders. Use alongside StrictDoc and claude-mem, with useful overlap.
- Native `Read`/`Grep`/`Glob` stay right when you need the exact bytes or will edit the file — never route those through `ctxm_*`.

### Steering the agent (always applies)

- Steer with prompts, skills and tool descriptions — never with hard blocks. Guidance keeps judgement and variety; deny rules are a last resort for damage, not for preference.
- Adding an MCP server: keep tool names short (pi-mcp-adapter `toolPrefix: "none"`) and descriptions rich — the description is all the model reads before choosing.
- When a behaviour goes wrong, fix the system that produced it (a line here, a skill, or a fork patch), not just the config of the machine you noticed it on.

### Code taste (always applies when writing or changing code)

- Running code without errors IS the verification — no tests, no TDD, no verification scripts unless explicitly asked.
- No over-encapsulation, no defensive programming, no speculative abstraction. Minimum code that works.
- Report results in one line; no summary essays.
- Script/repo comments carry usage and necessary function notes only. The reasoning behind a change — alternatives weighed, measurements, upstream drift, failure modes — is development process and belongs in the local memory system (the gitignored StrictDoc tree and session memory), never in the repository files.

**Placement**: paste this whole block at the *tail* of a project's own `AGENTS.md` — the project's own content stays on top, this block is the accelerator we append. The one-click setup scripts offer to write it there (opt-in, default no); paste it by hand otherwise.

(Practical guidance lives in `load-mem`, `save-mem`, `migrate-mem`, and `readable-docs` — keep this block short.)
<!-- memory-system:end -->

---

## 部署架构（2026-09-27 起）

生产实例运行在独立服务器上，本地 checkout 只做开发与测试。完整的内部部署手册（服务器、单元名、端口清单、部署与回滚命令）在本地 `DEPLOY.local.md`（已 gitignore，严禁提交）。

核心规则：

- `instances/proxy-*/` 是运行时配置，以生产服务器侧为唯一权威；部署 rsync 必须排除 `instances/`，`--delete` 不得波及
- 部署流程：rsync 代码（排除 `instances/`、`node_modules/` 与本地工作区目录）→ lockfile 变更时在生产目录 `npm ci` → `systemctl restart` 受影响实例 → 逐端口探活 `/v1/models`
- 新增实例：在生产机创建 `instances/<name>/` 并 enable 对应模板单元；本地测试一律用非生产端口，测完即停
- 回滚：`git revert` 后重新部署；实例配置不受部署影响
