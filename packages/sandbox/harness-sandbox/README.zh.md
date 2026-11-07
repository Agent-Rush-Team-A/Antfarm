---
description: "通过本地 Docker、固定 SSH 或独立 Vultr VM 授权工作区执行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-harness-sandbox

[English](README.md) | 中文

## 概述

核验已登录原生用户的工作区归属和持久目录记录后，开启、查询和关闭工作区沙箱。可信后端接入方还可提交命令并请求取消。所选后端负责执行状态，本地 Runner 还负责容器容量。本地 HTTP 请求有有限等待和结果校验；结果无法确认的修改不会自动重发或执行补偿操作。

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

将可选的 [Web overlay](../../../apps/cli/config/examples/harness-sandbox.patch.yml) 加到 Antfarm 默认的 `start:web` 或 `dev:web` 命令，并按照[部署指南](../../../docs/user/guide/workspace-sandboxes.zh.md)配置。默认入口提供多用户登录和文件服务，此 overlay 增加沙箱管理、已认证消息准备和前台 Runner Bash。多用户对宿主工具的限制继续生效。Web 进程不能访问 Docker；Runner 独立运行。

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
| `maxResponseBytes` | 生命周期/cancel 完整响应体最大字节数，默认 8192。 |
| `execTimeoutMs` | exec 通信总期限，默认 120,000 ms；独立于命令时限。 |
| `cancelTimeoutMs` | cancel 总期限，默认 15,000 ms；独立于已中止的 exec 等待。 |
| `maxExecResponseBytes` | exec 完整响应体最大字节数，默认 1 MiB，包含 JSON 转义。 |

三个 Typert 方法为 `workspaceSandbox/open`、`workspaceSandbox/status` 和 `workspaceSandbox/close`，由 Connection 的 POST `/api/<method>` 承载。唯一业务参数是 `request: { workspaceId }`。沿用现有登录 cookie 和 Connection Host/Origin 检查。额外字段、owner 身份和没有用户调用上下文的访问均被拒绝。结果含 `{ workspaceId, state }`，可附带云端 `progress`；管理结果不暴露容器编号或部署路径。

每次调用检查原生归属及同一 Workspace Registry 编号。开启还要求登记路径是可信根目录下已存在、无符号链接的直接子目录，并在联系 Runner 前再次检查归属。登记目录丢失或移动后仍可查询和关闭。不存在的工作区及跨用户访问沿用原生 `remote-access/denied` 策略；无效业务输入使用 `gateway/bad-request`。

`close` 先授权，再同步撤销旧消息许可，取消该工作区活跃和排队中的 Agent 输入。它等待已接纳的目录校验和 PUT 请求后再发送 DELETE；关闭期间新开启立即失败。只有确认 DELETE 且不存在结果不明的旧修改时才允许重开。阻止标记存在时 `status` 返回本地 `closing`；其他时候查询 Runner 的 `closed`、`starting`、`running`、`closing` 或 `cleanup_required`。工作区登记、文件和会话均保留。

移除原生工作区登记前需要 Runner 的本次查询明确返回 `closed`。已有开启请求或其他状态以 `workspace/sandbox-active` 和 `{ workspaceId, state }` 拒绝删除，需先关闭沙箱。查询失败保留登记和归属。删除保护持续到注册表写入或回滚完成，期间拒绝该工作区的新开启，其他工作区仍可操作。保护由注册表拥有，跨越管理器卸载和重载：每次解析当前活跃服务，管理离线时以 `sandbox/failed` 的 `runner_unavailable` 原因拒绝删除原生工作区。插件卸载等待已接纳的删除保护完成；重载替换具名保护，不保留旧服务。

Runner 失败使用 `sandbox/failed`，详情为 `{ reason, outcomeUnknown }`。稳定原因区分 `sandbox_capacity`、`sandbox_not_ready`、`sandbox_closing`、`sandbox_cleanup_required`、`sandbox_workspace_conflict`、`sandbox_name_conflict`、`sandbox_outcome_unknown`、`invalid_workspace_directory`、`docker_unavailable`、`runner_unavailable` 和 `runner_outcome_unknown`。关闭失败时保留阻止标记，可重试关闭。PUT 或 DELETE 结果不明时，后续 DELETE 也不会解除 `closing`：现有协议无法证明响应丢失的旧修改已收束。查询和插件重载都不清除这种不确定性。消息不含 Runner 原始诊断、路径或堆栈。

