---
kind: upgrade-guide
description: "可选工作区沙箱 overlay 现会准备消息，并在修改结果不明后继续阻止重开。"
---

# 沙箱消息接纳与关闭

[English](guide.md) | 中文

## 变更

可选 `harness-sandbox.patch.yml` overlay 现会在接纳已认证用户的工作区消息前准备沙箱，因此 Runner 故障可能拒绝 prompt。关闭会取消该工作区全部会话中活跃和排队的输入；普通会话停止仍保留排队输入。

overlay 将 standard Agent preset 替换为前台 Runner Bash 及其 persona，禁用其他内置 preset 和宿主、间接工具，并选择原生执行。多用户默认拒绝策略保留，例外绑定确切 Runner 定义、已接纳步骤及原消息许可。Working Directory 显示 `/workspace`；省略宿主路径变更通知、宿主文件策略上下文与开发、文件交付引导。后端目录记录保留实际路径。

关闭期间新开启立即失败。以前修改响应丢失后可以通过后续查询观察结果；现在 PUT 或 DELETE 结果不明时，本地状态保持 `closing`，包括插件重载和再次 DELETE 之后。现有协议无法证明旧请求已经收束。文件和会话格式不变。

## 迁移

1. 保留[工作区沙箱指南](../../../user/guide/workspace-sandboxes.zh.md)中的部署变量。overlay 现还加载 `@deepseek-ai/dsh-harness-sandbox/conversation`；需要自动准备的自定义组合必须在原生 Session Controller 和 Agents 之外加载此入口。
2. 将 prompt 准备失败当作提交被拒绝。重试使用相同 `requestId`；已取消但未接纳的编号在 Harness 进程存续期间保持取消。有意发起新工作时使用新编号。
3. 明确处理 `closing` 和关闭失败。确定拒绝后通过 `workspaceSandbox/close` 重试，不排队开启。`outcomeUnknown: true` 时保持工作区阻止状态，通过部署维护确认收束；单次查询或重启 Harness 都不能证明这一点。见[限制](../../../../packages/sandbox/harness-sandbox/README.zh.md#known-limitations-and-deferred-work)。
4. 验证所属消息会准备沙箱，关闭会清除活跃及排队输入。确认关闭后新消息可以开启新代；旧的已接纳编号不能重开或再次入队。
5. 保留 overlay 的 preset 与原生执行器设置、`working-directory.config.modelDirectory: /workspace` 、`sandbox-policy.config.modelContext: false` 和 `spill-policy.disabled: true`。确认实际模型请求只展示 Runner Bash，且不含宿主工作区路径；管理端仍须定位已保存的宿主工作区。自定义 preset 必须挂载隔离 Bash 入口，不能换成同名宿主工具。大结果应保留 Runner 输出尾部，不提供宿主溢出文件恢复指令。
