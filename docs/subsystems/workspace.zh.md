# 工作区

[English](workspace.md) | 中文

工作区（workspace）是用户工作目录的持久记录：一个建立在规范路径之上的稳定 id、一个显示标题，以及归属于它的会话的有序账本。该子系统是单个包（package）（[dsh-workspace](../../packages/workspace/workspace)，`ctx.workspaceRegistry`）——一项宿主侧可选能力，不属于 agent loop（智能体循环）主干，并且对模型不可见（没有工具、没有提示词文本、没有会话事件）。它通过[存储领域数据形式](storage.zh.md)存储自己的记录，并对照 [`SessionHeader.cwd`](persistence.zh.md#sessionheader--metadata-beside-the-log) 校验会话成员资格，因此 `storageDomain` 与 `sessionPersistence` 是必需的启动依赖：持久化这一依赖不可用时，插件保持 pending，而不是把这种不可用误当作空历史。设计记录：[领域 KV 存储 Agent Note（agent 决策记录）](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)；引导与 GUI 顺序：[Workspace UI 产品流程 Agent Note](../../.agents/notes/archived/feature/2026-07-25-workspace-ui-product-flow.md)。

源码：[`packages/workspace/workspace/src/types.ts`](../../packages/workspace/workspace/src/types.ts)

## 标识

```ts type-equiv
/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
type WorkspaceId = Branded<'WorkspaceId'>
```

`WorkspaceId` 是[品牌化 id](core.zh.md#branded-ids)。路径标识与之分离：`realpathNormalize`（`fs.realpath`；尾部斜杠、`..` 与符号链接全部解析）是唯一的一套唯一性规范——工作区路径以规范化形式存储，唯一性即规范路径的字符串相等（指向已被拥有目录的符号链接会与之冲突），attach 时的会话 cwd 检查也走同一套规范。

## Workspace 模式

模式元数据区分首个会话的永久锁定与当前操作准入状态。Host 协调器通过共享资源租约串行处理创建与配置切换；运行时收尾遵循持久化决策，中断的操作需要可信恢复。运行时文件和环境路由由注册的提供方负责。

```ts type-equiv
/** Ordinary Session topology and VM or Docker execution environment selection. */
type WorkspaceMode = 'single-vm' | 'multi-vm' | 'single-docker' | 'multi-docker'
```

```ts type-equiv
/** A durable transition identity reused during recovery. */
type WorkspaceModeChangeId = Branded<'WorkspaceModeChangeId'>
```

```ts type-equiv
/** Configuration locking is permanent after the first successful ordinary Session. */
type WorkspaceModeLockReason = 'first-session-created'
```

```ts type-equiv
/** Operational admission state, independent of permanent configuration locking. */
type WorkspaceModeOperationState =
  | 'ready'
  | 'switching'
  | 'creating-session'
  | 'recovery-required'
```

```ts type-equiv
/** Browser-safe configuration; every durable state mutation increases revision. */
interface WorkspaceModeConfig {
  readonly workspaceId: WorkspaceId
  readonly mode: WorkspaceMode
  readonly revision: number
  readonly operationState: WorkspaceModeOperationState
  readonly modeLocked: boolean
  readonly lockReason: WorkspaceModeLockReason | null
  readonly firstSessionId: SessionId | null
}
```

```ts type-equiv
/** The lease is a stable routing snapshot until release. */
type WorkspaceModeUseConfig = WorkspaceModeConfig & {
  readonly operationState: 'ready'
}
```

```ts type-equiv
/** Captured authority and cancellation for one trusted internal operation. */
interface WorkspaceModeOperationOptions {
  readonly signal: AbortSignal
  /** Throw if the original caller no longer owns the original registration. */
  admit(): void
}
```

```ts type-equiv
/** Held across all resource use; nested helpers reuse it instead of reacquiring. */
interface WorkspaceModeUseLease {
  readonly config: WorkspaceModeUseConfig
  /** Operation lifetime, aborted on withdrawal; release still follows actual settlement. */
  readonly signal: AbortSignal
  /** Recheck the captured authority before resource access or publication. */
  admit(): void
  /** Idempotent; invoke after all retained resource operations have settled. */
  release(): void
}
```

```ts type-equiv
/** Host-only transition intent; never accept a path or identity from the browser. */
interface WorkspaceModeChange {
  readonly changeId: WorkspaceModeChangeId
  readonly workspaceId: WorkspaceId
  /** Canonical immutable project identity; not necessarily the runtime file root. */
  readonly project: string
  readonly from: WorkspaceMode
  readonly to: WorkspaceMode
  readonly previousRevision: number
}
```

```ts type-equiv
/** Durable coordinator decision, reused unchanged during retries. */
type WorkspaceModeChangeDecision = 'commit' | 'rollback'
```

```ts type-equiv
/**
 * Environment and file routing provider. Both methods are idempotent for changeId.
 * It must not re-enter the public mode coordinator while holding exclusivity.
 */
interface WorkspaceModeRuntime {
  /** Supported default, persisted modes, and the selected direction of pending recovery. */
  readonly supportedModes: readonly WorkspaceMode[]
  /**
   * Quiesce the old environment and stage complete target files, retaining a recoverable
   * source. Resolve only after all preparation writes settle. On rejection, retained
   * work must be settled or recorded for settle(change, 'rollback') to reconcile.
   * @param change - Durable transition identity and selected modes.
   * @param signal - Preparation lifetime before the durable decision.
   * @returns after preparation writes have settled.
   */
  prepare(change: WorkspaceModeChange, signal: AbortSignal): Promise<void>
  /**
   * Publish the selected environment/file routing and reconcile retained resources.
   * Commit follows a durable commit decision; rollback restores from-mode usability.
   * Must work after restart, without an in-memory result from prepare.
   * Resolve only when the selected mode is usable and all owned writes settle.
   * @param change - Original durable transition, including after restart.
   * @param decision - Persisted commit or rollback direction.
   * @param signal - Coordinator-owned settlement lifetime.
   * @returns after selected routing and all owned writes have settled.
   */
  settle(
    change: WorkspaceModeChange,
    decision: WorkspaceModeChangeDecision,
    signal: AbortSignal,
  ): Promise<void>
}
```

```ts type-equiv
/** Trusted Host API: ctx.workspaceRegistry.modes. */
interface IWorkspaceModes {
  /**
   * Read committed metadata, including transitional states; does not authorize or open resources.
   * @param workspaceId - Original registration identity.
   * @returns its durable mode snapshot.
   */
  get(workspaceId: WorkspaceId): WorkspaceModeConfig
  /** @returns Modes the active runtime can prepare, or an empty list without a runtime. */
  supportedModes(): readonly WorkspaceMode[]
  /**
   * Register exactly one runtime adapter; its async disposer stops admission and drains owned work.
   * @param runtime - Provider supporting the default and all retained modes.
   * @returns an idempotent asynchronous disposer.
   */
  registerRuntime(runtime: WorkspaceModeRuntime): () => Promise<void>
  /**
   * Exclusive, revision-checked asynchronous change. Uses coordinator-owned settlement
   * after a durable decision; caller cancellation must not abandon pending recovery.
   * @param request - Target mode and previously observed revision.
   * @param options - Captured authority and caller lifetime.
   * @returns the settled durable configuration.
   */
  setMode(
    request: WorkspaceSetModeRequest,
    options: WorkspaceModeOperationOptions,
  ): Promise<WorkspaceModeConfig>
  /**
   * Retry the existing durable intent without changing its identity or decision.
   * Trusted maintenance only; no Remote endpoint. Concurrent recovery is deduplicated.
   * A ready workspace without an intent returns unchanged; quarantined storage refuses.
   * @param workspaceId - Original registration with retained intent.
   * @param options - Trusted maintenance authority and caller lifetime.
   * @returns its reconciled durable configuration.
   */
  recover(
    workspaceId: WorkspaceId,
    options: WorkspaceModeOperationOptions,
  ): Promise<WorkspaceModeConfig>
  /**
   * Acquire shared resource use after earlier exclusive work settles. Recheck authority
   * after waiting. Rejections preserve business failure types; recovery-required refuses.
   * @param workspaceId - Original registration whose resources will be used.
   * @param options - Captured authority and caller lifetime.
   * @returns the stable routing lease, held until all resource work settles.
   */
  acquireUse(
    workspaceId: WorkspaceId,
    options: WorkspaceModeOperationOptions,
  ): Promise<WorkspaceModeUseLease>
}
```

## 工作区实体

消费方只看到 `Workspace` 接口；实现保持包内私有。

```ts type-equiv
/**
 * One workspace: a stable id over an existing directory, a display title, and
 * an ordered candidate account of sessions. Membership validates header cwd
 * against the workspace path, but preserves an existing account when its
 * fully qualified cwd is missing. Consumers only see this interface; the
 * implementation stays private.
 */
interface Workspace {
  /** Committed mode metadata and current operation admission state. */
  readonly modeConfig: WorkspaceModeConfig

  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Canonical directory path: the `fs.realpath` of the path given at create
   * time (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to the final path segment, or a filesystem root's own spelling; duplicates are allowed. */
  readonly title: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string

  /**
   * Header-validated sessions in manually owned order: a new session is
   * prepended at attach, explicit reordering goes through
   * `insertSessionBefore`, and activity never reorders. The durable candidate
   * account is filtered synchronously: missing headers, invalid cwd values,
   * and canonical cwd mismatches are never returned. A fully qualified cwd
   * whose realpath or directory stat fails with ENOENT preserves an existing
   * candidate, including a dangling symlink; other filesystem failures do not.
   * A subsequent mutation prunes filtered candidates, not missing-directory
   * candidates. This does not admit new sessions or recreate directories.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Prepend a session to this workspace's candidate account. An already
   * accounted id resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs. A new id's
   * live or persisted
   * header cwd must resolve to an existing directory equal to {@link path};
   * unknown ids, missing or invalid cwd values, and mismatches reject without
   * writing.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Move an accounted session within the manual order, DOM-insertBefore-like:
   * with an anchor the session lands before it, without one it appends to the
   * end. Only the moved id changes position. A session or anchor absent from
   * the account rejects without writing; a move to the current position
   * resolves without writing, aside from the durable filtered-candidate
   * prune every accepted mutation performs; decided on the domain write
   * chain.
   * @param sessionId - The accounted session to move.
   * @param beforeSessionId - Accounted anchor to insert before; omitted appends.
   * @returns resolution after durability.
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. Idempotent: an id not on
   * the account resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs; decided on
   * the domain write chain like attach. Never touches the session's own stored log.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether {@link path} currently exists and
   * is a directory. A missing directory never mutates the record — the
   * directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
```

所有权的真源是记录中有序的 `sessionIds`，绝不从会话 cwd 派生。成员资格将记录的 header cwd 与工作区路径校验；已有候选的完全限定 cwd 在路径解析或目录 stat 时返回 `ENOENT`，仍保留其归属。这会保留目录缺失或符号链接失效时的记账关系，但不会接纳新会话。失败的写入会拒绝（`insertSessionBefore` 的账本错误以 `WorkspaceMoveInvalidError` 拒绝，存储失败以普通错误拒绝）；每次被接受的变更都盖上 `updatedAt` 时间戳，并持久修剪不再通过成员资格检查的候选项。

## 注册表：`ctx.workspaceRegistry`

`WorkspaceRegistry`（[签名](#ctxworkspaceregistry--workspaceregistry)）拥有注册与解析。`create(path, title?)` 要求完全限定路径并将其规范化，拒绝不存在的路径（原样传出原始 `ENOENT`）或非目录；当规范路径已被拥有时原样返回既有实体；否则创建一条标题为 `title ?? defaultWorkspaceTitle(path)` 的记录并前插到持久的注册表顺序中（不同规范路径可以共享同一显示标题，没有最终路径段时使用根路径拼写）。`get(id)` 与有序的 `list()` 是同步缓存读取；`resolveByPath(path)` 应用同一套完全限定 realpath 规范但不创建。`delete(id)` 只移除注册记录、顺序条目和会话账本——目录、用户文件、实时会话和已持久化日志一概不动，因此这些会话变为 Ungrouped（[参考](../../packages/workspace/workspace/README.zh.md)）；未知 id 返回 `false`。create 与 delete 会在其两次写入（记录 + 顺序）可能分叉之前先持久写入一个待定变更标记；启动时恰好解决被标记的那次变更——通过删除被标记的表行：这会补完被中断的 delete，并回滚被中断的 create（注册可以重建，因此回滚是安全方向）——而没有标记的顺序/表不一致则作为损坏大声失败。

会话的 cwd 在创建时由创建者赋予，而不是由本注册表赋予——API 网关从所选工作区的 `path` 解析新会话的 cwd（回退到显式或默认 cwd），先创建会话使 cwd 落入其不可变的 [`SessionHeader`](persistence.zh.md#sessionheader--metadata-beside-the-log)，再调用 `attachSession`，后者会把已存储的 header cwd 与工作区路径重新校验一遍。首次成功启动时，注册表仅凭已持久化的 header（`id`、`cwd`、`createdAt`——绝不读事件正文）引导历史：把规范 cwd 有效的会话按目录分组为工作区，最新的排在最前；「已初始化」标记最后写入，因此被中断的引导可以安全续跑。引导只发生这一次：没有 cwd 的历史遗留会话保持 Ungrouped，此后创建的会话只能通过 `attachSession` 加入工作区。

## 默认工作区初始化

控制器的 `initializeDefault` 不接受请求参数：它拥有固定目录名 `default-workspace`，解析 Documents 位置，并请求注册表执行一次初始化。注册表接收目录解析器，以所请求目录（而非规范路径）的最后一段作为初始标题，并将登记与持久化身份一起提交。语言不会传到 Host——浏览器消费方通过控制器的 `workspaceDisplayTitle` 为仍保留该自动标题的工作区加标签，因此只有屏幕上的名称跟随读者语言。[首次使用行为与配置](../../packages/api/workspace-controller/README.zh.md#first-use-workspace)说明复用和失败处理。

## 会话置顶

控制器的[传输类型](../../packages/api/workspace-controller/src/types.ts)定义了 `WorkspacePinSessionRequest` 和 `WorkspaceUnpinSessionRequest`，两者都携带一个 `sessionId`。两个操作都返回 `WorkspacePinValue`：完整的会话 id 数组 `pinnedSessionIds`，最近置顶的会话排在前面。置顶要求会话已知且未归档；对未置顶的 id 取消置顶会成功，且不改变集合。归档在同一次持久化写入中移除该会话的置顶，取消归档不会恢复置顶。

## 归档准入

归档是一个注册表全局的持久化集合，注册表拒绝把正在运行的工作藏在它后面。这条规则是本包声明并派发的两个宿主事件之上的能力接缝（[事件](#workspace-events)）：`workspace/session-activity`（waterfall）向已组合的提供方询问某会话还有什么在跑，`workspace/session-stop`（parallel）请它们停止这些工作。每个提供方像任何监听器一样在根上注册，因此本包不认识 agent、job 或 schedule 的词汇；各族是一个可合并扩展的 map 的键。

```ts type-equiv
/**
 * Activity families a `workspace/session-activity` listener may report. This
 * package declares none: each provider merges its own key from a module both
 * its Host and Client faces import, so a consumer that renders the families
 * sees exactly the keys its program compiled and falls through to a generic
 * description for any other. The shipped providers merge `turn` (the Agent
 * registry), `job` (the job registry seam), `subagent` (the Subagent
 * runtime), and `schedule` (the Schedule plugin).
 */
interface SessionActivityKindMap {}
```

`SessionActivityKind` 即 `keyof SessionActivityKindMap`，因此一个没有编译任何提供方的程序看不到任何键。随附的键放在各自 client 可导入的类型模块里：`turn` 在 Agent 注册表的 `types.ts`，`job` 在任务注册表接缝的 `view.ts`，`subagent` 在 Subagent runtime 的 `control-types.ts`，`schedule` 在 Schedule 插件的 `types.ts`；渲染各族的消费方为其分支导入这些模块，并为其他任何键保留一条通用文案。提供方通过把自己的 `SessionActivity` 条目前置到 `next()` 的结果来回答 waterfall；注册表最内层的回调返回空列表，因此没有提供方的组合可自由归档。

```ts type-equiv
/**
 * One reason a session counts as active for archive admission. Families with
 * per-item identity list their items so a caller can name what must stop.
 */
interface SessionActivity {
  readonly kind: SessionActivityKind
  /** Active items of the family; absent for a family without per-item identity (`turn`). */
  readonly items?: readonly SessionActivityItem[]
}
```

`SessionActivityItem` 携带各族自己的 `id`（会话、任务或提醒 id）和可选的展示 `label`。`archiveSession(sessionId)` 在存在性检查之后只询问 waterfall 一次，对非空答案以 `WorkspaceActiveSessionError`（`sessionId`、`activity`）拒绝且不写入；控制器把它映射为 `workspace/session-active` 错误，其 details 携带同样的两个字段。`archiveSession(sessionId, { stopActivity: true })`——`ArchiveSessionOptions` 的这个字段由传输请求以 `stopActivity` 暴露——跳过检查、先写入归档、再派发 `workspace/session-stop`；提供方抛错只记日志，归档保留，被停止的工作从不等待收敛。已归档的 id 既不询问也不停止。随附的提供方、它们停止什么，以及让已归档会话不跑模型步的 `agent/pre-step` 门禁，记录在[注册表包](../../packages/workspace/workspace/README.zh.md#api-behavior)；决策记录见 [archive-stops-running-work Agent Note](../../.agents/notes/implemented/feature/2026-09-21-archive-stops-running-session-work.zh.md)。

## 工作区上传

可选的[工作区上传服务](../../packages/api/workspace-upload/README.zh.md)接受已授权工作区标识对应的原始文件字节。它负责上传接纳和文件系统发布；注册表仍是目标目录的权威来源。

### WorkspaceUploadScope

`workspaceId: WorkspaceId` 标识已注册上传目标；调用方不提供主机路径。

### WorkspaceUploadLimits

`maxBytes: number` 是 `workspaceUpload/limits` 返回的部署单文件字节数包含式上限。

## 消费方

[`dsh-workspace-controller`](../../packages/api/workspace-controller) 经 `ctx.workspaceRegistry` 向 GUI 客户端提供工作区 CRUD，[`dsh-session-controller`](../../packages/api/session-controller) 执行上文「先建会话再 attach」的流程。[dsh-agent-instructions](../../packages/context/agent-instructions) 尽管名字如此，却**不是**消费方：它在 agent 自己的 cwd 下发现 AGENTS.md 风格的指令文件，从不触碰 `ctx.workspaceRegistry`——两者共用的这个词指的是用户的工作目录，而非本注册表的实体。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdirectorypicker--directorypicker-abstract-seam"></a>

### `ctx.directoryPicker` — `DirectoryPicker` (abstract seam)

Abstract directory-picking service. Subclass, implement `capability()`, and load the subclass as a plugin — it registers as `ctx.directoryPicker` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior). The capability object must be stable for the service lifetime: consumers may capture it across calls.

```ts cordis-catalog
/**
 * The backend's interaction capability.
 * @returns the discriminated capability consumers switch on.
 */
abstract capability(): DirectoryPickerCapability
```

Source: [`packages/host/directory-picker/src/index.ts`](../../packages/host/directory-picker/src/index.ts)

<a id="ctxdirectorypickercontroller--directorypickercontroller"></a>

### `ctx.directoryPickerController` — `DirectoryPickerController`

Host service backing the generated `ctx.remote.directoryPicker` namespace. The seam it exports is abstract and therefore never a Loader entry of its own, so this controller carries the wire verbs: one composed backend serves either the native chooser or the browse primitives, and a verb the composition cannot serve is refused rather than approximated.

```ts cordis-catalog
/**
 * Open the host's OS chooser for a Remote caller.
 * @param signal - caller lifetime; abort terminates the chooser.
 * @returns the chosen absolute path, or null when the operator cancels.
 */
@Remote('pick') async pick(signal: AbortSignal): Promise<string | null>

/**
 * List one directory level for a Remote caller's in-app browser.
 * @param path - absolute directory to list; absent lists the home directory.
 * @param signal - caller lifetime; abort stops the backend's scan instead of
 *   letting it outlive a disconnected caller.
 * @returns the level's listing with its ancestry.
 */
@Remote('list') async list(path: string | undefined, signal: AbortSignal): Promise<DirectoryListing>

/**
 * Create one child directory for a Remote caller's in-app browser.
 * @param path - absolute existing parent directory.
 * @param name - single non-blank path segment.
 * @returns the created directory's absolute path.
 */
@Remote('createDirectory') async createDirectory(path: string, name: string): Promise<string>
```

Source: [`packages/api/workspace-controller/src/directory-picker.ts`](../../packages/api/workspace-controller/src/directory-picker.ts)

<a id="ctxterminalcontroller--terminalcontroller"></a>

### `ctx.terminalController` — `TerminalController`

Typed Remote control of transient Session-owned terminal processes.

```ts cordis-catalog
/**
 * Read the Session's current directory and terminal limits without filesystem validation or shell lookup.
 * @param agent - Session owner supplied by the Gateway.
 * @param signal - request cancellation.
 * @returns the logged current directory and terminal limits; retained terminals keep their own process directories.
 */
@Remote environment(agent: Agent, signal: AbortSignal): TerminalEnvironment

/**
 * Discover installed shells in the Session's execution environment.
 * @param agent - Session owner supplied by the Gateway.
 * @param signal - request cancellation.
 * @returns verified profiles, with the configured or system default first.
 */
@Remote shells(agent: Agent, signal: AbortSignal): Promise<TerminalShell[]>

/**
 * List retained terminals without resolving or activating an Agent.
 * @param sessionId - displayed Session identity, including offline history.
 * @returns terminals retained for this Host lifetime.
 */
@Remote list(sessionId: SessionId): WebTerminalInfo[]

/**
 * Allocate a user shell once for a caller-generated identity, without Agent sandbox or approval restrictions.
 * @param agent - Session owner supplied by the Gateway.
 * @param request - initial dimensions and idempotency identity.
 * @param signal - allocation cancellation; committed terminals survive disconnection.
 * @returns the existing or newly committed terminal.
 */
@Remote async create(agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo>

/**
 * Retain an existing terminal for a window without activating its Agent or taking input control.
 * @param sessionId - owning Session identity, including an inactive saved layout.
 * @param id - retained Host terminal identity.
 * @param signal - physical Remote stream cancellation.
 * @returns a hold acknowledgement followed by an open lifetime stream.
 */
@Remote({ mode: 'stream' }) retain(sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame>

/**
 * Attach terminal input and output to one physical Remote stream.
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @param signal - attachment cancellation; the process remains alive and input is never replayed.
 * @returns screen recovery, output, writable state and provider-acceptance acknowledgements.
 */
@Remote({ mode: 'stream' }) attach(agent: Agent, id: WebTerminalId, signal: AbortSignal): RemoteStream<TerminalFrame, TerminalInput>

/**
 * Rename a terminal without changing its shell.
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @param title - nonempty display title, at most 120 characters.
 */
@Remote rename(agent: Agent, id: WebTerminalId, title: string): void

/**
 * Close an identity to future creation and kill its process range; repeated closes succeed.
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @returns after provider cleanup succeeds. A failure retains the terminal for retry.
 */
@Remote async close(agent: Agent, id: WebTerminalId): Promise<void>
```

Types: [Agent](core.zh.md) · [RemoteStream](typert.zh.md) · [SessionId](core.zh.md)

Source: [`packages/api/terminal-controller/src/index.ts`](../../packages/api/terminal-controller/src/index.ts)

<a id="ctxworkspaceartifacts--workspaceartifacts"></a>

### `ctx.workspaceArtifacts` — `WorkspaceArtifacts`

Optional Linux file provider; teardown cancels and awaits open requests and bodies.

```ts cordis-catalog
/**
 * List one authorized directory without revealing Host paths or starting a sandbox.
 * @param request - registered workspace identity.
 * @param path - slash-separated relative directory; empty names the root.
 * @param signal - caller lifetime, combined with provider withdrawal.
 * @returns bounded file metadata and the configured download cap.
 */
@Remote async list(request: WorkspaceArtifactScope, path: string, signal: AbortSignal): Promise<WorkspaceArtifactListing>

/**
 * Open an authorized stream shared by HTTP downloads and file previews.
 * @param workspaceId - registered workspace identity.
 * @param path - relative file path without traversal or symlinks.
 * @param signal - consumer cancellation.
 * @param peer - authenticated caller captured by Connection or Gateway.
 * @param maxBytes - consumer cap, further limited by the deployment download cap.
 * @returns the initial file extent and a body retaining its descriptor through settlement.
 * @throws ArtifactFailure for denied, invalid, missing, non-regular or oversized files.
 */
async openDownload( workspaceId: WorkspaceId, path: string, signal: AbortSignal, peer: PeerScope, maxBytes: number, ): Promise<WorkspaceFileDownload>
```

Types: [WorkspaceFileDownload](filesystem.zh.md)

Source: [`packages/api/workspace-artifacts/src/index.ts`](../../packages/api/workspace-artifacts/src/index.ts)

<a id="ctxworkspacecontroller--workspacecontroller"></a>

### `ctx.workspaceController` — `WorkspaceController`

Host service backing the generated `ctx.remote.workspace` namespace.

```ts cordis-catalog
/**
 * Read committed Workspace mode metadata after ownership checks.
 * @param request - Workspace to read.
 * @returns Committed mode metadata and available modes after access checks.
 */
@Remote('getMode') async getMode(request: WorkspaceGetModeRequest): Promise<WorkspaceModeOptionsValue>

/**
 * Set an unlocked Workspace mode while preserving its original caller and registration.
 * @param request - Target mode and observed revision.
 * @param signal - Caller cancellation before commit.
 * @returns ready metadata after runtime settlement and durable publication.
 */
@Remote('setMode') async setMode(request: WorkspaceSetModeRequest, signal: AbortSignal): Promise<WorkspaceModeValue>

/**
 * Create or idempotently resolve one Workspace over an existing directory.
 * @param request - directory path to register.
 * @returns the Workspace and whether this call created it.
 */
@Remote('create') async create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue>

/**
 * Initialize or reuse the default Workspace during first-use startup. The
 * directory name is fixed, so the Host never renames or relocates an
 * existing default; its initial title is that same name, which browser
 * consumers label in the reader's language.
 * @param signal - caller lifetime; cancels native directory lookup.
 * @returns the durable Workspace, or undefined when first-use initialization is ineligible; creates no Session or message.
 */
@Remote('initializeDefault') async initializeDefault(signal: AbortSignal): Promise<WorkspaceValue | undefined>

/**
 * Rename one Workspace to a unique non-blank title.
 * @param request - Workspace identity and proposed title.
 * @returns the updated Workspace projection.
 */
@Remote('rename') rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue>

/**
 * Remove one Workspace registration while retaining files and Sessions.
 * @param request - Workspace identity to remove.
 * @returns deletion confirmation.
 */
@Remote('delete') delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue>

/**
 * Move one Workspace within the registry display order.
 * @param request - moved Workspace and optional anchor.
 * @returns the complete resulting Workspace order.
 */
@Remote({ resources: { workspace: (request: WorkspaceInsertBeforeRequest) => [ request.workspaceId, ...request.beforeWorkspaceId === undefined ? [] : [request.beforeWorkspaceId], ], }, }) insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue>

/**
 * Move one accounted Session within a Workspace.
 * @param request - Workspace, Session, and optional anchor identities.
 * @returns the updated Workspace projection.
 */
@Remote({ resources: { session: (request: WorkspaceInsertSessionBeforeRequest) => [ request.sessionId, ...request.beforeSessionId === undefined ? [] : [request.beforeSessionId], ], }, }) insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue>

/**
 * Hide one known Session from Workspace grouping surfaces.
 * @param request - Session identity to archive.
 * @returns the complete resulting archive set.
 */
@Remote('archiveSession') archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue>

/**
 * Restore one archived Session to Workspace grouping surfaces.
 * @param request - Session identity to unarchive.
 * @returns the complete resulting archive set.
 */
@Remote('unarchiveSession') unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue>

/**
 * Surface one known unarchived Session ahead of unpinned Sessions.
 * @param request - Session identity to pin.
 * @returns the complete resulting pin set, most recently pinned first.
 */
@Remote('pinSession') pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue>

/**
 * Remove one Session's pin without changing its saved Session order.
 * @param request - Session identity to unpin.
 * @returns the complete resulting pin set, most recently pinned first.
 */
@Remote('unpinSession') unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue>

/**
 * Stream a complete Workspace baseline followed by ordered increments. A
 * non-owner receives only the Workspaces and Sessions `allows()` admits.
 * When a delivered Workspace is no longer admitted at its next change or
 * the next order change, the stream sends a `replace` frame with the
 * complete filtered state instead of a `remove`, because a Client never
 * resurrects a removed Workspace; a `remove` frame reports a deletion and
 * reaches only a Client that received that Workspace.
 * @param signal - generation cancellation.
 * @returns baseline followed by ordered Workspace increments.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame>
```

Source: [`packages/api/workspace-controller/src/index.ts`](../../packages/api/workspace-controller/src/index.ts)

<a id="ctxworkspacefiles--workspacefiles"></a>

### `ctx.workspaceFiles` — `WorkspaceFiles`

Host Remote file reads and workspace directory observations over the composed filesystem.

```ts cordis-catalog
/**
 * Read one page of lines from a UTF-8 file readable by the filesystem backend.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - absolute or workspace-relative path; user calls remain inside their registered workspace.
 * @param range - the line window; omitted fields take the page defaults.
 * @param signal - caller cancellation.
 * @returns the page, the file's version at the stat before it, and whether it reaches the last line.
 */
@Remote async read( workspaceFileScope: WorkspaceFileScope, path: string, range: WorkspaceFileRange, signal: AbortSignal, ): Promise<WorkspaceFileText>

/**
 * Read a complete regular file or one byte range without text decoding.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - target path, absolute or workspace-relative; relative to the base file's directory when provided.
 * @param options - optional base file and range; without a range the complete-file cap applies.
 * @param signal - caller cancellation.
 * @returns native bytes with the file's version and size at the preceding stat, byte offset, and EOF marker.
 */
@Remote async readBytes( workspaceFileScope: WorkspaceFileScope, path: string, options: WorkspaceByteReadOptions, signal: AbortSignal, ): Promise<WorkspaceFileBytes>

/**
 * Report one regular file's identity, version, and size without its content.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - absolute path or path relative to the workspace root; files outside it are allowed.
 * @param signal - caller cancellation.
 * @returns the file's absolute path, current version, and byte size.
 */
@Remote async stat(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat>

/**
 * List the direct children of one directory inside the Session's workspace.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - workspace path, absolute or relative to the workspace root.
 * @param signal - caller cancellation.
 * @returns the directory's children in the backend's stable name order, bounded by the entry cap.
 */
@Remote async list(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing>

/**
 * Watch one file or a directory's direct entries in the Session's filesystem.
 * Owner file watches use backend read authority; user watches and directories remain workspace-scoped.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - target path; the Host determines its type and confines user targets and directories.
 * @param signal - generation cancellation.
 * @returns `ready` once the target watch is active, then current metadata for queued and live invalidations.
 * @throws RemoteError when watching is unavailable or a directory is outside the workspace.
 */
@Remote({ mode: 'stream' }) changes(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame>
```

Source: [`packages/api/workspace-files/src/index.ts`](../../packages/api/workspace-files/src/index.ts)

<a id="ctxworkspaceregistry--workspaceregistry"></a>

### `ctx.workspaceRegistry` — `WorkspaceRegistry`

Durable workspace registry. Startup waits for `sessionPersistence`, builds one canonical-cwd header index, and completes the one-time history bootstrap before the service becomes active. The persistence dependency is mandatory so an unavailable peer can never be mistaken for an empty history and commit the initialized marker.

```ts cordis-catalog
/**
 * Create or reuse a workspace for an existing directory. The fully qualified
 * path is canonicalized through `fs.realpath`; a relative, nonexistent, or
 * non-directory path rejects. Repeated calls for the same canonical path
 * return the existing entity without changing its title.
 * A newly created workspace is prepended to the durable registry order.
 * Different canonical paths may share a display title.
 * @param path - Existing directory to own, in a fully qualified path spelling.
 * @param title - Display title used only when a new record is created.
 * @returns the existing or newly durable workspace.
 */
async create(path: string, title?: string): Promise<Workspace>

/**
 * Initialize the default Workspace only while both the registry and Session
 * history are empty. Repeated requests reuse its durable identity; deleting
 * that registration permanently disables automatic creation.
 * @param resolveDirectory - resolve the absolute directory; called only for
 * eligible creation, inside the registry mutation queue. Missing directories
 * are created recursively before registration, and the initial title is the
 * requested directory's own final segment — not the canonical one, so a
 * symlink at that path does not retitle the Workspace after its target.
 * After resolution, caller cancellation does not roll back creation or registration.
 * @returns the initialized Workspace, or undefined when automatic creation is ineligible.
 */
initializeDefault(resolveDirectory: () => Promise<string>): Promise<Workspace | undefined>

/**
 * Look up a workspace by id.
 * @param id - Workspace id.
 * @returns the workspace, or `undefined` when unknown.
 */
get(id: WorkspaceId): Workspace | undefined

/**
 * Trusted ordinary Session admission; the callback runs under exclusive mode coordination.
 * @param workspaceId - Original registration.
 * @param sessionId - Optional reusable Session identity.
 * @param create - Creation callback that reserves each identity before persisting it.
 * @param options - Captured authority and caller cancellation.
 * @returns the callback value after durable attachment and permanent mode locking.
 */
withSessionCreation<T>(workspaceId: WorkspaceId, sessionId: SessionId | undefined, create: (admission: WorkspaceSessionAdmission) => Promise<{ sessionId: SessionId; value: T }>, options: WorkspaceModeOperationOptions): Promise<T>

/**
 * Resolve accounting by permanent and pending identities, including currently filtered Sessions.
 * @param sessionId - Ordinary Session whose registration is required.
 * @returns its Workspace, or undefined when no registration owns the identity.
 */
findSession(sessionId: SessionId): Workspace | undefined

/**
 * Refuse messages before ordinary Session creation commits or pending recovery settles.
 * @param sessionId - Ordinary Session whose original registration must be ready.
 */
assertSessionReady(sessionId: SessionId): void

/**
 * Refuse single-mode forks and archives before any new log or activity stop.
 * @param sessionId - Source or archive target.
 * @param operation - Forbidden single-mode operation.
 */
assertSessionOperation(sessionId: SessionId, operation: 'fork' | 'archive'): void

/**
 * Synchronous workspace projection in durable registry order. Every
 * entity's `sessionIds` getter is already filtered by the startup/live
 * canonical-cwd header index; this method performs no persistence reads.
 * @returns a fresh ordered array of workspace entities.
 */
list(): Workspace[]

/**
 * Install a named deletion guard owned by this registry, replacing the same name without binding to the caller's lifetime.
 * The callback receives the registry's context and must resolve current services instead of retaining a disposable provider.
 * @param name - Stable plugin registration name.
 * @param guard - Middleware that remains installed until replacement or registry disposal.
 */
registerDeletionGuard( name: string, guard: (scope: Context, workspaceId: WorkspaceId, next: () => Promise<boolean>) => Promise<boolean>, ): void

/**
 * Delete one workspace registration while retaining its directory and every
 * session log. The durable order is updated before the table deletion; a
 * failed table write restores the prior order and keeps the entity
 * published. Composed deletion guards run before writes and may refuse the operation.
 * Unknown ids are an idempotent no-op and do not dispatch guards.
 * @param id - Workspace registration to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
delete(id: WorkspaceId): Promise<boolean>

/**
 * Move one workspace within the durable display order, DOM-insertBefore-like.
 * With an anchor it lands before that workspace; without one it appends.
 * @param id - Workspace to move.
 * @param beforeId - Workspace anchor; omitted appends.
 * @returns the complete committed workspace order.
 */
insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]>

/**
 * Archive one session durably. The session must exist (live or in session
 * persistence); its workspace accounting — or lack of one — is irrelevant.
 * Without `stopActivity` the session must also be inactive: the
 * `workspace/session-activity` waterfall is asked once, and any reported
 * activity rejects with {@link WorkspaceActiveSessionError} before anything
 * is written. With `stopActivity` the archive is written without an
 * activity check, and the `workspace/session-stop` providers are then asked
 * to stop the session's work: the durable archive set is what a provider's
 * `agent/pre-step` gate reads, so every wake the stops induce is already
 * blocked. Archiving drops the session's pin in the same durable write
 * (pinning and archival are mutually exclusive). An already archived id
 * resolves without writing, asking, or stopping.
 * @param sessionId - The session to archive.
 * @param options - Whether running work is stopped instead of refusing.
 * @returns resolution after durability and, with `stopActivity`, after every stop request was issued.
 */
archiveSession(sessionId: SessionId, options: ArchiveSessionOptions = {}): Promise<void>

/**
 * Unarchive one session durably by dropping it from the registry-global
 * archive set; the accounting slot was never touched, so the session
 * returns to its recorded position. Unarchiving runs no session-existence
 * check because removing an id cannot introduce an unknown one, so an
 * entry whose session is gone still resolves. An id that is not archived
 * resolves without writing.
 * @param sessionId - The session to unarchive.
 * @returns resolution after durability.
 */
unarchiveSession(sessionId: SessionId): Promise<void>

/**
 * Pin one session durably, prepending it to the registry-global pin set.
 * The session must exist (live or in session persistence) and must not be
 * archived. An already pinned id resolves without writing or reordering.
 * @param sessionId - The session to pin.
 * @returns resolution after durability.
 */
pinSession(sessionId: SessionId): Promise<void>

/**
 * Unpin one session durably by dropping it from the registry-global pin
 * set. Unpinning runs no session-existence check because removing an id
 * cannot introduce an unknown one, so an entry whose session is gone still
 * resolves. An id that is not pinned resolves without writing.
 * @param sessionId - The session to unpin.
 * @returns resolution after durability.
 */
unpinSession(sessionId: SessionId): Promise<void>

/**
 * Resolve by canonical directory path without creating or mutating a
 * workspace. A missing path rejects during `realpath`; an existing unowned
 * directory returns `undefined`.
 * @param path - Existing directory path in a fully qualified spelling.
 * @returns the workspace owning the canonical path, when one exists.
 */
async resolveByPath(path: string): Promise<Workspace | undefined>
```

Types: [SessionId](core.zh.md)

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)

<a id="ctxworkspaceupload--workspaceupload"></a>

### `ctx.workspaceUpload` — `WorkspaceUpload`

Host upload provider; resources belong to the operation and survive its cancellation cleanup.

```ts cordis-catalog
/**
 * Read the deployment byte limit for an authorized workspace.
 * @param request - workspace identity from the caller.
 * @param signal - caller cancellation, including browser provider withdrawal.
 * @returns inclusive per-file byte limit without exposing a host path.
 */
@Remote limits(request: WorkspaceUploadScope, signal: AbortSignal): WorkspaceUploadLimits
```

Source: [`packages/api/workspace-upload/src/index.ts`](../../packages/api/workspace-upload/src/index.ts)

<a id="workspace-events"></a>

### `workspace/*` events

<a id="workspacebefore-delete--waterfall"></a>

#### `workspace/before-delete` — waterfall

Guard one Workspace registration deletion before its durable writes. Providers may refuse by throwing and must await `next()` to hold their guard until deletion settles.

```ts cordis-catalog
/**
 * Guard one Workspace registration deletion before its durable writes.
 * Providers may refuse by throwing and must await `next()` to hold their guard until deletion settles.
 * @param workspaceId - Registration the trusted backend caller is removing.
 * @param next - Continue deletion and return whether the registration existed.
 * @mode waterfall
 */
'workspace/before-delete'(workspaceId: WorkspaceId, next: () => Promise<boolean>): Promise<boolean>
```

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)

<a id="workspacerecover-session--waterfall"></a>

#### `workspace/recover-session` — waterfall

Take over a pending ordinary Session before completing its Workspace registration.

```ts cordis-catalog
/**
 * Take over a pending ordinary Session before completing its Workspace registration.
 * @param sessionId - Durable pending identity, never a newly minted replacement.
 * @param next - Delegate to other lifecycle providers; false means no provider took ownership.
 * @mode waterfall
 */
'workspace/recover-session'(sessionId: SessionId, next: () => Promise<boolean>): Promise<boolean>
```

Types: [SessionId](core.zh.md)

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)

<a id="workspacesession-activity--waterfall"></a>

#### `workspace/session-activity` — waterfall

Ask the composed providers what still runs for a session before it is archived. A listener prepends its own SessionActivity entries to the result of `next()`; the registry's innermost callback returns an empty list, so a composition without providers archives freely. Any non-empty result refuses the archive without a write.

```ts cordis-catalog
/**
 * Ask the composed providers what still runs for a session before it is
 * archived. A listener prepends its own {@link SessionActivity} entries to
 * the result of `next()`; the registry's innermost callback returns an
 * empty list, so a composition without providers archives freely. Any
 * non-empty result refuses the archive without a write.
 * @param request - the session about to be archived.
 * @param next - delegate to the remaining providers.
 * @mode waterfall
 */
'workspace/session-activity'( request: SessionActivityRequest, next: () => Promise<readonly SessionActivity[]>, ): Promise<readonly SessionActivity[]>
```

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)

<a id="workspacesession-stop--parallel"></a>

#### `workspace/session-stop` — parallel

Stop a session's running work because the caller archived it with `stopActivity`; the archive set is durable when this dispatches. Each provider stops its own families — cancelling a turn, its subagent descendants, owned jobs, or active schedules — through the same cancel paths the user's own stop actions use, so the session log ends every open turn regularly and a later unarchive can continue the conversation. Listeners issue their stop requests without waiting for running work to settle; a listener may await its own durability barrier. A rejection is logged by the registry and does not undo the archive.

```ts cordis-catalog
/**
 * Stop a session's running work because the caller archived it with
 * `stopActivity`; the archive set is durable when this dispatches. Each
 * provider stops its own families — cancelling a turn, its subagent
 * descendants, owned jobs, or active schedules — through the same cancel
 * paths the user's own stop actions use, so the session log ends every
 * open turn regularly and a later unarchive can continue the
 * conversation. Listeners issue their stop requests without waiting for
 * running work to settle; a listener may await its own durability
 * barrier. A rejection is logged by the registry and does not undo the
 * archive.
 * @param request - the session being archived.
 * @mode parallel
 */
'workspace/session-stop'(request: SessionActivityRequest): Promise<void> | void
```

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)
<!-- END GENERATED cordis-surface -->
