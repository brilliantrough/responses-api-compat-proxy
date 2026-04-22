# 发布检查清单

[English](../publishing-checklist.md) | [中文](./publishing-checklist.md)

在给仓库添加公开 `origin` 或 push 到公开远端之前，先逐项检查下面这些内容。

## Secret 与本地运行数据

- [ ] 没有真实 `.env` 被 git 跟踪
- [ ] 没有 `instances/proxy-*` 被 git 跟踪
- [ ] `git diff` 中没有真实 API key、token 或 provider secret
- [ ] 仓库中被跟踪的 JSON 示例只包含占位 URL 与占位环境变量名

## 本地环境泄露

- [ ] 文档或模板中没有本地 home 目录绝对路径
- [ ] 没有私有 hostname、服务器名或本地 IP 被带进公开文件
- [ ] 没有本地私有 systemd unit 名或部署细节，除非它们是明确的通用示例
- [ ] 没有把内部 progress note、memory、operator-only 文档带进公开 diff

## 运行时产物

- [ ] `logs/`、`captures/`、`sse-failures/` 等调试输出目录没有被跟踪
- [ ] example 文件中的 debug 开关仍保持关闭
- [ ] 没有原始请求或响应 dump 被放进仓库

## 公开文档质量

- [ ] `README.md` 能提供最短上手路径
- [ ] `docs/zh/quickstart.md` 能从干净副本跑通
- [ ] `docs/zh/examples.md` 与当前 example 文件一致
- [ ] `docs/zh/configuration.md` 清楚区分 required/common/advanced/debug
- [ ] `docs/zh/operations.md` 明确提醒了 localhost-only admin 与敏感 capture 风险

## 仓库元信息

- [ ] 已经选择并添加 License
- [ ] `origin` 指向你真正想公开的远端
- [ ] `git status --short` 只显示你有意提交的改动
- [ ] `git diff --stat` 看起来是公开安全且符合预期的

## 推荐最后执行的命令

```bash
git status --short
git diff --stat
git diff
```

如果 diff 中仍然有真实凭据、本地路径或 operator-only 内容，请先清理掉，再 push。
