# 进程沙箱

[English](sandbox.md) | 中文

[dsh-sandbox](../../packages/sandbox/sandbox) 的进程沙箱 seam 将与配套子进程提供方共享执行环境的子进程 argv 包装在文件效果策略中，而不将消费方耦合到特定平台运行器。[dsh-sandbox-local](../../packages/sandbox/sandbox-local) 提供 Linux bwrap/Landlock、macOS Seatbelt 与 Windows ACL 受限令牌后端；[dsh-bash-sandbox](../../packages/shell/bash-sandbox) 和 [dsh-pwsh-sandbox](../../packages/shell/pwsh-sandbox) 是其消费方。[dsh-sandbox-ssh](../../packages/ssh/sandbox-ssh/README.zh.md) 通过与 SSH 文件系统及子进程提供方配套的远端后端执行同一策略。

源码：[`packages/sandbox/sandbox/src/index.ts`](../../packages/sandbox/sandbox/src/index.ts)

## 模式与强制执行

`SandboxMode` 仅管控文件系统效果。`read-only` 要求后端拒绝写入——POSIX runner 还会授予其 shell 所需的 `/dev/null` 接收器，而 Windows ACL runner 不授予任何显式可写根目录，并因环境 ACL 缺口报告部分强制执行；`workspace-write` 允许在工作区根目录、显式额外目录及后端承诺的临时区域下写入；`danger-full-access` 绕过隔离。网络与进程可见性不在此处的定义范围内。

```ts type-equiv
/**
 * File-effect policy for confined processes. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace,
 * explicit extra roots, and backend-defined temp areas; `danger-full-access` bypasses confinement. Network
 * and process visibility are outside this vocabulary.
 */
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
```

只有前两种模式可以发送给提供方。`danger-full-access` 的消费方直接 spawn 原始 argv，不调用 `ctx.sandbox`。

```ts type-equiv
/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

强制执行完整性是后端报告的事实。`full` 表示后端管控了该模式承诺的所有文件效果；`partial` 表示活跃后端或较旧的内核 ABI 仅管控其中一个子集，因此要求绝对保证的消费方必须拒绝或向上暴露这一区别。当前的部分强制执行情形包括较旧的 Landlock ABI，以及 Windows ACL runner 的硬链接、读取不受限与 AppContainer ACL 边界。

```ts type-equiv
/**
 * Enforcement completeness for this host. `partial` means an active backend or
 * older kernel ABI cannot govern every promised file effect; callers requiring
 * an absolute boundary must not treat it as `full`.
 */
type SandboxEnforcement = 'full' | 'partial'
```

## 逐调用策略

完整执行策略会按每次能力调用解析并携带。它包括 `danger-full-access`，因此消费方可以只解析一次策略，再决定是否绕过约束。普通工具调用从调用会话的不可变 cwd 派生 `workspaceRoot`；部署配置提供无 agent 调用的回退值和显式额外写入授权。解析器保留执行环境中的绝对路径写法。执行限制的提供方在文件实际存在的位置规范化根目录，因此包含 `symlink/..` 的 cwd 会标识配套子进程提供方实际运行的目录。

```ts type-equiv
/**
 * The complete file-effect policy resolved for one capability call. The root
 * is carried even under modes that do not consume it so callers can resolve
 * policy once before choosing the enforcement path.
 */
interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  workspaceRoot: string
  /**
   * Extra physical absolute directories `workspace-write` may also write under.
   * Absence means none. The enforcing host rejects missing, non-directory, and
   * symlinked entries on each call. Remote paths are checked on the remote host.
   * These grant nothing under `read-only` or `danger-full-access`.
   */
  additionalWritableRoots?: readonly string[]
  /**
   * Opaque identity of the calling session (the branded `dsh-session`
   * SessionId). Backends key per-session state off it (e.g. windows-acl gives
   * each live session/workspace pair a random private temp directory and SID,
   * while the workspace SID and standing grant remain per-workspace); absent
   * for agentless calls, which fall back to per-call backend state.
   */
  sessionId?: SessionId
}
```

`ctx.sandboxPolicy.resolve()` 接收活跃会话；对于已批准的重试，还接收显式模式。该服务拥有优先级与 root 回退规则，使 bash 和 fs 不必重复实现。

```ts type-equiv
/** Inputs that select the sandbox policy for one capability call. */
interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}
```

只有受约束的执行会到达 `ctx.sandbox`；传给提供方的策略在保留同一 root 的同时收窄模式。这使并发会话、消费方与一次性提权重试可以向同一提供方请求不同边界，而无需改变提供方状态。

```ts type-equiv
/**
 * What one confined execution is allowed to touch — carried PER CALL, not
 * fixed on the provider: two consumers may confine under different policies
 * at the same instant (bash under `read-only` while a confined child agent
 * needs its state directory writable), and an approved escalated retry is a
 * new call with a wider policy. Defaulting/resolution is an explicit step at
 * the consumer boundary; the provider treats the policy as fully specified.
 */
