---
description: "通过 Harness 查询工作区沙箱并执行经过鉴权的管理操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace-sandbox

[English](README.md) | 中文

## 概述

在浏览器查看工作区沙箱状态，并开启或关闭沙箱。此插件需配合 Harness 管理接口以及本地 Runner 或 Vultr 后端使用。面板打开时默认每两秒轮询状态；只有用户主动操作才会开启或关闭沙箱。

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

Web bundle 默认禁用此插件。通过 [Runner overlay](../../../apps/cli/config/examples/harness-sandbox.patch.yml) 或 [Vultr overlay](../../../apps/cli/config/examples/harness-vultr.patch.yml) 启用，并满足对应后端的部署前提和规范工作区根目录要求。`pollIntervalMs` 是状态查询完成后的轮询间隔，默认为 2000 毫秒。

工作区菜单和对话输入栏操作打开同一面板，面向选定的工作区。面板显示当前状态，防止重复提交未完成操作，支持手动刷新，并在关闭沙箱前要求确认。关闭面板不会关闭沙箱。

单会话模式展示实时沙箱状态和自动开启、回收说明，隐藏手动开启、关闭与清理。多会话模式在模式操作状态就绪时保留这些按钮。模型在发送请求前再次检查最新模式，避免旧面板发出已被禁止的操作。

容量满时提示用户关闭一个沙箱或稍后重试。操作结果未知时禁用新的修改操作；状态查询失败时标明最近观察到的状态已过期。工作区权限撤销时移除面板和菜单入口，连接更换或插件卸载后不再展示延迟返回的操作提示。

云端启动失败提示刷新状态后重试；未能安全关闭时提示联系管理员，确认后再重新开启。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `pollIntervalMs` | `2000` | 状态查询完成后的间隔，单位为毫秒。 |

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节</summary>

工作区资源地址为 `dsh-resource://workspacesandbox/<workspaceId>`。提供方在持有者之间共享一个轮询循环，最后一个持有者离开时停止。已提交的开启、关闭请求由插件持有，直到结束或连接断开。修改操作不会自动重试。

查询失败时保留最近观察到的状态并附带错误。连接更换时丢弃旧观察并重新查询；延迟返回的旧响应不能覆盖新连接的数据。错误报告使用稳定原因，不包含原始诊断。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [网页沙箱指南](../../../docs/user/guide/workspace-sandboxes.zh.md) — 部署与浏览器操作。
- [Harness 沙箱管理](../../sandbox/harness-sandbox/README.zh.md) — 经过鉴权的生命周期操作。
- [Runner 部署](../../../team-docs/SANDBOX-RUNNER.md) — 独立 Docker 服务。

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

浏览器验收由 `apps/web/tests/workspace-sandbox.e2e.ts` 负责。设置 `DSH_SANDBOX_UI_DOCKER_SOCKET` 和 `DSH_SANDBOX_UI_DOCKER_IMAGE`（预加载且固定摘要的 Runner 镜像），可让同一场景连接真实独立 Runner。未提供这些部署参数时，场景使用可控 Runner 暂停进度并注入状态查询失败。

</details>
