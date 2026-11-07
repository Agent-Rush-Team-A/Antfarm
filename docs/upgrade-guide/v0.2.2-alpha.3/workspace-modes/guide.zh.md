---
kind: upgrade-guide
description: 工作区模式记录需要全新的工作区域，并引入永久会话锁定。
---

# 工作区模式

[English](guide.md) | 中文

## 变更

工作区域从版本 2 升至版本 3，新增必需的模式、版本、首个会话身份和可恢复操作字段。此部署无法打开较早的工作区域；会话日志各代格式保持不变。首个普通会话永久锁定工作区模式。单会话模式拒绝第二个会话、分支和归档请求。

Workspace Remote 投影现在要求 `modeConfig`，Client Workspace 服务要求 `getMode` 和 `setMode`。

## 迁移

1. 为此部署使用全新的应用数据目录；如需旧数据，单独保留原目录。不要覆盖已有工作区域或会话日志。
2. 当部署需要 `multi-vm` 以外的默认模式时，在配置覆盖文件中设置工作区注册服务的 `defaultMode`。
3. 运行时提供方从 `@deepseek-ai/dsh-workspace/types` 导入 `WorkspaceModeRuntime` 和 `IWorkspaceModes`，在切换模式前通过 `ctx.workspaceRegistry.modes.registerRuntime` 注册。
4. 更新外部 Workspace mock 和协议消费者，提供 `WorkspaceView.modeConfig`，实现 `IWorkspaces.getMode` 与 `IWorkspaces.setMode`，并保留错误的 `WorkspaceModeCommandError.rpcError`。
5. 验证新注册的工作区报告版本 0 和未锁定模式配置。