<a id="workspace-ssh"></a>
### Workspace SSH 后端

可选的 [SSH 配置](../../../apps/cli/config/examples/harness-ssh.patch.yml) 使用 `backend: provided`，并在管理服务之前加载 `@deepseek-ai/dsh-harness-sandbox/ssh`。`DSH_WORKSPACE_SSH_BINDINGS_JSON` 是以已有原生 WorkspaceId 为键的 JSON 字典；每项包含独立的外部实例标识 `instanceId` 及 [SSH 连接配置](../../ssh/ssh/README.zh.md#deployment-prerequisites)：已有主机别名、helper 启动方式和摘要、远程绝对目录 `workspace`。SSH 私钥保留在 OpenSSH 配置中。缺失或无效的绑定会拒绝执行，不回退到 Harness 本机。

执行协调、多用户授权和会话存储留在 Harness。每个打开的 Workspace 拥有独立的 SSH 服务上下文，文件和进程使用相同连接及目录。远程 VM 只需 helper 和 Bash，无需 Docker 或完整 Harness。原生项目登记路径留在 Harness；Bash 相对目录在远程根目录下解析。模型中的 cwd 仍为 `/workspace`，将 VM 的根目录也设为 `/workspace` 可让 `pwd` 输出用于后续绝对 workdir。命令与输出不做改写。

重复打开复用同一运行时代次。执行标识保存原始请求和结果；修改请求会冲突，执行前取消不会启动命令，记录达到容量后拒绝新标识而不淘汰修改历史。超时和取消等待受管理进程清理。SSH 中断立即撤销文件访问并停止接纳该代次的新任务，显示 `cleanup_required`。关闭会等待已接纳命令结束，并要求原 helper 确认清理后才允许新代次。无法确认时，必须在外部核实远程清理后再重启拥有该连接的服务；重新加载本身不是清理证据。

`files(workspaceId, containerId, signal)` 提供原代次的文件系统、远程根目录、取消信号和 `assertCurrent()`。受信任调用方须保留原用户和轮次权限，在每次操作前复核权限与访问有效性，传递访问取消信号，并实施路径约束。后端本身不注册模型工具。本机 Runner 拒绝文件能力请求，不访问宿主文件。

SSH 关闭只释放 helper 及其受管理进程，不关闭或删除 VM。[Vultr 后端](#workspace-vultr)单独提供云实例创建、快照保存及网页文件传输；空闲计时仍由使用方负责。绑定和执行记录仅保存在当前进程中；实例隔离依赖正确部署的独立 VM 及 SSH 别名，不能仅凭不同 `instanceId` 字符串确认。同宿主机 SSH 测试验证分派与目录分离，不证明 VM 隔离。

<a id="workspace-vultr"></a>
### Vultr 工作区 VM

可选 [Vultr overlay](../../../apps/cli/config/examples/harness-vultr.patch.yml) 通过 `DSH_VULTR_CONFIG_JSON` 中的部署 JSON 选用 `@deepseek-ai/dsh-harness-sandbox/vultr`，使用方式见[部署指南](../../../docs/user/guide/workspace-vultr.zh.md)。Runner 协调保留在 Harness，每个活跃 Workspace 获得一台独立 VM。私有管理凭据、地区、套餐、镜像和 helper 产物由部署配置选择。首次开启只导入一次登记文件；快照恢复保留执行环境。SSH 和 helper 完整性检查通过后才接纳任务；远程失败不选择宿主执行。

云资源所有者在私有 `stateRoot` 下保存带版本的元数据，并持有独占内核锁。并发调用共用准备操作；重启先核对已记录标签、VM 标识和快照描述，再分配实例。未获确认的创建不重放，归属不明或缺失的资源会阻止依赖工作。提供方卸载拒绝新工作，等待已接纳请求和 SSH 清理结束后再释放锁，并保留云磁盘供后续核对。启动失败也会在清理后释放所有权。浏览器安全的 `SandboxValue.progress` 提供阶段和脱敏失败分类，不含 VM 标识或路径。

关闭撤销原代次、停止命令并等待 helper 确认写入已收束。生成完整受限文件副本，确认 helper 清理，刷新 VM 磁盘并确认停机后才创建快照。完整快照与副本持久记录成功后才允许删除 VM。保存失败保留源磁盘。关闭中替换失效连接，须由云所有者先确认原 VM 已停机。显式云资源核对可解除管理器的未知修改屏障；本地 Runner 原有的保守行为保持不变。

提供方提供 `ctx.workspaceFileAccess`，上传与产物 API 通过 `storage: provided` 选用。关闭后的列表和下载使用私有只读副本；从未开启的 Workspace 提供空视图，不写入生命周期元数据。上传或执行恢复 VM 并更新代次。副本文件从不在 Harness 上执行。`maxInstances`、轮询与期限设置、`maxSavedBytes`、`maxSavedFiles` 约束资源使用。容量计入待完成创建、结果未知的创建和本部署的孤立实例；结果未知的创建在重启后仍保留配额，直到原 VM 经核对并回收。完整的新保存替换旧快照；快照存储仍会计费。Vultr overlay 启用共用空闲插件和网页控件；本后端不另加计时器。

`/vultr` 入口接受以下部署配置。凭据文件和 `stateRoot` 必须位于所有登记项目之外。首次创建和快照恢复均通过 cloud-init 安装固定的主机密钥；就绪检查确认当前分配标签后才安装 helper。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKeyFile` | 必填 | 绝对路径的私有 Vultr 管理密钥文件。 |
| `stateRoot` | 必填 | 由单个 Harness 持有的绝对路径私有持久目录。 |
| `deploymentId` | 必填 | 1–32 个字母、数字、`_` 或 `-` 组成的稳定标识。 |
| `region`, `plan`, `osId` | 必填 | 首次创建使用的 Vultr 地区、套餐和正整数 OS 镜像编号。 |
| `sshKeyFile` | 必填 | 绝对路径私有客户端密钥；在本地派生公钥。 |
| `helperArchive` | 必填 | 经过校验的独立 helper 归档绝对路径。 |
| `helperArchiveHash`, `helperHash` | 必填 | 归档和可执行文件的 SHA-256。 |
| `remoteRoot` | `/workspace` | VM 上可写的绝对路径目录；跨重启保持不变。 |
| `apiEndpoint` | `https://api.vultr.com/v2` | HTTPS 管理地址；仅回环测试允许 HTTP。 |
| `maxInstances` | `2` | 同时存在或创建中的自有 VM 上限，包括孤立实例。 |
| `requestTimeoutMs` | `30000` | 单次 API 和 helper 请求期限。 |
| `operationTimeoutMs` | `1800000` | 开启或保存的完整操作期限。 |
| `pollIntervalMs` | `3000` | 云端与 SSH 就绪轮询间隔。 |
| `maxInventoryPages` | `100` | 完整云资源列表的最大页数。 |
| `maxApiResponseBytes` | `4194304` | 完整管理响应体上限。 |
| `maxSavedBytes` | `1073741824` | 首次导入或单份完整文件副本的总字节上限。 |
| `maxSavedFiles` | `100000` | 每次导入或复制的普通文件与目录总项数上限。 |
| `maxExecutions` | `1024` | 每个代次保留的执行记录上限。 |
| `maxOutputBytes` | `65536` | 保留的命令输出字节上限。 |
| `graceMs` | `5000` | 受管进程终止宽限期。 |

<a id="workspace-text-tools"></a>
### Workspace 文本工具

可选入口 `@deepseek-ai/dsh-harness-sandbox/files` 在 SSH Bash 旁注册原生 `read`、`write`、`edit`。SSH 配置在标准预设中加载两个入口，并禁用宿主文件工具。文本入口复用 [tool-fs](../../fs/tool-fs/README.zh.md) 的参数、提示、行窗口、字面匹配、差异元数据及结果渲染。原有参数继续可用；未声明的额外参数，包括 Workspace 和代次覆盖字段，均被拒绝。`readLimit`、`readMaxLineLength`、`readMaxBytes` 使用原生默认值，接受正整数。远程读取使用流式接口，避免 helper 的整文件 RPC 限制。

每次调用捕获具体工具定义、Agent、已接纳轮次及原始消息权限。私有文件系统将原生项目 cwd 和 `/workspace` 路径映射到该代次的远程根目录。相对路径保留远端文件系统解析，包括 `symlink/..`；规范化后位于根目录外的路径被拒绝。每项操作复核权限与目录包含关系，写操作还携带远程 workspace-write 策略。目标标识包含 Workspace 和代次，观察记录不能跨代次使用。文件调用不回退到 Harness 文件系统，取消后也不选择更新的连接。

Workspace SSH 上下文启用[受约束的文本读取](../../ssh/fs-ssh/README.zh.md#use-this-package)。Linux helper 打开目录和最终文件时固定句柄且不跟随符号链接，因此路径校验后的替换无法将读取重定向到握手确定的根目录外。流在完成、失败、取消或提前关闭时释放句柄。Workspace 文本读取要求可访问的 Linux procfs；不支持的远端主机会拒绝读取。

已有可选插件 `fs-observation-policy` 继续提供防覆盖和版本检查；未启用时，原生写入、编辑保持无条件行为。匹配失败和版本过期不会改变文件。取消不保证回滚已经提交的写入。helper 关闭会等待已接纳文件请求结束后确认清理；丢失确认会阻止复用。卸载文本入口会取消并等待调用结束，并移除三个定义。网页上传、下载仍需云迁移的远程文件适配；本入口不改变这些接口。

<a id="conversation-admission"></a>
### 对话接纳

可选 overlay 还加载 `@deepseek-ai/dsh-harness-sandbox/conversation`，依赖原生 Session Controller、Agents 和多用户服务。`session/prompt-admission` 监听器在 Agent 恢复、开启及附件等待之前捕获已认证用户和登记工作区；准备完成后和最终同步入队前再次检查原生会话、工作区归属。准备通过 `openForUser` 开启或复用工作区；失败不会删除共享容器。

准备中的重复 `requestId` 共享同一次准备。已接纳编号通过持久收件箱插入历史去重，包括随后被清队列的输入。已取消但未接纳的编号单独保留进程内回执，重试不能恢复。入队前调用方断线会撤销准备；入队后断线不取消已接纳工作。普通会话停止继续保持原有 `keepInbox` 语义。

`ctx.sandboxConversation.forTurn(agent, turn)` 按原 Agent、已领取消息和轮次返回 `SandboxExecutionPermit`，包含可信身份、确认容器、关闭版本和取消信号。每次调用重新检查归属及撤销状态；工具还必须使用该信号。它不会开启沙箱或借用新消息的许可。对话插件重载取消已有受管输入，不重建许可。应用拥有的 `workspaceSandboxState` 跨管理器、对话插件重载保留关闭标记和取消回执；它不跨进程重启持久化，也不代替 Runner 容器状态。

<a id="runner-bash"></a>
### Runner Bash 入口

`@deepseek-ai/dsh-harness-sandbox/bash` 注册前台 `bash` 定义，需与对话、管理服务一起加载，且同一作用域内不能已有另一个 Bash 注册。提供的多用户 overlay 将 standard preset 替换为此入口及其 persona，禁用其他内置 preset 和宿主工具，并选择原生执行。多用户默认拒绝策略保留；入口注册由调用方持有的例外，核对当前确切定义、步骤接纳的 toolSet 和原消息许可。同名替换、缺少接纳、嵌套分派和卸载仍被拒绝。

参数为 `command`、`description`、可选 `workdir` 和整数 `timeoutMs`（默认 30000，范围 1–60000）。额外参数，包括后台、权限升级和管理字段，均被拒绝。省略目录、`.` 和 `/workspace` 转为 Runner `.`；`src`、`./src` 和 `/workspace/src` 转为 `src`。工作区外绝对路径、Windows 路径、`..` 段、无效文本和空目录在 exec 前失败。exec 请求的完整 UTF-8 JSON 超过 64 KiB 时，在发送前返回 `SANDBOX_INVALID_REQUEST`，并提示大小上限及调整方向。命令字节不变。每个独立调用生成一个 UUID；工具不会开启沙箱、调用宿主 Shell 或收集宿主环境变量。

Agent 步骤信号在异步工具策略前标识原 turn，工具在发送时重新检查该轮许可和接纳的定义。不同调用可以在同一容器并发。普通结果保留已知 stdout/stderr、截断状态和退出码；非零退出仍是成功的工具结果。规范值及终端元数据使用 `/workspace` 路径，不含内部身份。渲染复用 Bash 纯输出辅助函数，不推测信号或 spill 文件。

取消期间继续等待原 exec。最多两次 cancel 使用独立期限；只有 exec 尚未结算时的首次 404 才允许第二次尝试。接纳响应不是清理证据。最多允许一次原样 exec 重取：普通恢复要求当前容器仍为原 running 代且许可有效；取消后的恢复要求经过校验的 cancel 回执证明原记录存在。状态查询期间到达的取消，不能把 running 观察变成创建新执行的许可。每次 HTTP 等待均使用通信层的有限预算。

已确认的单次进程清理保留容器和其他命令。执行或清理未确认时，携带原容器及关闭版本组成的 `SandboxCloseTarget` 进入 `closeForUser`。版本变化时在撤销前拒绝；关闭操作等待开启收束，再在 DELETE 前检查 Runner 身份。代次不同或无法辨认时保留屏障，不删除该容器。错误及后端诊断保留不确定性；后续手动关闭可检查并清理工作区。`execution_limit` 明确报错。插件卸载会取消并收束活动调用，再释放监听器。

`activityForUser(userId, workspaceId)` 返回内部 `SandboxIdleActivity`，在 `SandboxActivity` 上增加活动 `revision`、关闭 `version`、`idleSince` 和 `sandbox`。请求涵盖准备、排队和模型工作，直到 turn 结算；执行涵盖取消、重取及清理，即使许可已撤销。实际登记与结算同步改变活动编号，与关闭版本独立。重复释放和重复输入不会产生额外活动变化。管理不可用时抛错，不报告空闲；删除保护覆盖在途工作及未确认关闭。

`sandbox` 区分包含完整容器编号的已确认 `running`、已确认 `closed` 及 `unconfirmed`。`idleSince` 是进程内 `performance.now()` 时间戳，只在最后一份工作结算且可靠观察到容器运行时设置。成功开启或当前有效的状态观察建立容器代次；重复状态轮询不刷新起点。查询失败、非运行状态、换代及管理不可用使旧空闲段失效；迟到观察不能覆盖新活动或更新的观察。在途 PUT 期间的查询不用于确认该修改的最终状态。对话插件重载保留已结算的空闲历史；管理器重载需要重新观察，进程重启不复用时间戳。提供方持有的准备、执行和清理也使空闲历史失效；关闭前的两次资格检查都计入这些工作。已关闭状态后的文件活动重新进入发现范围，因为上传可以恢复 VM；新的运行状态观察开始下一段计时。这些字段仅供可信后端使用，不进入浏览器结果。

<a id="conditional-idle-close"></a>
### 空闲条件关闭

可信后端调用 `closeIfIdleForUser(userId, workspaceId, target, idleTimeoutMs, signal)`。`SandboxIdleCloseTarget` 组合观察到的运行容器 `containerId`、关闭 `version`、活动 `revision` 及非空 `idleSince`。阈值来自已校验的部署配置；必填信号归扫描生命周期所有，卸载时必须同步中止。方法先检查本地资格再查询 Runner，返回后重新核验原生归属、当前管理器、信号、完整观察和单调空闲时长。调用方无需另行发起关闭前状态查询。

`SandboxIdleCloseResult` 在空闲段不再符合条件时为 `{ state: 'skipped' }`，确认关闭后为 `{ state: 'closed' }`。跳过不撤销消息许可、不调用 Agent.cancel，也不发送 DELETE。最后检查与进入既有同步关闭屏障之间没有 await。先被接纳的工作使回收跳过；屏障建立后的新消息沿用现有拒绝规则，不排队或自动重发。重复空闲调用会跳过已接纳的关闭屏障，普通关闭则复用既有 Promise。

已接纳的关闭保留 DELETE 前的完整容器/关闭版本检查、工作区删除保护、文件与会话。接纳后中止扫描，不会取消这个由管理器拥有的操作。授权、管理不可用及 Runner 失败保留原有错误；接纳后失败继续保留关闭屏障，不返回跳过或关闭成功。

<a id="idle-reclamation"></a>
### 空闲回收

可选 `@deepseek-ai/dsh-harness-sandbox/idle` 函数插件应在应用层加载一次。提供的 Web overlay 以 `sandbox-idle` 加载它，放在 Session preset 外；未加载此 overlay 的 Web 不要求 Runner，也不加载回收器。部署覆盖使用该入口已校验的配置。

| 配置 | 默认值 | 有效值 |
| --- | --- | --- |
| `idleTimeoutMs` | 1800000 毫秒（30 分钟） | 毫秒数须为正的安全整数。 |
| `sweepIntervalMs` | 10000 毫秒（10 秒） | 1 至 2147483647 的整数毫秒。 |

启动发现有已存原生所有者的 Workspace Registry 记录。授权查询为缺少历史的运行容器建立新的完整空闲区间；已关闭容器移出候选。正常活动与开启通过应用状态登记候选。失败或失效观察保留待确认，后续使用有界查询；恢复时先建立区间，不在同轮关闭。原生工作区删除会移除其历史，迟到观察不能重新创建。

每轮串行检查候选，整轮收束后才安排下一个计时器。忙碌和未到期候选无需 Runner 查询。到期候选交给 `closeIfIdleForUser`，由它负责关闭前查询与接纳。一个工作区出错不阻止其他候选。沿用既有查询和修改期限；扫描器不发 PUT、不绕过归属、不清除关闭屏障，也不重试失败的 DELETE。其警告无需其他日志插件即可输出到标准错误；关闭失败会说明保留 `closing`、不自动重试以及需要维护。卸载时警告输出保留到已接纳的管理操作收束，再移除；不转发其他日志名称或 debug 消息。待清理观察同样警告需要维护。

卸载同步中止扫描生命期并清除计时器，然后等待当前轮及已接纳的管理关闭收束。`statusForUser` 可接收观察者信号：中止只抑制历史写入，不取消有界查询；省略时正常记录。只重载扫描器会保留可靠的应用历史。管理器替换通过自身提供方 token 作废历史，进程重启则重新发现。卸载不关闭其他容器。

<a id="integration-handoff"></a>
### 接入交接

| 使用方 | 可用入口 | 后续接入 |
| --- | --- | --- |
| 对话入口 | 可选 Web profile 接纳所属输入，通过所选后端提供 Bash。 | 准备配置的 Runner 或 SSH 端点、执行目录与文件系统身份。 |
| #8：空闲回收 | 可选 Web overlay 发现所属候选，使用已校验的时间配置，通过所选后端执行条件空闲关闭。 | 验证部署中的实际回收、容量释放与持久文件续聊。 |
| #9：网页控件 | 可选 overlay 在三个 Typert 方法、五种状态以及类型化的 `sandbox/failed` 原因上启用网页面板。 | 关闭失败时继续阻止重开；未知修改需要维护来确认收束，查询不能清除它。 |

新增文件、搜索或浏览器工具，必须先实现各自的隔离执行、确切定义授权、原 turn 许可和取消处理，再由 overlay 展示。文件操作须在沙箱内按登记工作区解析路径，并将真实结果保留到日志、回放和展示。Bash 的例外不授权其他定义或同名宿主实现。

内部显式用户方法只接收可信后端代码取得的身份，不会在缺失调用上下文时推断 owner。子服务 `sandboxRunnerClient` 仅负责通信，不能作为用户管理 API 暴露。本地 Runner 客户端卸载会中止本机等待，等待请求连接与期限计时器释放，并移除方法，不发送 DELETE 或 cancel；断线和超时都不代表远端已清理。

<a id="web-control-handoff"></a>
### 网页控件交接

自动回收沿用现有 `SandboxValue`，只包含 `workspaceId` 和五种状态之一。`closed` 不标记关闭原因，`running` 不表示活动情况或空闲截止时间；接口不暴露倒计时、容器身份或后端时间戳。状态轮询和查看持久文件不保活。确认关闭后，新消息通过正常准备流程重新开启同一工作区，浏览器无需在每条消息前先调用开启。

手动 `close` 会撤销已接纳和排队的输入，空闲回收则在接纳关闭前检查连续无活动。屏障之后的消息收到既有 `gateway/cancelled` 拒绝；该错误也用于其他撤销，不能据此认定发生空闲回收。已取消的原 requestId 继续无效，关闭后续聊使用新 requestId。`sandbox/failed` 保留类型化 `reason` 和 `outcomeUnknown`：`sandbox_capacity` 表示部署容量已满，不暴露其他用户容器；失败或不明的关闭不能展示为已确认 `closed`。查询和管理器重载都不能清除未知修改屏障。每次操作仍遵守原生归属和停用账号限制，后台检查也一样。

<a id="execution-transport"></a>
### 执行通信

后端使用方授权发起用户后，调用 `ctx.sandboxRunnerClient.execute(workspaceId, request, signal?)`，传入保存的 `RunnerExecutionRequest`：`executionId`、完整 `expectedContainerId`、原样 `command`、相对 POSIX `workdir` 和 1–60,000 的整数 `timeoutMs`。调用方在调用前确定目录和命令时限。完整 UTF-8 JSON 请求上限为 64 KiB，执行编号上限为 128 个 UTF-16 单元。客户端不生成编号、不更换容器代次、不开启沙箱、不重试。只有调用方已经确认可安全重取时，才用保存的同一请求再次调用 `execute`。

`RunnerExecutionResult` 保留执行编号、退出码，以及独立的 stdout/stderr 文本和截断标志。非零退出码仍是已完成的命令结果。`RunnerExecutionError` 保留 Runner 错误码、HTTP 状态和 `execution` 字段：匹配的执行/容器身份、原因、清理状态，以及已知时的 Bash 状态。缺少 Bash 状态不会被替换为 null 或编造的退出码。其他完整拒绝，包括 `execution_limit`，仍使用 `RunnerResponseError`；非法、不匹配或不完整的响应及丢失的修改结果使用 `RunnerRequestError`。结果不明时，调用方确认原执行结果前停止后续依赖工作；通信层不自动恢复或重放。

`ctx.sandboxRunnerClient.cancel(workspaceId, identity)` 通过独立的有限等待连接，只发送原 `executionId` 和 `expectedContainerId`。它不接收调用方信号，已中止的工具信号不会阻止发出取消。`RunnerCancellationResult` 区分 HTTP 202/requested 与 200/settled；两者都不确认取消胜出或清理完成。404 或旧代拒绝保留原错误，不创建执行。调用方从原执行流程取得最终结果与清理证据。

可选的 execute 信号只中止本机等待；省略时，由服务生命周期与 `execTimeoutMs` 约束等待。取消使用独立的 `cancelTimeoutMs`，Runner 命令监管和清理使用 Runner 自己的设置。两路输出各可在 JSON 转义前包含 64 KiB；独立 exec 响应上限容纳其完整编码响应。断线、本机期限到达及卸载都不表示远端命令已停止。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[管理服务](src/index.ts)负责授权、目录校验和浏览器安全结果投影。[应用状态](src/lifecycle.ts)协调关闭标记；[许可](src/permits.ts)通过真实收件箱事件绑定[对话接纳](src/conversation.ts)。[通信子服务](src/transport.ts)拥有 [HTTP 客户端](src/runner-client.ts)，将请求收束绑定到卸载。[通信设置](src/config.ts)分别提供生命周期、执行和取消预算；[执行校验](src/execution.ts)检查身份及结果，[管理类型](src/types.ts)声明脱敏的浏览器值和错误。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Runner 参考](../sandbox-runner/README.zh.md) — 生命周期和持久目录。
- [多用户参考](../../api/multiuser/README.zh.md) — 账号和工作区归属。
- [沙箱子系统](../../../docs/subsystems/sandbox.zh.md) — 生成的服务参考。

<a id="model-experience"></a>
## 模型体验

### Bash

#### 模型可见内容

对话接纳在输入送达模型前准备沙箱。可选 Bash 入口只暴露前台命令参数和保留的命令结果。说明使用 `/workspace`，不含管理身份或宿主环境信息。提供的 overlay 将 Working Directory 的模型显示配置为 `/workspace`，禁用宿主文件策略上下文、结果溢出存储、开发与文件交付引导，只展示 Bash；后端路径继续记录。

#### Token 影响

挂载 Bash 入口会增加其 schema 和日志中的工具结果。普通输出沿用 stdout/stderr 布局，准确标记截断及非零退出。每路最多保留 Runner 的 64 KiB 尾部；overlay 禁用宿主 `spill-policy`，因此结果不含宿主恢复路径，也不要求使用尚未开放的文件工具。生命周期操作不增加模型 token。

#### KV Cache 影响

稳定工具说明可共享提示前缀，结果按普通工具历史追加。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **部署** — Runner 需要 Linux Unix socket 和单独配置的非 root 文件系统身份。Windows 命名管道仅用于通信测试。
- **能力** — Runner overlay 只暴露 Bash。SSH 文本文件需要单独的 `./files` 入口和绑定代次的后端访问。搜索、PowerShell、后台、终端、浏览器和间接工具仍须先完成隔离。Runner overlay 启用网页管理控件。
- **云端保留** — 删除工作区登记不会移除已保留的云快照或私有副本；部署运维负责已删除工作区的保留策略。关闭后的下载副本仅保留普通文件和目录，符号链接及特殊条目仅保留在完整磁盘快照中。
- **云端验收** — `DSH_VULTR_TEST_CONFIG` 为[可选真实云端 Loader 测试](tests/vultr-loader.e2e.ts)指定私有部署 JSON，通过 `pnpm exec vitest run --config vitest.e2e.config.ts packages/sandbox/harness-sandbox/tests/vultr-loader.e2e.ts` 运行；`DSH_VULTR_TEST_EVIDENCE` 可选指定报告路径。测试创建两台计费 VM 和磁盘快照，以脚本模型验证真实 SSH 和已认证 HTTP，并移除带有唯一测试标签的资源；它不验证真实模型提供方或浏览器控件。
- **空闲范围** — 回收面向单个应用实例管理所选后端，不合并多个 Harness 进程的活动；本地 Runner 接入不发现启动后直接通过 Runner 创建的容器。停用账号或缺失归属需要维护；后台循环不绕过原生授权。
- **修改结果不明** — PUT/DELETE 响应丢失后需要部署维护确认旧 Runner 请求已收束。现有协议不能自动解除本进程阻止标记；仅重启 Harness 不能证明远端已收束。
- **验证** — 可选[对话 Docker 夹具](../../../apps/cli/tests/profiles/harness-sandbox/fixtures/docker-acceptance.mjs)和[空闲 Docker 夹具](../../../apps/cli/tests/profiles/harness-sandbox/fixtures/docker-idle-acceptance.mjs)使用可控模型及真实鉴权的 Web、Runner profile，要求 Linux、用于准备的 root、当前构建产物及 Linux 依赖和 Docker 权限。`M5_DATA_ROOT` 必须选择对应夹具的专用 daemon 可见绑定：对话用 `/tmp/antfarm-issue7-m5`，空闲用 `/tmp/antfarm-issue8-m5`；`M5_EVIDENCE_DIR` 选择证据输出。空闲夹具使用 5000 毫秒空闲、100 毫秒扫描配置，独立核对真实容器身份、容量和保留文件，并清理隔离部署；子进程非零退出或因信号退出会使验收失败。这些夹具不证明真实模型或 Vultr 结果。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
