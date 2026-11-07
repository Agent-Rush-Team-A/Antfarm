---
description: "授权原生工作区沙箱操作，并调用独立的本机 Runner。"
kind: "package-reference"
---

# @deepseek-ai/dsh-harness-sandbox

[English](README.md) | 中文

## 概述

核验已登录原生用户的工作区归属和持久目录记录后，开启、查询和关闭工作区沙箱。可信后端接入方还可提交命令并请求取消。独立 Runner 负责容器状态和容量。HTTP 请求有有限等待和结果校验；结果无法确认的修改不会自动重发或执行补偿操作。

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

三个 Typert 方法为 `workspaceSandbox/open`、`workspaceSandbox/status` 和 `workspaceSandbox/close`，由 Connection 的 POST `/api/<method>` 承载。唯一业务参数是 `request: { workspaceId }`。沿用现有登录 cookie 和 Connection Host/Origin 检查。额外字段、owner 身份和没有用户调用上下文的访问均被拒绝。结果仅含 `{ workspaceId, state }`；管理结果不暴露容器编号或部署路径。

每次调用检查原生归属及同一 Workspace Registry 编号。开启还要求登记路径是可信根目录下已存在、无符号链接的直接子目录，并在联系 Runner 前再次检查归属。登记目录丢失或移动后仍可查询和关闭。不存在的工作区及跨用户访问沿用原生 `remote-access/denied` 策略；无效业务输入使用 `gateway/bad-request`。

`close` 先授权，再同步撤销旧消息许可，取消该工作区活跃和排队中的 Agent 输入。它等待已接纳的目录校验和 PUT 请求后再发送 DELETE；关闭期间新开启立即失败。只有确认 DELETE 且不存在结果不明的旧修改时才允许重开。阻止标记存在时 `status` 返回本地 `closing`；其他时候查询 Runner 的 `closed`、`starting`、`running`、`closing` 或 `cleanup_required`。工作区登记、文件和会话均保留。

移除原生工作区登记前需要 Runner 的本次查询明确返回 `closed`。已有开启请求或其他状态以 `workspace/sandbox-active` 和 `{ workspaceId, state }` 拒绝删除，需先关闭沙箱。查询失败保留登记和归属。删除保护持续到注册表写入或回滚完成，期间拒绝该工作区的新开启，其他工作区仍可操作。保护由注册表拥有，跨越管理器卸载和重载：每次解析当前活跃服务，管理离线时以 `sandbox/failed` 的 `runner_unavailable` 原因拒绝删除原生工作区。插件卸载等待已接纳的删除保护完成；重载替换具名保护，不保留旧服务。

Runner 失败使用 `sandbox/failed`，详情为 `{ reason, outcomeUnknown }`。稳定原因区分 `sandbox_capacity`、`sandbox_not_ready`、`sandbox_closing`、`sandbox_cleanup_required`、`sandbox_workspace_conflict`、`sandbox_name_conflict`、`sandbox_outcome_unknown`、`invalid_workspace_directory`、`docker_unavailable`、`runner_unavailable` 和 `runner_outcome_unknown`。关闭失败时保留阻止标记，可重试关闭。PUT 或 DELETE 结果不明时，后续 DELETE 也不会解除 `closing`：现有协议无法证明响应丢失的旧修改已收束。查询和插件重载都不清除这种不确定性。消息不含 Runner 原始诊断、路径或堆栈。

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

`sandbox` 区分包含完整容器编号的已确认 `running`、已确认 `closed` 及 `unconfirmed`。`idleSince` 是进程内 `performance.now()` 时间戳，只在最后一份工作结算且可靠观察到容器运行时设置。成功开启或当前有效的状态观察建立容器代次；重复状态轮询不刷新起点。查询失败、非运行状态、换代及管理不可用使旧空闲段失效；迟到观察不能覆盖新活动或更新的观察。在途 PUT 期间的查询不用于确认该修改的最终状态。对话插件重载保留已结算的空闲历史；管理器重载需要重新观察，进程重启不复用时间戳。这些字段仅供可信后端使用，不进入浏览器结果。

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
| 对话入口 | 可选 Web profile 接纳所属输入，只暴露 Runner Bash。 | 部署匹配的 Harness/Runner 构建、工作区路径与文件系统身份。 |
| #8：空闲回收 | 可选 Web overlay 发现所属候选，使用已校验的时间配置执行条件空闲关闭。 | 验证部署中的真实 Docker 删除、容量释放与持久文件续聊。 |
| #9：网页控件 | 三个 Typert 方法、五种状态以及类型化的 `sandbox/failed` 原因。 | 增加按钮和展示。关闭失败时继续阻止重开；未知修改需要维护来确认收束，查询不能清除它。 |

新增文件、搜索或浏览器工具，必须先实现各自的隔离执行、确切定义授权、原 turn 许可和取消处理，再由 overlay 展示。文件操作须在沙箱内按登记工作区解析路径，并将真实结果保留到日志、回放和展示。Bash 的例外不授权其他定义或同名宿主实现。

内部显式用户方法只接收可信后端代码取得的身份，不会在缺失调用上下文时推断 owner。子服务 `sandboxRunnerClient` 仅负责通信，不能作为用户管理 API 暴露。服务卸载会中止本机等待，等待请求连接与期限计时器释放，并移除方法，不发送 DELETE 或 cancel；断线和超时都不代表远端已清理。

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
- **能力** — 只有 Runner Bash 拥有多用户执行例外。文件、搜索、PowerShell、后台、终端、浏览器和间接工具须先完成各自隔离；网页管理控件仍需另外接入。
- **空闲范围** — 回收面向单个应用实例管理独立 Runner，不合并多个 Harness 进程的活动，也不发现启动后直接通过 Runner 创建的容器。停用账号或缺失归属需要维护；后台循环不绕过原生授权。
- **修改结果不明** — PUT/DELETE 响应丢失后需要部署维护确认旧 Runner 请求已收束。现有协议不能自动解除本进程阻止标记；仅重启 Harness 不能证明远端已收束。
- **验证** — 可选[对话 Docker 夹具](../../../apps/cli/tests/profiles/harness-sandbox/fixtures/docker-acceptance.mjs)和[空闲 Docker 夹具](../../../apps/cli/tests/profiles/harness-sandbox/fixtures/docker-idle-acceptance.mjs)使用可控模型及真实鉴权的 Web、Runner profile，要求 Linux、用于准备的 root、当前构建产物及 Linux 依赖和 Docker 权限。`M5_DATA_ROOT` 必须选择对应夹具的专用 daemon 可见绑定：对话用 `/tmp/antfarm-issue7-m5`，空闲用 `/tmp/antfarm-issue8-m5`；`M5_EVIDENCE_DIR` 选择证据输出。空闲夹具使用 5000 毫秒空闲、100 毫秒扫描配置，独立核对真实容器身份、容量和保留文件，并清理隔离部署；子进程非零退出或因信号退出会使验收失败。这些夹具不证明真实模型或 Vultr 结果。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
