---
description: "授权原生工作区沙箱操作，并调用独立的本机 Runner。"
kind: "package-reference"
---

# @deepseek-ai/dsh-harness-sandbox

[English](README.md) | 中文

## 概述

核验已登录原生用户的工作区归属和持久目录记录后，开启、查询和关闭工作区沙箱。独立 Runner 负责容器状态和容量。HTTP 请求有有限等待和结果校验；结果无法确认的修改不会自动重发或执行补偿操作。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

使用可选的 [Web overlay](../../../apps/cli/config/examples/harness-sandbox.patch.yml)，并按照[部署指南](../../../docs/user/guide/workspace-sandboxes.zh.md)配置。它启用已有多用户登录和本服务，保留多用户对宿主工具的限制。Web 进程不能访问 Docker；Runner 独立运行。

```yaml
- id: workspace-sandbox
  name: '@deepseek-ai/dsh-harness-sandbox'
  config:
    socketPath: /run/agentrush-sandbox/runner.sock
    workspaceRoot: /srv/agentrush/workspaces
```

组合还必须加载原生 multiuser、Workspace Registry、Typert 和 Remote Access 服务。`workspaceRoot` 必须与多用户分配流程和 Runner 使用的规范根目录一致。新多用户目录使用 0700 权限；部署时让容器非 root UID 与 Harness 分配目录的用户一致，并准备 Runner 的目录遍历和挂载权限。开启沙箱不会修改目录权限或迁移文件。

| 设置 | 值 |
| --- | --- |
| `socketPath` | 必填绝对本机 Runner socket；不能由浏览器提供。 |
| `workspaceRoot` | 必填绝对持久根目录；没有默认值。 |
| `queryTimeoutMs` | GET 总期限，默认 15,000 ms。 |
| `mutationTimeoutMs` | PUT/DELETE 总期限，默认 120,000 ms。 |
| `maxResponseBytes` | 完整响应体最大字节数，默认 8192。 |

三个 Typert 方法为 `workspaceSandbox/open`、`workspaceSandbox/status` 和 `workspaceSandbox/close`，由 Connection 的 POST `/api/<method>` 承载。唯一业务参数是 `request: { workspaceId }`。沿用现有登录 cookie 和 Connection Host/Origin 检查。额外字段、owner 身份和没有用户调用上下文的访问均被拒绝。结果仅含 `{ workspaceId, state }`；管理结果不暴露容器编号或部署路径。

每次调用检查原生归属及同一 Workspace Registry 编号。开启还要求登记路径是可信根目录下已存在、无符号链接的直接子目录，并在联系 Runner 前再次检查归属。登记目录丢失或移动后仍可查询和关闭。没有第二套编号映射、用户库、容器缓存、操作队列或宿主执行回退。不存在的工作区及跨用户访问沿用原生 `remote-access/denied` 策略；无效业务输入使用 `gateway/bad-request`。

`status` 观察 `closed`、`starting`、`running`、`closing` 或 `cleanup_required`，不会修改沙箱。`close` 仅在 Runner 确认 `closed` 后成功，结束该代容器中的全部命令，保留工作区登记、文件和会话。之后有权限的开启操作可以创建新代容器。

移除原生工作区登记前需要 Runner 的本次查询明确返回 `closed`。已有开启请求或其他状态以 `workspace/sandbox-active` 和 `{ workspaceId, state }` 拒绝删除，需先关闭沙箱。查询失败保留登记和归属。删除保护持续到注册表写入或回滚完成，期间拒绝该工作区的新开启，其他工作区仍可操作。保护由注册表拥有，跨越管理器卸载和重载：每次解析当前活跃服务，管理离线时以 `sandbox/failed` 的 `runner_unavailable` 原因拒绝删除原生工作区。插件卸载等待已接纳的删除保护完成；重载替换具名保护，不保留旧服务。

Runner 失败使用 `sandbox/failed`，详情为 `{ reason, outcomeUnknown }`。稳定原因区分 `sandbox_capacity`、`sandbox_not_ready`、`sandbox_closing`、`sandbox_cleanup_required`、`sandbox_workspace_conflict`、`sandbox_name_conflict`、`sandbox_outcome_unknown`、`invalid_workspace_directory`、`docker_unavailable`、`runner_unavailable` 和 `runner_outcome_unknown`。修改结果不明时需要重新查询状态；查询失败不会补造 `closed`。消息不含 Runner 原始诊断、路径或堆栈。

<a id="integration-handoff"></a>
### 接入交接

| 使用方 | 可用入口 | 后续接入 |
| --- | --- | --- |
| #7：自动开启和 Bash 转发 | `ctx.workspaceSandbox.openForUser(userId, workspaceId)` 返回校验后的 `running` 和完整 `containerId`；`statusForUser`、`closeForUser` 同样重新核验原生归属。 | 捕获已认证的发起用户；把确认后的容器代次传给执行接口，增加请求取消和迟到调用拒绝。 |
| #8：空闲回收 | 针对持久记录中的所有者和工作区调用 `statusForUser`、`closeForUser`。 | 增加活动记录和 30 分钟空闲判断。 |
| #9：网页控件 | 三个 Typert 方法、五种状态以及类型化的 `sandbox/failed` 原因。 | 增加按钮和展示；结果不明时先观察，再进行新的修改。 |

内部显式用户方法只接收可信后端代码取得的身份，不会在缺失调用上下文时推断 owner。子服务 `sandboxRunnerClient` 仅负责通信，不能作为用户管理 API 暴露。服务卸载会取消本机等待并移除方法，不发送 DELETE；断线和超时都不代表容器已移除。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[管理服务](src/index.ts)负责授权、目录校验和浏览器安全结果投影。[通信子服务](src/transport.ts)拥有 [HTTP 客户端](src/runner-client.ts)，将请求取消绑定到 Cordis 卸载。每个请求单独连接固定 socket。[通信设置](src/config.ts)提供共享期限默认值；[公共类型](src/types.ts)声明脱敏结果和错误。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Runner 参考](../sandbox-runner/README.zh.md) — 生命周期和持久目录。
- [多用户参考](../../api/multiuser/README.zh.md) — 账号和工作区归属。
- [沙箱子系统](../../../docs/subsystems/sandbox.zh.md) — 生成的服务参考。

<a id="model-experience"></a>
## 模型体验

无；管理服务不贡献工具、提示词或模型可见上下文。

#### KV Cache 影响

无；生命周期操作在模型请求组装之外执行。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **部署** — Runner 需要 Linux Unix socket 和单独配置的非 root 文件系统身份。Windows 命名管道仅用于通信测试。
- **接入** — 自动开启、Bash 转发、空闲回收和网页控件仍是独立任务。在执行隔离接入之前，可选多用户 profile 继续拒绝模型工具。
- **证据** — 本机 HTTP 和 profile 测试使用可控 Runner，不能证明真实 Docker 或 Vultr 验收；后者需要单独部署检查。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
