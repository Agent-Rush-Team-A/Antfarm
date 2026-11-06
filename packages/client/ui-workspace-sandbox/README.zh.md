---
description: "通过 Harness 查询工作区沙箱并执行经过鉴权的管理操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace-sandbox

[English](README.md) | 中文

## 概述

工作区沙箱资源查询当前工作区，不会开启容器。修改操作使用经过鉴权的 Harness 管理接口，不能选择宿主路径或容器。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

配合 [Harness 沙箱 overlay](../../../apps/cli/config/examples/harness-sandbox.patch.yml) 启用此插件。部署前需准备独立 Runner 与规范工作区根目录。`pollIntervalMs` 是状态查询完成后的轮询间隔，默认为 2000 毫秒。

工作区菜单和对话输入栏操作打开同一面板，面向选定的工作区。面板显示当前状态，防止重复提交未完成操作，支持手动刷新，并在关闭沙箱前要求确认。关闭面板不会关闭沙箱。

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节</summary>

工作区资源地址为 `dsh-resource://workspacesandbox/<workspaceId>`。提供方在持有者之间共享一个轮询循环，最后一个持有者离开时停止。已提交的开启、关闭请求由插件持有，直到结束或连接断开。修改操作不会自动重试。

查询失败时保留最近观察到的状态并附带错误。连接更换时丢弃旧观察并重新查询；延迟返回的旧响应不能覆盖新连接的数据。错误报告使用稳定原因，不包含原始诊断。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Harness 沙箱管理](../../sandbox/harness-sandbox/README.zh.md) — 经过鉴权的生命周期操作。

<a id="model-experience"></a>
## 模型体验

无；浏览器沙箱管理不会添加模型工具、消息或 Session 事件。

#### KV Cache 影响

无；查询沙箱状态不改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 修改结果未知时保持可见。Harness 的关闭屏障需要部署维护；浏览器不能凭单次已关闭观察确认清理完成。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者背景</summary>

无。

</details>
