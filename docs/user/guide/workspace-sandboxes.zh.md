---
description: "通过独立 Linux Runner 启用经过鉴权的工作区沙箱管理。"
kind: "user-guide"
---

# 工作区沙箱管理

[English](workspace-sandboxes.md) | 中文

<a id="prepare-the-deployment"></a>
## 准备部署

使用可选的 [Web overlay](../../../apps/cli/config/examples/harness-sandbox.patch.yml)，前提是已按照 [Runner 部署说明](../../../team-docs/SANDBOX-RUNNER.md)部署独立 Runner。Docker 凭据及 socket 不能进入 Web 进程。Web 进程只需要 Runner 管理 socket 和持久工作区根目录。

将 `DSH_MULTIUSER_WORKSPACE_ROOT` 设置为 Runner 配置的同一 Linux 规范目录，将 `DSH_SANDBOX_RUNNER_SOCKET` 设置为管理 socket。根目录应位于 Docker 数据目录之外；容器化的 Harness 和 Runner 进程必须看到 Engine 挂载的同一绝对路径。原生工作区创建流程以 0700 权限分配目录：容器配置 UID 必须与非 root Harness 用户一致，Runner 需要遍历和挂载权限。启动前准备这些权限；开启沙箱不会更改所有者或复制旧工作区。

