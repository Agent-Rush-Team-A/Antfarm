# Workspaces

English | [中文](workspace.zh.md)

A workspace is the persistent record of a directory the user works in: a stable id over a canonical path, a display title, and the ordered account of sessions that belong to it. The subsystem is one package ([dsh-workspace](../../packages/workspace/workspace), `ctx.workspaceRegistry`) — an optional host-side capability, not part of the agent-loop spine, and invisible to models (no tools, no prompt text, no session events). It stores its records through the [storage domain form](storage.md) and validates session membership against [`SessionHeader.cwd`](persistence.md#sessionheader--metadata-beside-the-log), so `storageDomain` and `sessionPersistence` are mandatory startup dependencies: an unavailable persistence peer leaves the plugin pending rather than being mistaken for an empty history. Design record: [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md); bootstrap and GUI ordering: [Workspace UI product-flow Agent Note](../../.agents/notes/archived/feature/2026-07-25-workspace-ui-product-flow.md).

Source: [`packages/workspace/workspace/src/types.ts`](../../packages/workspace/workspace/src/types.ts)

## Identity

```ts type-equiv
/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
type WorkspaceId = Branded<'WorkspaceId'>
```

`WorkspaceId` is a [branded id](core.md#branded-ids). Path identity is separate: `realpathNormalize` (`fs.realpath`; trailing slashes, `..`, and symlinks resolved) is the one uniqueness canon — workspace paths are stored canonicalized, uniqueness is string equality of canonical paths (a symlink to an owned directory collides), and attach-time session cwd checks go through the same canon.

## Workspace modes

Mode metadata distinguishes permanent first-Session locking from current operation admission. The Host coordinator serializes creation and configuration changes with shared resource leases; runtime settlement follows the durable decision, and interrupted operations require trusted recovery. Runtime files and environment routing belong to the registered provider.

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

## The workspace entity

Consumers see only the `Workspace` interface; the implementation stays package-private.

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

Ownership truth is the record's ordered `sessionIds`, never derived from session cwd. Membership validates the recorded header cwd against the workspace path; an existing candidate remains owned when its fully qualified cwd fails resolution or directory stat with `ENOENT`. This preserves missing-directory and dangling-symlink accounts without admitting new sessions. Failed writes reject (`insertSessionBefore` account errors as `WorkspaceMoveInvalidError`, storage failures as plain errors); every accepted mutation stamps `updatedAt` and durably prunes candidates that no longer pass the membership check.

## The registry: `ctx.workspaceRegistry`

`WorkspaceRegistry` ([signatures](#ctxworkspaceregistry--workspaceregistry)) owns registration and resolution. `create(path, title?)` requires a fully qualified path, canonicalizes it, rejects a nonexistent path (the original `ENOENT`) or a non-directory, returns the existing entity unchanged when the canonical path is already owned, and otherwise creates a record with `title ?? defaultWorkspaceTitle(path)` prepended to the durable registry order (different canonical paths may share a display title, and a path with no final segment uses its root spelling). `get(id)` and the ordered `list()` are synchronous cache reads; `resolveByPath(path)` applies the same fully qualified realpath canon without creating. `delete(id)` removes only the registration, order entry, and session account — the directory, user files, live sessions, and persisted logs are never touched, so those sessions become Ungrouped ([reference](../../packages/workspace/workspace/README.md)); unknown ids return `false`. Create and delete persist a pending-mutation marker before their two writes (record + order) can diverge; startup resolves exactly the marked mutation — by deleting the marked table row, which completes an interrupted delete and rolls back an interrupted create (the registration is re-creatable, so rollback is the safe direction) — and an unmarked order/table mismatch fails loud as corruption.

Sessions get their cwd at create time from whoever creates them, not from this registry — the API gateway resolves a new session's cwd from the chosen workspace's `path` (falling back to an explicit or default cwd), creates the session so the cwd lands in its immutable [`SessionHeader`](persistence.md#sessionheader--metadata-beside-the-log), then calls `attachSession`, which re-validates that stored header cwd against the workspace path. On the first successful start, the registry bootstraps history from persisted headers alone (`id`, `cwd`, `createdAt` — never event bodies), grouping sessions with a valid canonical cwd into per-directory workspaces, newest first; the initialized marker is written last so an interrupted bootstrap resumes safely. The bootstrap is one-time: cwd-less legacy sessions stay Ungrouped, and sessions created afterwards join a workspace only through `attachSession`.

## Default Workspace initialization

The controller's `initializeDefault` takes no request: it owns the fixed `default-workspace` directory name, resolves the Documents location, and asks the registry to initialize once. The registry accepts a directory resolver, derives the initial title from the requested directory's final segment rather than the canonical one, and commits the registration with its durable identity. No language reaches the Host — browser consumers label a Workspace still carrying that automatic title through the controller's `workspaceDisplayTitle`, so only the on-screen name follows the reader's language. [First-use behavior and configuration](../../packages/api/workspace-controller/README.md#first-use-workspace) describe reuse and failure handling.

## Session pinning

The controller's [transport types](../../packages/api/workspace-controller/src/types.ts) define `WorkspacePinSessionRequest` and `WorkspaceUnpinSessionRequest`, each carrying one `sessionId`. Both operations return `WorkspacePinValue`: the complete `pinnedSessionIds` array of Session ids, most recently pinned first. Pinning requires a known, unarchived Session; unpinning an id that is not pinned succeeds without changing the set. Archiving removes the Session's pin in the same durable write, and unarchiving does not restore it.

## Archive admission

Archiving is a registry-global durable set, and the registry refuses to hide running work behind it. The rule is a capability seam over two Host events the package declares and dispatches ([events](#workspace-events)): `workspace/session-activity` (waterfall) asks the composed providers what still runs for a Session, and `workspace/session-stop` (parallel) asks them to stop it. Each provider registers on the root like any listener, so the package knows no agent, job, or schedule vocabulary; the families are keys of a merge-extensible map.

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

`SessionActivityKind` is `keyof SessionActivityKindMap`, so a program that compiled no provider sees no key at all. The shipped keys live in client-importable type modules: `turn` in the Agent registry's `types.ts`, `job` in the job registry seam's `view.ts`, `subagent` in the Subagent runtime's `control-types.ts`, `schedule` in the Schedule plugin's `types.ts`; a consumer that renders the families imports those modules for its cases and keeps a generic line for any other key. A provider answers the waterfall by prepending its `SessionActivity` entries to the result of `next()`; the registry's innermost callback returns an empty list, so a composition without providers archives freely.

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

`SessionActivityItem` carries the family-specific `id` (a session, job, or schedule id) and an optional display `label`. `archiveSession(sessionId)` asks the waterfall once, after the existence check, and rejects a non-empty answer with `WorkspaceActiveSessionError` (`sessionId`, `activity`) without writing; the controller maps it to the `workspace/session-active` error, whose details carry the same two fields. `archiveSession(sessionId, { stopActivity: true })` — the `ArchiveSessionOptions` field the transport request exposes as `stopActivity` — skips the check, writes the archive, then dispatches `workspace/session-stop`; a rejecting provider is logged and the archive stays, and the stopped work is never awaited to settlement. An already archived id neither asks nor stops. The shipped providers, what they stop, and the `agent/pre-step` gate that keeps an archived Session from running a model step are documented with the [registry package](../../packages/workspace/workspace/README.md#api-behavior); the decision record is the [archive-stops-running-work Agent Note](../../.agents/notes/implemented/feature/2026-09-21-archive-stops-running-session-work.md).

## Workspace upload

The optional [workspace upload provider](../../packages/api/workspace-upload/README.md) accepts raw file bytes for an authorized workspace identity. It owns upload admission and filesystem publication; the registry remains the authority for the target directory.

### WorkspaceUploadScope

`workspaceId: WorkspaceId` identifies the registered upload target; callers never provide its host path.

### WorkspaceUploadLimits

`maxBytes: number` is the deployment's inclusive per-file byte cap returned by `workspaceUpload/limits`.

## Consumers

[`dsh-workspace-controller`](../../packages/api/workspace-controller) serves workspace CRUD to GUI clients over `ctx.workspaceRegistry`, and [`dsh-session-controller`](../../packages/api/session-controller) performs the create-session-then-attach flow above. [dsh-agent-instructions](../../packages/context/agent-instructions) is **not** a consumer despite the name: it discovers AGENTS.md-style instruction files under an agent's own cwd and never touches `ctx.workspaceRegistry` — the shared word refers to the user's working directory, not to this registry's entities.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.md) · [RemoteStream](typert.md) · [SessionId](core.md)

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

Types: [WorkspaceFileDownload](filesystem.md)

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

Types: [SessionId](core.md)

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

Types: [SessionId](core.md)

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
