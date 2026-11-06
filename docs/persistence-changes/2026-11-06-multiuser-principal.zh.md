---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-multiuser-principal

[English](2026-11-06-multiuser-principal.md) | 中文

## 概述

在排队输入、开发者消息、标题请求和用户消息的用户 RPC 消息归属中，增加已登录账号和匿名主体两种类型。Session 格式保持 V4。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-multiuser-principal
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "b49d167cab355d5faf19669680949a7d9d3907b35d6806fa6651070102aaab0b"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "0058003839d781cd15fc9aafaf3f68229475a88d05b7ca4c9d6fcd817f3e11b7"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "9119ff885a4ca0831555d8f68a789dc7150de08d899872e25225a040bc2badd3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "fa2b07fdc2163ef2432958e63f6e4c28a1bd13f2945478ab4e679c228177d476"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

所有已有主体类型继续有效，所有者提交的提示仍省略 principal，因此新读取器保留历史归属及其行为。旧 V4 读取器保留新增的主体 JSON：原生来源准入检查已有的 user 来源种类，不解释主体分支；读取持久化归属不会创建实时 Peer，也不会授予权限。账号主体只记录 kind 和 userId，不包含凭据。匿名分支用于连接准入的类型声明；未登录的业务 RPC 在分派前即被拒绝。实时权限仍根据已准入的 Peer 和当前工作区归属判定，不依赖持久化消息归属。无需迁移或提高写入版本。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts --maxWorkers=1：54 个测试通过。未修改的 V4 读取器在不安装账号服务时，于读写模式及明文、zstd 压缩模式下保留历史所有者、账号和匿名归属，存储字节保持不变。DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/multiuser.e2e.ts：通过；已登录提示记录账号主体，未登录请求和跨账号访问被拒绝，退出使旧 Cookie 失效。

<a id="dev-note"></a>
## 开发备注

无。