通过已有的[多用户维护命令](../../../packages/api/multiuser/README.zh.md#configuration)创建账号。验收使用独立测试存储根目录；维护命令不会覆盖已有账号。

```sh
export DSH_MULTIUSER_WORKSPACE_ROOT=/srv/agentrush/workspaces
export DSH_SANDBOX_RUNNER_SOCKET=/run/agentrush-sandbox/runner.sock
pnpm run start:web --patch apps/cli/config/examples/harness-sandbox.patch.yml --no-open
```

Antfarm 默认 Web 入口提供账号登录和工作区文件服务，overlay 增加沙箱管理，以及已认证用户向所属工作区会话发送消息时的自动准备。准备失败会拒绝消息。其 standard preset 只暴露前台 Runner Bash；宿主文件工具与终端交接仍被拒绝。有 Docker 权限的 Runner 仍独立于 Web。缺少必需配置时启动失败。直接使用 `pnpm dsh web` 时，需在此 overlay 之前加载 `apps/cli/config/antfarm-web.patch.yml`。

<a id="docker-task-modes"></a>
## Docker 任务模式

需要每个 Workspace 选择单会话或多会话 Docker 时，使用 [Docker 模式叠加层](../../../apps/cli/config/examples/harness-docker-modes.patch.yml)替代普通沙箱叠加层。将 `DSH_DOCKER_MODES_CONFIG_JSON` 设为包含 `socketPath`、`workspaceRoot`、私有绝对目录 `stateRoot`、`maxFiles` 和 `maxBytes` 的对象。`workspaceRoot` 必须等于 `DSH_MULTIUSER_WORKSPACE_ROOT`；复制预算限制完整模式切换。恢复日志目录必须位于 Workspace 文件之外，且仅由 Web 服务账号持有。

新 Workspace 从 `multi-docker` 开始。首个会话创建前，通过 `workspace/setMode` 选择 `single-docker`；创建会话后选择永久锁定。单会话任务在附件验证后自动开启容器，等待排队输入、命令和文件写入收尾后销毁容器。继续对话时使用保留的文件启动新容器。单会话的手动开启和关闭请求被拒绝；多会话保留手动及空闲控制。此叠加层支持 Docker 模式；已有 VM 模式会阻止运行时加载。

启动前检查最终组合：

```sh
pnpm dsh web --patch apps/cli/config/antfarm-web.patch.yml --patch apps/cli/config/examples/harness-docker-modes.patch.yml --dump-config
```

<a id="use-the-web-controls"></a>
## 使用网页操作

启用 overlay 后，从工作区操作菜单或对话输入栏选择 **工作区沙箱**。多会话工作区的输入栏会在盾牌旁显示名称。两个入口打开同一面板，打开面板只查询状态。

点击 **开启沙箱** 启动沙箱，面板先显示 **正在开启…**，确认成功后显示 **运行中**。点击 **关闭沙箱**，再点击 **确认关闭** 停止沙箱；面板先显示 **正在关闭…**，确认移除后显示 **已关闭**。取消确认或关闭面板会保持沙箱运行。关闭沙箱保留文件和对话，但会终止正在处理和等待的任务。

对多会话 Vultr VM，**正在关闭…** 表示关闭仍在进行。如果面板显示 **需要清理**，选择 **清理沙箱** 并确认，即可重试关闭。Antfarm 会保留原 VM，直到确认快照已完成。

两个名额都占用时，面板提示 **沙箱已满，请关闭一个或稍后重试**。关闭一个运行中的沙箱，再重试失败的开启操作。刷新状态不会重试开启或关闭。查询失败时标明最近观察到的状态，并禁用修改操作，直到查询成功；操作结果未知时禁止开启，需要管理员处理。连接或工作区权限丢失时关闭面板；恢复访问后重新打开。

<a id="call-the-management-methods"></a>
## 调用管理方法

通过已有 `/auth/login` 流程登录，再通过原生工作区接口创建工作区。后端解析已保存的所有者和目录；浏览器输入不能选择宿主目录或容器。

| Typert 方法 | 业务参数 | 结果 |
| --- | --- | --- |
| `workspaceSandbox/open` | `request: { workspaceId }` | `{ workspaceId, state: 'running' }` |
| `workspaceSandbox/status` | `request: { workspaceId }` | `{ workspaceId, state }` |
| `workspaceSandbox/close` | `request: { workspaceId }` | `{ workspaceId, state: 'closed' }` |

Connection 使用普通 Typert 请求封装、登录 cookie 和 Host/Origin 检查，通过 POST `/api/<method>` 承载这些方法。跨用户和不存在的工作区访问在联系 Runner 前被拒绝。管理结果不含内部路径、容器编号或堆栈。

状态表示一次当前观察：`closed`、`starting`、`running`、`closing` 或 `cleanup_required`。查询失败是错误，不会猜测为 `closed`。容量、启动、关闭、清理、配置冲突和服务故障通过 `sandbox/failed` 下不同的稳定原因表示，见[包参考](../../../packages/sandbox/harness-sandbox/README.zh.md#use-this-package)。

关闭先撤销旧准备，取消该工作区活跃和排队中的输入，再等待已接纳的开启并移除容器。`closing` 期间新开启立即失败。关闭失败保留此状态，可以重试。PUT 或 DELETE 出现 `outcomeUnknown: true` 后，后续 DELETE 也不会解除 `closing`：现有协议无法证明旧修改已收束。插件重载不清除此标记。部署维护见[包限制](../../../packages/sandbox/harness-sandbox/README.zh.md#known-limitations-and-deferred-work)；单次 `closed` 观察或重启 Harness 均不是充分证据。文件、会话和工作区登记保留。

移除工作区登记前先关闭其沙箱。删除会查询 Runner 并要求 `closed`；正在开启或活跃的沙箱返回 `workspace/sandbox-active`，Runner 不可用时保留工作区。管理服务卸载或重载期间同样拒绝删除，服务恢复后可重试。目录移动或丢失后仍可查询和关闭，不会阻止清理。

<a id="automatic-idle-reclamation"></a>
## 自动空闲回收

overlay 在应用层加载一个 `sandbox-idle` 插件。运行中的工作区必须结束所有准备、排队输入、模型工作、命令和清理，并连续空闲 30 分钟，才具备回收资格。新接纳请求会在其工作结束后重新计时。状态轮询和查看持久文件不为容器保活。每轮结束后才开始下一次 10 秒等待，因此实际关闭可能晚于阈值。

后端在接纳关闭前再次检查当前归属、原容器和活动。先被接纳的工作使旧扫描跳过；关闭开始后的消息收到既有正在关闭错误。回收成功只移除容器，文件、Session 和工作区登记保留；下一条新消息通过普通准备流程重开工作区。模型不增加管理工具或倒计时。

调整时间时，在沙箱 overlay 后应用部署 patch，以 `id: sandbox-idle` 为目标设置 `config.idleTimeoutMs` 和 `config.sweepIntervalMs`。数值和限制见[空闲插件参考](../../../packages/sandbox/harness-sandbox/README.zh.md#idle-reclamation)。禁用该入口会停止后续扫描并等待已接纳关闭收束，不会关闭所有容器。入口应放在应用层，不能放进每个 Session 的 preset。

失败观察保留供后续有界重查。进程重启或管理恢复后，为可靠运行的容器重新给予完整区间。失败或不明的 DELETE 保留 `closing`，空闲扫描不重试。停用账号、缺失所有者和待清理状态需要授权维护；扫描器不自行扩展清理权限。

<a id="continue-the-integrations"></a>
## 继续接入

可选 overlay 准备消息、将 Bash 转发给 Runner，并回收空闲容器。模型看到 `/workspace`、命令输出与退出码，不接收沙箱管理参数。输出使用 Runner 的有界尾部；模型无法访问宿主溢出文件，因此禁用宿主结果溢出存储。[接入交接](../../../packages/sandbox/harness-sandbox/README.zh.md#integration-handoff)说明授权内部方法、活动查询和浏览器 API。其他工具须分别完成隔离。
