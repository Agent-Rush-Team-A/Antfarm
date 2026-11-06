---
description: "独立于全局设置权限的个人凭证表单。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-user-credentials

[English](README.md) | 中文

## 概述

从侧栏底部打开**我的凭证**，管理当前登录账号的凭证。启用本插件需要 Host 提供个人凭证 API；入口按 `userCredentials/list` 权限显示，不需要全局设置权限。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web bundle 提供默认禁用的 `ui-user-credentials` 配置项。在多用户部署中将它与 [Host 插件](../../api/user-credentials/README.zh.md)一起启用，测试 overlay 已同时配置。可以新增命名凭证、替换凭证值、检查存储可读性或确认删除。弹窗说明共享工作区不会共享凭证，保存检查也不会认证外部服务。

名称栏提示按服务配置填写凭证名称，例如 `Vultr API Key`。凭证值栏提示只填写服务商提供的 API Key 或令牌，不包含 `Bearer`、curl 命令或 JSON。输入时仍会显示填写说明。已配置的 Host 推理绑定使用当前账号的凭证；在对话中选择对应的服务与模型。

凭证值使用密码输入框。提交时先清空输入，再发送请求；响应不会重新填入原值。关闭、断线、权限撤销和切换账号都会销毁弹窗。表单和凭证列表不写入浏览器存储。请求失败时显示固定的本地化文案，不展示原始异常。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

插件挂载个人凭证 Remote 定义，通过 slot registry 注册 `sidebar.footer.action`，使用共享 Modal 组件显示弹窗。弹窗私有状态管理元数据、选中记录与请求生命周期；提交前，凭证值只保留在非受控输入框中。AbortSignal 取消弹窗所属请求，并阻止迟到响应更新已关闭界面。所有文案归属类型化的 `userCredentials` 字典。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [个人凭证 Host](../../api/user-credentials/README.zh.md) — 归属检查与加密持久化。
- [侧栏插槽](../ui-sidebar/README.zh.md) — 底部入口注册。

<a id="model-experience"></a>
## 模型体验

无，因为本浏览器插件不贡献模型工具、消息或 Session 事件。

#### KV Cache 影响

无，打开表单不会改变模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 页面不会显示或导出已保存的凭证值，也不会验证外部服务授权。推理需要显式的 [Host 绑定](../../api/user-credentials/README.zh.md)。进入页面或操作后刷新列表，其他标签页的变更需要点击刷新。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护上下文</summary>

无。

</details>