interface SandboxPolicy extends SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: ConfinedSandboxMode
}
```

<a id="wrapped-argv-and-classification-dialects"></a>

## 包装后的 argv 与分类方言

`RunnerFailureRule` 汇集用于判定 runner 在执行命令前失败的证据。消费方要求进程以非零状态退出，并同时满足可选的允许退出码门控，以及余下某一 stderr 行中不区分大小写的致命签名。系统会先按不区分大小写的整行精确匹配移除信息性排除项，因此无害的 runner 通知本身不能证明失败。匹配到的行仍可用作错误详情；分类过程不会重写 stderr。

```ts type-equiv
/**
 * Evidence that identifies a sandbox runner failing before it executes the
 * wrapped command. A consumer first applies {@link allowedExitCodes} when
 * present, removes {@link informationalLines} by case-insensitive exact line
 * equality, then matches {@link fatalSignatures} case-insensitively within
 * each remaining stderr line. Exit status alone never proves runner failure.
 */
interface RunnerFailureRule {
  /** Nonzero process exit codes on which this rule may match; omitted permits any nonzero exit. */
  allowedExitCodes?: readonly number[]
  /** Non-empty substrings identifying a fatal runner diagnostic on one stderr line. */
  fatalSignatures: readonly string[]
  /** Benign stderr lines excluded by exact full-line equality before fatal matching. */
  informationalLines?: readonly string[]
}
```

`ConfinedArgv` 是消费方实际 spawn 的内容。除了替换后的 argv，它还携带后端的强制执行事实和两种正交的 stderr 分类器。`denialSignatures` 用于识别沙箱正常工作时受限命令被阻止的情况。`runnerFailureRules` 用于识别沙箱 runner 在执行命令之前拒绝或失败的情况；消费方应先检查后者，将其作为沙箱基础设施故障上报，而非普通任务失败。

```ts type-equiv
/**
 * A {@link SandboxProvider.confine} result: the argv to spawn in place of
 * the caller's own, plus the enforcement completeness the selected backend
 * achieves for it.
 */
