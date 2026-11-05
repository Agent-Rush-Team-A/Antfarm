---
kind: upgrade-guide
description: "Runner Exec 要求 Python 监管镜像，并将命令期限与清理等待分开。"
---

# Runner Exec 要求监管镜像

[English](guide.md) | 中文

## 变更

工作区 Runner Exec 启动固定的 Python 监管程序，不再直接启动 Bash。只有 Bash 和 sleep 的现有镜像无法通过 Runner 执行命令。命令超时后会有独立的清理及确认等待。确认单次清理后容器继续可用；结果无法确认则删除整代，并中断其余命令。执行错误包含清理详情，sandbox_cleanup_required 从 HTTP 409 改为 503。成功响应字段和每代执行 ID 规则保持不变。

## 迁移

1. 构建 [Runner 镜像](../../../../packages/sandbox/sandbox-runner/image/Dockerfile)，使用 `packages/sandbox/sandbox-runner` 作为 Docker 上下文。镜像提供 `/usr/local/bin/python3`、`/bin/bash`、`/usr/bin/sleep` 和由 root 持有的只读监管程序。将构建结果预加载到 Runner 的 Engine。
2. 将 Runner Cordis 配置中的 `image`，或 [profile 模板](../../../../team-docs/sandbox-runner-profile/cordis.patch.yml)使用的 `DSH_RUNNER_IMAGE`，设为构建结果的仓库摘要。保留既有的非 root UID/GID 和容器限制。关闭旧工作区容器后，再用新镜像重新开启。
3. 按[包参考](../../../../packages/sandbox/sandbox-runner/README.zh.md#use-this-package)检查 `cleanupTimeoutMs` 和 `termGraceMs`。模板还接受 `DSH_RUNNER_CLEANUP_TIMEOUT_MS` 和 `DSH_RUNNER_TERM_GRACE_MS`；TERM 宽限必须小于清理预算。调用方请求超时应允许命令期限外的清理用时。
4. 通过 Runner Exec API 验证正常及非零 Bash 退出、两路输出和工作目录请求。execution_timeout 只表示已确认清理或未发送 Start；清理不明使用 execution_outcome_unknown。读取执行错误中的身份、reason、cleanup 和可选 Bash 状态。确认删除后可重开，cleanup_required 用 DELETE 重试。更新将此错误视为 HTTP 409 或要求响应严格只有 error 的客户端；其他准备/生命周期失败仍仅返回 error。
5. 用 `POST /v1/workspaces/:workspaceId/sandbox/exec/cancel` 取消，只传 executionId 和 expectedContainerId。验证在途返回 202/requested，结算后返回 200/settled。应读取原 exec 结果或原样重试，以确认真实原因和清理状态；接纳取消不等于完成。[Runner 参考](../../../../packages/sandbox/sandbox-runner/README.zh.md#use-this-package)定义具体响应。
