---
description: "多用户 Web 部署的账号登录、浏览器登录会话撤销、工作区归属与按用户 Remote 访问策略。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-multiuser

[English](README.md) | 中文

## 概述

`MultiuserService` 验证浏览器请求，持久化账号与登录会话，为每个工作区指定唯一所有者，并注册 `user` Remote 访问策略。它向 Connection 安装准入 provider，使每个 RPC、流、首页渲染和升级都代表登录对应的 Peer，而不是 owner。工作区与 Session 控制器复用该身份完成各自的资源检查和列表过滤。

## 目录

- [行为](#behavior)
- [路由](#routes)
- [Remote 访问策略](#remote-access-policy)
- [配置](#configuration)
- [工作区创建](#workspace-creation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="behavior"></a>
## 行为

服务打开 `multiuser` 存储域（账号、登录会话、工作区所有者），在开始服务请求前完成加载，并把自身安装为 Connection 的准入 provider。浏览器 Cookie 只保存随机 32 字节 token，存储中仅保留其 SHA-256 摘要。密码使用带独立 salt 的 scrypt。成功请求携带 principal 为 `{ kind: 'user', userId }` 的 Peer；缺失、过期、已撤销或账号已禁用的登录会在任何业务方法执行前以 401 拒绝。

服务注册 `user` Remote 访问策略。global role 只开放列表、follow、受控工作区创建和模型目录调用。每个自有工作区贡献一个 workspace grant，工作区名下每个 Session 贡献一个 session grant。访问不属于该账号的资源时，方法在派发前被拒绝；工作区和 Session 读取沿用现有控制器中的 `remoteAccess.allows()` 过滤；`workspace/follow` 同时允许读取自有工作区及其 Session 成员关系；`session/create` 允许复用自有工作区内的空 Session。

工具执行默认拒绝，包括 preset 的贡献。可信隔离实现可在自己的 fiber 内调用 `registerIsolatedTool(definition, authorize)`。例外要求当前步骤 `toolSet` 中仍有效的确切定义、根调用及提供方的同步授权；仅有工具名不授予权限。卸载会删除例外，其他 Tools guard 仍可拒绝。[Runner Bash 实现](../../sandbox/harness-sandbox/README.zh.md#runner-bash)还会在工具体内检查原消息归属和取消状态。

<a id="routes"></a>
## 路由

| 路由 | 方法 | 行为 |
| --- | --- | --- |
| `/auth/login` | POST | 有界 JSON 登录，校验来源并限流；设置 HttpOnly Cookie。 |
| `/auth/guest` | POST | 启用时创建独立游客登录，或复用当前有效游客登录。 |
| `/auth/logout` | POST | 撤销当前登录、销毁其 Peer、清除 Cookie；幂等。 |
| `/auth/me` | GET | 返回当前账号，未登录返回 401。 |
| `/auth/client.js` | GET | 登录页与账号徽标辅助脚本。 |
| `/auth/sign-in` | GET | 公开登录页包含匿名界面启动配置，不加载应用模块或私有账号状态。 |

未登录的首页请求重定向到相对于首页 URL 的公开 `auth/sign-in` 页面。脚本地址、登录/退出请求和账号刷新均保留部署路径前缀；浏览器从账号脚本 URL 推导应用根目录。已登录页面显示账号和退出入口。登录状态变化会刷新其他标签页，切换账号会在启动应用前清除浏览器持久化的应用视图。配置浏览器本地语言偏好后，登录页和账号控件提供英文与中文，切换语言保留表单值，并跟随应用文档语言。公开登录页复用应用的 Host 主题启动配置，包括系统深色模式。退出失败时显示可重试的错误。活动 Peer 在登录到期时结束；认证响应和个性化首页均不允许缓存。

<a id="remote-access-policy"></a>
## Remote 访问策略

`user` 策略默认拒绝，只对账号当前拥有的资源授予 action。

| 范围 | 允许的 action | 说明 |
| --- | --- | --- |
| global | `workspace/create`、`workspace/follow`、`session/list`、`session/search`、`session/control`、`session/modelCatalog`、`session/canOpenWorkspacePath` | 列表与 follow 方法经 `ctx.remoteAccess.allows()` 逐项过滤。 |
| workspace | `session/create`、`workspace/follow`、`workspace/rename`、`workspace/delete`、`workspace/insertBefore`、`workspace/insertSessionBefore`、`workspaceUpload/limits`、`workspaceUpload/upload`, `workspaceArtifacts/list`, `workspaceArtifacts/download` | condition 在判定时重新检查归属行。 |
| session | `workspace/follow`、`session/create`、`session/list`、`session/search`、`session/control`、`session/page`、`session/events`、`session/observeEvent`、`session/observeProjections`、`session/state`、`session/observeState`、`session/wait`、`session/follow`、`session/projections`、`session/prompt`、`session/updateQueue`、`session/cancel`、`session/rename`、`session/fork`、`session/selectModel`、`workspace/insertSessionBefore`、`workspace/archiveSession`、`workspace/unarchiveSession`、`workspace/pinSession`、`workspace/unpinSession`，以及五个 `event:api-session/*` 通知 | Session 成员关系来自权威工作区记录。 |

已认证账号也可调用个人 `userCredentials` API；[个人凭证插件](../user-credentials/README.zh.md)独立于工作区权限检查记录归属。`workspaceRoot` 向 Host 插件提供分配根目录，用于确保私有文件不在挂载目录内。

其余入口均在派发前拒绝，包括 `workspace/initializeDefault`、仅带 cwd 的 `session/create`、模型默认值写入、附件读取、文件服务、终端、后台任务、设置、全局凭证以及未显式提供资源作用域授权的精确 Fetch 路由。[工作区上传](../workspace-upload/README.zh.md)在上限读取和原始上传路由中均检查工作区归属权限。[工作区文件](../workspace-artifacts/README.zh.md)会检查列表访问的工作区归属，并在二进制下载过程中持续复查。非 global 资源被拒绝时返回 `remote-access/denied` 与 `reason: "not-found"`，不泄露其他账号的资源身份。

<a id="configuration"></a>
## 配置

```yaml
- id: multiuser
  name: '@deepseek-ai/dsh-api-multiuser'
  config:
    workspaceRoot: /absolute/private/workspaces
```

登录尝试（包括并发尝试）在密码计算前占用按地址计数的限额。登录和归属记录在加载时拒绝格式错误的时间戳。

`workspaceRoot` 必填且必须是绝对路径。`loginMaxAgeDays`、`loginAttemptLimit`、`loginAttemptWindowMs`、`sessionSweepIntervalMs` 是经过校验的部署值。`apps/web/tests/multiuser.overlay.yml` 是测试组合；正式部署 overlay 还必须把 Connection 的 `multiuser` 设为 `true`，并在沙箱隔离完成前限制宿主机执行工具。

先停止实例，再初始化账号，之后才可暴露实例。仓库维护命令在 JSON 存储根下创建一个账号；密码来自隐藏 TTY 输入或 `DSH_MULTIUSER_PASSWORD`，只保存 scrypt 摘要，并拒绝已存在的名称：

```sh
pnpm exec tsx scripts/multiuser-provision.ts --storage-root "$DSH_HOME/storages" --username alice
```

进程内等价步骤是 `MultiuserService.provisionUser(username, password)`。已有用户不会被覆盖，启动时也不会重置密码。禁用账号会写入 `disabledAt` 并撤销它持有的全部登录。

通过 `guestAccess: true` 启用游客访问。`POST /auth/guest` 接收 `{}`，创建独立游客账号并签发 HttpOnly 登录 Cookie，无需向浏览器提供密码；已认证游客复用当前身份与过期时间。新游客账号共用按地址计数的登录限额。`guestAccountLimit` 默认限制 100 个未禁用账号，`guestLoginMaxAgeMinutes` 默认 120。容量耗尽返回 `503` 与 `guest-capacity`；管理员可提高配置上限，或通过 `MultiuserService.disableUser()` 禁用不再使用的游客来释放名额，文件和归属不会删除或转移。退出或过期本身不释放名额。每位游客只能访问自己的工作区与会话；游客角色不提供个人密钥管理与工作区删除权限。

<a id="workspace-creation"></a>

## 工作区创建

普通用户的 `workspace/create` 只携带可选 `title`；服务在 `workspaceRoot` 下分配不可预测目录，登记工作区，再提交归属行。归属提交失败会撤销登记并移除新建的空目录。没有归属行的工作区对所有用户不可见。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只验证浏览器请求、维护工作区归属行并注册 Remote 访问策略，不新增 prompt、tool 或 session event。

#### KV Cache effect

无直接影响；登录与归属变化不会改变模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 普通用户仍不能访问旧版文件、附件、导出、终端、设置和精确 Fetch 路由。显式挂载的工作区上传服务实现自己的归属检查。
- 普通用户不能修改全局设置或默认模型选择。
- 账号认证不提供进程隔离。只有登记的隔离实现能获得工具执行例外；普通宿主工具仍被拒绝。
- 自助注册、密码找回、OAuth/OIDC、共享和用户 API key 不在本任务范围。
- 浏览器验收使用 `apps/web/tests/multiuser.e2e.ts` 中的真实 Web Loader 组合；后端测试覆盖登录生命周期、持久化归属和派发前拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

登录状态在 HTTP 监听器接纳请求前加载完成，因此准入保持同步。归属行和 Session 成员关系在内存中建立索引，并从已提交的 `domain/changed` 值刷新；不信任请求 JSON 中的字段。新增 Remote action 前，必须先在其方法描述符中声明它触及的每个资源；没有被 reader 命名的辅助 anchor 或 lookup id 不会获得授权。

</details>