interface ConfinedArgv {
  /** The wrapped argv (runner, profile, separator, then the caller's argv). */
  argv: string[]
  /** How completely the selected backend enforces the policy's file effects. */
  enforcement: SandboxEnforcement
  /**
   * The selected backend's denial DIALECT: the case-insensitive stderr
   * substrings a file effect denied by THIS backend produces (EROFS text
   * under bwrap's read-only binds, EACCES under Landlock, EPERM under
   * Seatbelt). A consumer that infers denials from a failed run's stderr
   * matches against exactly these rather than a cross-backend union — the
   * union claims denials a given backend never produces.
   */
  denialSignatures: readonly string[]
  /**
   * Structured runner-failure evidence rules. Consumers require a matching
   * fatal stderr line (after informational exclusions) and any rule-specific
   * exit-code gate before checking denial signatures: runner failure means the
   * command never ran, while denial means confinement worked and blocked it.
   */
  runnerFailureRules: readonly RunnerFailureRule[]
}
```

[本地提供方](../../packages/sandbox/sandbox-local/README.zh.md)拥有运维配置，并将其 runner 方言映射到这些规则。[沙箱化 bash 消费方](../../packages/shell/bash-sandbox/README.zh.md)拥有 spawn 与结果归因。

## 提供方与 fail-closed 错误

`await ctx.sandbox.confine(argv, policy, signal)` 在执行环境中解析策略路径并返回 `ConfinedArgv`，没有可用后端时以 `SandboxUnavailableError`（错误码 `SANDBOX_UNAVAILABLE`）拒绝。可选信号可在启动前取消解析。消费方也可以在 spawn 或观察所返回的 argv 时对失败进行分类；该归因属于消费方约定。对于受限策略，静默的无隔离透传永远不合法。

提供方选择、探测、缓存和后端特定的强制执行报告归[本地提供方](../../packages/sandbox/sandbox-local/README.zh.md)所有。

## 工作区容器

`RunningSandbox` 包含完整的 Docker 容器 ID。`ClosedSandbox` 表示已确认容器不存在。`SandboxStatus` 还包含开启中、关闭中和待清理状态。部署和生命周期行为见 [Docker Runner 参考](../../packages/sandbox/sandbox-runner/README.zh.md)。

`SandboxExecutionIdentity` 将执行 ID 绑定到预期的完整容器 ID。`SandboxExecutionRequest` 另外包含规范化命令参数和命令预算。`SandboxExecutionResult` 包含执行 ID、确认后的退出码，以及各自带有截断标记的 stdout 和 stderr。

`SandboxCancellationResult` 表示取消已请求或执行已经结算，不确认结束原因或清理结果。`SandboxExecutionError.execution` 提供 `SandboxExecutionFailure`：执行/容器身份、已观察到的原因、独立确认的清理状态，以及已知时的 Bash 状态。结果不明与整代删除所中断的执行使用不同错误。[Runner 参考](../../packages/sandbox/sandbox-runner/README.zh.md)说明取消、回收和重试行为。

<a id="workspace-sandbox-management"></a>
## 工作区沙箱管理

`ctx.workspaceSandbox` 在调用配置的本地 Runner 或 SSH 后端前核验原生多用户归属及登记的持久目录。`SandboxRequest` 仅含 `workspaceId`；`SandboxValue` 返回该编号和 `closed`、`starting`、`running`、`closing`、`cleanup_required` 中一种状态。浏览器结果不含容器编号或路径；可选 `SandboxProgress` 提供云阶段及脱敏失败。`SandboxFailureReason` 在 `sandbox/failed` 下区分容量、清理、冲突，以及不可用或结果不明的操作；查询失败不会猜测状态。显式用户后端方法保留完整的 `RunnerRunningSandbox.containerId`，供执行接入。见[包参考](../../packages/sandbox/harness-sandbox/README.zh.md)和[可选 Web 部署](../user/guide/workspace-sandboxes.zh.md)。

内部通信服务 `ctx.sandboxRunnerClient` 接收绑定原始 `RunnerExecutionIdentity` 的完整 `RunnerExecutionRequest`；`RunnerExecutionResult` 保留已确认的退出码与输出尾部。`RunnerCancellationResult` 仅表示接纳，`RunnerExecutionError.execution` 则保留 `RunnerExecutionFailure` 的清理状态和已知 Bash 状态。本机中止与通信期限到达都不确认远端清理。通信层不增加用户授权或模型工具；请求上限、独立预算与安全重取由[包参考](../../packages/sandbox/harness-sandbox/README.zh.md#execution-transport)说明。

`SandboxActivity` 包含 `requests`（直到 turn 结算的未结束原始输入）、`openings`、`executions`（含取消与清理）、`closing` 及派生的 `busy`。经授权的 `activityForUser` 查询观察这些本地拥有者，不预留关闭决定；管理不可用时抛错。它不代替 Runner 状态，也不实现空闲计时器。

## Workspace 远程文件

[Workspace SSH 后端](../../packages/sandbox/harness-sandbox/README.zh.md#workspace-ssh) 提供与 Bash 相同运行时代次的文件系统。受信任调用方须实施原用户与轮次权限及路径约束，在每次操作前复核 `assertCurrent()` 并传递访问取消信号。连接关闭或中断会撤销该能力；本机 Runner 不会代为访问宿主文件。

[Workspace 文本入口](../../packages/sandbox/harness-sandbox/README.zh.md#workspace-text-tools)将这些检查应用于原生 read/write/edit。它保留原生结果渲染和可选的已观察版本策略，将路径限制在捕获的远程根目录中，并按 Workspace 和代次区分观察标识。helper 关闭会等待已接纳文件请求；取消不回滚已经提交的写入。[Vultr 后端](../../packages/sandbox/harness-sandbox/README.zh.md#workspace-vultr)还通过 `ctx.workspaceFileAccess` 提供同代网页传输与已完成只读副本。

```ts type-equiv
/** Files and directory of one original execution generation, never the Harness project directory. */
interface WorkspaceRuntimeFiles {
  readonly fs: FileSystem
  readonly root: string
  readonly signal: AbortSignal
  /** Reject access after closure, disconnect or generation replacement. */
  assertCurrent(): void
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsandbox--sandboxprovider-abstract-seam"></a>

### `ctx.sandbox` — `SandboxProvider` (abstract seam)

Abstract process-sandbox service. confine must return enforcing argv or fail closed at wrap or runner-execution time; silent unconfined passthrough is forbidden. Functional probes arbitrate multi-runner chains and may be skipped for a sole candidate, whose own refusal remains the fail-closed end.

```ts cordis-catalog
/**
 * Wrap `argv` so it executes confined under `policy` on this host; the
 * caller spawns the returned argv in place of its own.
 * @param argv - the exact argv the caller is about to spawn (program plus
 *   arguments), NOT a shell string — a shell-shaped consumer passes
 *   `['bash', '-c', command]`.
 * @param policy - the file-effect policy this execution runs under,
 *   carried per call (see {@link SandboxPolicy}).
 * @param signal - cancellation while the provider resolves the policy and runner.
 * @returns the argv to spawn instead, plus the enforcement completeness
 *   the selected backend achieves for it.
 */
abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>
```

Source: [`packages/sandbox/sandbox/src/index.ts`](../../packages/sandbox/sandbox/src/index.ts)

<a id="ctxsandboxconversation--sandboxconversation"></a>

### `ctx.sandboxConversation` — `SandboxConversation`

Prepares owned workspaces before accepting messages; contributes no model tools.

```ts cordis-catalog
/**
 * Resolve permission for the actual owning turn, rechecking current native ownership.
 * @param agent - Exact Agent executing the original turn.
 * @param turn - Captured original turn; never a latest-message lookup.
 * @returns Original message, generation and cancellation signal; no sandbox is opened here.
 */
forTurn(agent: Agent, turn: number): SandboxExecutionPermit
```

Types: [Agent](core.zh.md)

Source: [`packages/sandbox/harness-sandbox/src/conversation.ts`](../../packages/sandbox/harness-sandbox/src/conversation.ts)

<a id="ctxsandboxpolicy--sandboxpolicyservice"></a>

### `ctx.sandboxPolicy` — `SandboxPolicyService`

The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment default mode, fallback workspace root, and current request-time policy section. Tool layers call resolve for each execution so a session's mode log and immutable cwd travel together to every enforcing capability.

```ts cordis-catalog
/**
 * Resolve the complete policy for one capability call. An approved explicit
 * mode outranks the session's last `sandbox/mode` event, which outranks the
 * deployment default. A session cwd is its workspace-write boundary; the
 * configured root is the fallback for agentless calls and sessions without a
 * cwd.
 * @param request - optional session and approved mode override.
 * @returns the fully resolved per-call mode and absolute workspace root.
 */
resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy

/**
 * Read the session override without applying the deployment default.
 * @param session - session whose log supplies the override.
 * @returns the last logged mode, or `undefined` without one.
 */
overrideOf(session: Session): SandboxMode | undefined
```

Types: [Session](session.zh.md)

Source: [`packages/sandbox/sandbox-policy/src/index.ts`](../../packages/sandbox/sandbox-policy/src/index.ts)

<a id="ctxsandboxrunner--sandboxrunner"></a>

### `ctx.sandboxRunner` — `SandboxRunner`

Coordinates one container generation per workspace, with two slots per deployment.

```ts cordis-catalog
/** Open or reuse the workspace sandbox. A conflicting request never queues for a slot.
 * @param workspaceId - Workspace registry identity.
 * @param directory - Existing workspace directory in the deployment's data root.
 * @returns The confirmed running generation.
 */
async open(workspaceId: WorkspaceId, directory: string): Promise<RunningSandbox>

/** Query the current generation without interpreting an uncertain create as absent. Disposal waits for in-flight queries.
 * @param workspaceId - Workspace registry identity.
 * @returns The observed sandbox state.
 */
async status(workspaceId: WorkspaceId): Promise<SandboxStatus>

/** Run a supervised command on the expected workspace container. Distinct execution IDs can run concurrently.
 * Matching retries share the pending or stored result, including failures.
 * Confirmed per-command cleanup keeps the container usable. An unknown result freezes and removes its generation.
 * Caller disconnects do not cancel the operation; accepted failures include independent cleanup details.
 * @param workspaceId - Workspace registry identity.
 * @param request - Validated arguments and expected generation from the trusted caller.
 * @returns The confirmed exit code and retained output for the caller's execution ID.
 */
async execute(workspaceId: WorkspaceId, request: SandboxExecutionRequest): Promise<SandboxExecutionResult>

/** Request cancellation of an existing command without waiting for cleanup or changing its first accepted reason.
 * Repeated requests share its control channel; a settled command is left unchanged, even in a blocked generation.
 * @param workspaceId - Workspace registry identity.
 * @param request - Execution identity and the original expected container.
 * @returns Whether cancellation is requested or the original result is already settled.
 */
cancel(workspaceId: WorkspaceId, request: SandboxExecutionIdentity): SandboxCancellationResult

/** Close the current generation. Acknowledging deletion alone does not release its slot.
 * @param workspaceId - Workspace registry identity.
 * @returns Closed after Docker confirms the generation is absent.
 */
async close(workspaceId: WorkspaceId): Promise<ClosedSandbox>
```

Types: [WorkspaceId](workspace.zh.md)

Source: [`packages/sandbox/sandbox-runner/src/index.ts`](../../packages/sandbox/sandbox-runner/src/index.ts)

<a id="ctxsandboxrunnerclient--sandboxexecutionbackend-abstract-seam"></a>

### `ctx.sandboxRunnerClient` — `SandboxExecutionBackend` (abstract seam)

Providers share lifecycle and original-request semantics without choosing user permissions.

```ts cordis-catalog
/**
 * Open or reuse the authorized Workspace's execution generation.
 * @param workspaceId - Authorized identity.
 * @param workspaceDir - Registered project path, separate from execution coordinates.
 * @returns Confirmed execution generation.
 */
abstract open(workspaceId: WorkspaceId, workspaceDir: string): Promise<RunnerRunningSandbox>

/**
 * Observe this Workspace without inferring a result from an earlier request.
 * @param workspaceId - Authorized identity.
 * @returns Fresh provider observation.
 */
abstract status(workspaceId: WorkspaceId): Promise<RunnerSandboxStatus>

/**
 * Close the execution generation after confirming managed cleanup.
 * @param workspaceId - Authorized identity.
 * @returns Closure after managed work is quiescent; lost acknowledgement rejects.
 */
abstract close(workspaceId: WorkspaceId): Promise<RunnerClosedSandbox>

/**
 * Execute once or retrieve the unchanged original request's result.
 * @param workspaceId - Authorized identity.
 * @param request - Unchanged original request.
 * @param signal - Wait cancellation, without remote cancellation.
 * @returns Original command result; conflicting requests and unknown outcomes reject.
 */
abstract execute(workspaceId: WorkspaceId, request: RunnerExecutionRequest, signal?: AbortSignal): Promise<RunnerExecutionResult>

/**
 * Request cancellation in the original execution generation.
 * @param workspaceId - Authorized identity.
 * @param request - Original execution and generation.
 * @returns Cancellation receipt, not cleanup confirmation.
 */
abstract cancel(workspaceId: WorkspaceId, request: RunnerExecutionIdentity): Promise<RunnerCancellationResult>

/**
 * Observe work retained by backend preparation or cleanup.
 * @param _workspaceId - Authorized identity.
 * @returns Provider-owned work that survives a cancelled caller, or persistent cleanup barriers.
 */
activity(_workspaceId: WorkspaceId): Pick<SandboxActivity, 'openings' | 'executions' | 'closing'> | undefined

/**
 * Observe deployment progress without exposing cloud identities.
 * @param _workspaceId - Authorized identity.
 * @returns Optional provider-specific cloud progress without deployment coordinates.
 */
progress(_workspaceId: WorkspaceId): SandboxProgress | undefined

/**
 * Access files only in the captured execution generation; unsupported backends refuse rather than using host files.
 * @param _workspaceId - Authorized identity.
 * @param _target - Captured execution generation.
 * @param _signal - Caller lifetime.
 * @returns Generation-bound remote files; the caller retains user and turn authorization.
 */
files(_workspaceId: WorkspaceId, _target: SandboxContainerId, _signal?: AbortSignal): Promise<WorkspaceRuntimeFiles>
```

Types: [WorkspaceId](workspace.zh.md)

Source: [`packages/sandbox/harness-sandbox/src/backend.ts`](../../packages/sandbox/harness-sandbox/src/backend.ts)

<a id="ctxworkspacesandbox--workspacesandbox"></a>

### `ctx.workspaceSandbox` — `WorkspaceSandbox`

Rechecks native ownership and directory records on every operation; owns no container state.

```ts cordis-catalog
/**
 * Open an owned workspace through the independent Runner.
 * @param request - Only the native workspace identity.
 * @returns Browser-safe confirmed running state.
 */
@Remote({ resources: { workspace: (request: SandboxRequest) => request.workspaceId } }) async open(request: SandboxRequest): Promise<SandboxValue>

/**
 * Observe an owned workspace without modifying its sandbox.
 * @param request - Only the native workspace identity.
 * @returns This query's browser-safe observation.
 */
@Remote({ resources: { workspace: (request: SandboxRequest) => request.workspaceId } }) async status(request: SandboxRequest): Promise<SandboxValue>

/**
 * Remove an owned workspace's container while retaining its persistent data.
 * @param request - Only the native workspace identity.
 * @returns Closed only after Runner confirmation.
 */
@Remote({ resources: { workspace: (request: SandboxRequest) => request.workspaceId } }) async close(request: SandboxRequest): Promise<SandboxValue>

/**
 * Open a sandbox for an authenticated backend initiator.
 * @param userId - Authenticated user from the initiating operation.
 * @param workspaceId - Native workspace id.
 * @returns Full running identity for trusted execution integration.
 */
async openForUser(userId: UserId, workspaceId: WorkspaceId): Promise<RunnerRunningSandbox>

/**
 * Observe a sandbox for an authenticated backend initiator.
 * @param userId - Authenticated initiating user.
 * @param workspaceId - Native workspace id.
 * @returns Local closing barrier, or fresh Runner state with internal container identity.
 */
async statusForUser(userId: UserId, workspaceId: WorkspaceId): Promise<RunnerSandboxStatus>

/**
 * Inspect local work before an authorized idle-reclamation decision; does not query Runner or close anything.
 * @param userId - Authenticated initiating user.
 * @param workspaceId - Native workspace id.
 * @returns Outstanding input, openings, executions and closure; unavailable management throws rather than reporting idle.
 */
activityForUser(userId: UserId, workspaceId: WorkspaceId): SandboxActivity

/**
 * Ends all commands in this container without deleting workspace files or sessions.
 * @param userId - Authenticated initiating user.
 * @param workspaceId - Native workspace id.
 * @param target - Optional original execution generation; stale cleanup cannot close a newer generation.
 * @returns Confirmed container absence.
 */
async closeForUser(userId: UserId, workspaceId: WorkspaceId, target?: SandboxCloseTarget): Promise<RunnerClosedSandbox>
```

Types: [UserId](typert.zh.md) · [WorkspaceId](workspace.zh.md)

Source: [`packages/sandbox/harness-sandbox/src/index.ts`](../../packages/sandbox/harness-sandbox/src/index.ts)
<!-- END GENERATED cordis-surface -->

可选 [Vultr 提供方](../../packages/sandbox/harness-sandbox/README.zh.md#workspace-vultr) 通过 `SandboxProgress` 提供云阶段与脱敏失败，拥有带版本云记录、单写者锁、快照完成后删除和恢复。其云活动让已取消的准备与持久失败屏障继续对 `activityForUser` 可见；空闲计时仍由调用方负责。`RunnerClosedSandbox.reconciled` 是原云修改标识已核对、数据已保存且资源确认不存在的内部回执，只有该回执可以解除已有修改不确定性。网页文件通过 `ctx.workspaceFileAccess` 访问同代远程文件或完整只读副本。
