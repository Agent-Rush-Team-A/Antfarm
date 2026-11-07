# Process Sandbox

English | [中文](sandbox.zh.md)

The process-sandbox seam of [dsh-sandbox](../../packages/sandbox/sandbox) wraps a same-world subprocess argv in a file-effect policy without coupling consumers to a platform runner. [dsh-sandbox-local](../../packages/sandbox/sandbox-local) supplies Linux bwrap/Landlock, macOS Seatbelt, and the Windows ACL restricted-token backend; [dsh-bash-sandbox](../../packages/shell/bash-sandbox) and [dsh-pwsh-sandbox](../../packages/shell/pwsh-sandbox) consume it. [dsh-sandbox-ssh](../../packages/ssh/sandbox-ssh/README.md) applies the same policy through a remote backend paired with the SSH filesystem and subprocess providers.

Source: [`packages/sandbox/sandbox/src/index.ts`](../../packages/sandbox/sandbox/src/index.ts)

## Modes and enforcement

`SandboxMode` governs filesystem effects only. `read-only` asks the backend to deny writes — the POSIX runners additionally grant the `/dev/null` sink their shells require, while the Windows ACL runner grants no explicit writable root and reports partial enforcement for its ambient ACL gaps; `workspace-write` permits writes under the workspace root, explicit extra directories, and the backend's promised temp area; `danger-full-access` bypasses confinement. Network and process visibility are outside this vocabulary.

```ts type-equiv
/**
 * File-effect policy for confined processes. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace,
 * explicit extra roots, and backend-defined temp areas; `danger-full-access` bypasses confinement. Network
 * and process visibility are outside this vocabulary.
 */
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
```

Only the first two modes can be sent to a provider. A `danger-full-access` consumer spawns its original argv and does not call `ctx.sandbox`.

```ts type-equiv
/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

Enforcement is a reported fact. `full` means the backend governs every file effect promised by the mode; `partial` means an active backend or older kernel ABI governs only a subset, so consumers that require the absolute promise must reject or surface that distinction. Older Landlock ABIs and the Windows ACL runner's hard-link, unconfined-read, and AppContainer-ACL boundaries are current partial cases.

```ts type-equiv
/**
 * Enforcement completeness for this host. `partial` means an active backend or
 * older kernel ABI cannot govern every promised file effect; callers requiring
 * an absolute boundary must not treat it as `full`.
 */
type SandboxEnforcement = 'full' | 'partial'
```

## Per-call policy

The complete execution policy is resolved and carried per capability call. It includes `danger-full-access` so a consumer can resolve policy once before deciding whether to bypass confinement. Normal tool calls derive `workspaceRoot` from the calling session's immutable cwd; deployment configuration supplies the agentless fallback and explicit additional write grants. The resolver preserves absolute execution-world spelling. Enforcing providers canonicalize the root where the files exist, so a cwd containing `symlink/..` identifies the directory where the paired subprocess provider actually runs.

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

`ctx.sandboxPolicy.resolve()` accepts the active session and, for an approved retry, an explicit mode. The service owns precedence and root fallback so bash and fs do not repeat it.

```ts type-equiv
/** Inputs that select the sandbox policy for one capability call. */
interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}
```

Only a confined execution reaches `ctx.sandbox`; its provider policy narrows the mode while retaining the same root. This permits concurrent sessions, consumers, and one-shot escalated retries to ask the same provider for different boundaries without mutating provider state.

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

## Wrapped argv and classification dialects

`RunnerFailureRule` combines evidence that a runner failed before executing the command. A consumer requires a nonzero exit, the optional allowed-exit-code gate, and a case-insensitive fatal signature within one remaining stderr line. Case-insensitive exact full-line informational exclusions are removed first, so a benign runner notice cannot prove failure by itself. The matched line remains available as error detail; classification does not rewrite stderr.

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

`ConfinedArgv` is what the consumer spawns. Besides the replacement argv, it carries the backend's enforcement fact and two orthogonal stderr classifiers. `denialSignatures` identify the confined command being blocked while the sandbox works correctly. `runnerFailureRules` identify the sandbox runner refusing or failing before it executes the command; consumers check these first and surface a sandbox infrastructure failure, never an ordinary task failure.

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

The [local provider](../../packages/sandbox/sandbox-local/README.md) owns operator configuration and maps its runner dialect into these rules. The [sandboxed bash consumer](../../packages/shell/bash-sandbox/README.md) owns spawn and result attribution.

## Provider and fail-closed errors

`await ctx.sandbox.confine(argv, policy, signal)` resolves policy paths and returns a `ConfinedArgv` from the execution world, or rejects with `SandboxUnavailableError` and code `SANDBOX_UNAVAILABLE` when no usable backend exists. The optional signal cancels resolution before launch. Consumers may also classify a failure while spawning or observing the returned argv; that attribution belongs to the consumer contract. Silent unconfined passthrough is never legal for a confined policy.

Provider selection, probing, caching, and backend-specific enforcement reports belong to the [local provider](../../packages/sandbox/sandbox-local/README.md).

## Workspace containers

`RunningSandbox` includes the full Docker container ID. `ClosedSandbox` confirms the container is absent. `SandboxStatus` also covers opening, closing, and pending cleanup. See the [Docker Runner reference](../../packages/sandbox/sandbox-runner/README.md) for deployment and lifecycle behavior.

`SandboxExecutionIdentity` binds an execution ID to its expected full container ID. `SandboxExecutionRequest` adds canonical command arguments and a command budget. `SandboxExecutionResult` carries the execution ID, confirmed exit code, and retained stdout and stderr with truncation flags.

`SandboxCancellationResult` acknowledges a requested cancellation or an already settled execution; it does not confirm the termination reason or cleanup. `SandboxExecutionError.execution` carries `SandboxExecutionFailure`: the execution/container identity, observed reason, independently confirmed cleanup, and Bash status when known. Unknown results and executions interrupted by generation removal are distinct failures. The [Runner reference](../../packages/sandbox/sandbox-runner/README.md) owns cancellation, recovery and retry behavior.

<a id="workspace-sandbox-management"></a>
## Workspace sandbox management

`ctx.workspaceSandbox` authorizes native multiuser ownership and validates the registered persistent directory before calling the configured local Runner or SSH backend. `SandboxRequest` contains only `workspaceId`; `SandboxValue` returns that id and one of `closed`, `starting`, `running`, `closing`, or `cleanup_required`. Browser results omit container identities and paths; the optional `SandboxProgress` reports cloud phases and sanitized failures. `SandboxFailureReason` distinguishes capacity, cleanup, conflicts and unavailable or unconfirmed operations under `sandbox/failed`; a failed query never guesses a state. Explicit-user backend methods retain the full `RunnerRunningSandbox.containerId` for execution integration. See the [package reference](../../packages/sandbox/harness-sandbox/README.md) and [optional Web deployment](../user/guide/workspace-sandboxes.md).

The internal `ctx.sandboxRunnerClient` transport accepts a complete `RunnerExecutionRequest` bound to its original `RunnerExecutionIdentity`; `RunnerExecutionResult` retains the confirmed exit and output tails. `RunnerCancellationResult` is only an acknowledgement, while `RunnerExecutionError.execution` preserves `RunnerExecutionFailure` cleanup and known Bash status. Local aborts and transport deadlines never confirm remote cleanup. The transport adds neither user authorization nor model tools; the [package reference](../../packages/sandbox/harness-sandbox/README.md#execution-transport) owns request limits, independent budgets and safe result retrieval.

`SandboxActivity` contains `requests` (outstanding original input through turn settlement), `openings`, `executions` (including cancellation and cleanup), `closing`, and derived `busy`. The authorized `activityForUser` returns `SandboxIdleActivity`, adding activity `revision`, closing `version`, a process-local monotonic `idleSince` or null, and a `SandboxObservation` distinguishing confirmed running identity, confirmed closed and unconfirmed state. These internal fields never enter `SandboxValue`. The query does not refresh idle history, reserve a close decision or replace Runner status; unavailable management throws. Observation validity, settlement and reload behavior belong to the [package reference](../../packages/sandbox/harness-sandbox/README.md#runner-bash).

`SandboxIdleCloseTarget` combines `SandboxCloseTarget` with the observed activity revision and non-null monotonic idle start. The internal `closeIfIdleForUser` accepts that target, a validated idle threshold and the scan's lifetime signal; it owns the fresh Runner query and final synchronous close admission. `SandboxIdleCloseResult` distinguishes skipped without revocation/DELETE from confirmed closed; existing authorization and management failures remain errors. See [conditional idle close](../../packages/sandbox/harness-sandbox/README.md#conditional-idle-close) for ordering, duplicate calls and failure ownership.

The optional `@deepseek-ai/dsh-harness-sandbox/idle` plugin discovers native-owned candidates and schedules serial checks through the existing manager. The sandbox Web overlay loads it once at application scope. It retains failed observations, preserves close barriers and drains its lifetime on unload. Defaults, candidate ownership and failure behavior belong to the [idle reference](../../packages/sandbox/harness-sandbox/README.md#idle-reclamation).

## Workspace remote files

The [Workspace SSH backend](../../packages/sandbox/harness-sandbox/README.md#workspace-ssh) supplies files from the same execution generation as Bash. Trusted consumers enforce their original user and turn permissions and path policy, recheck `assertCurrent()` and pass the captured signal for every operation. Closing or losing that connection invalidates the capability; the local Runner does not substitute host files.

The [Workspace text entry](../../packages/sandbox/harness-sandbox/README.md#workspace-text-tools) applies these checks to native read/write/edit. It preserves native result rendering and optional observed-version policy, confines paths to the captured remote root, and separates observation keys by Workspace and generation. Helper closure waits for accepted file requests; cancellation does not roll back committed writes. The [Vultr backend](../../packages/sandbox/harness-sandbox/README.md#workspace-vultr) also supplies generation-bound web transfers and completed read-only copies through `ctx.workspaceFileAccess`.

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.md)

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

Types: [Session](session.md)

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

Types: [WorkspaceId](workspace.md)

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

Types: [WorkspaceId](workspace.md)

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
 * @param signal - Optional observer lifetime; abort suppresses history updates without cancelling the bounded query.
 * Omitted queries record normally.
 * @returns Local closing barrier, or fresh Runner state with internal container identity.
 */
async statusForUser(userId: UserId, workspaceId: WorkspaceId, signal?: AbortSignal): Promise<RunnerSandboxStatus>

/**
 * Inspect local work before an authorized idle-reclamation decision; does not query Runner or close anything.
 * @param userId - Authenticated initiating user.
 * @param workspaceId - Native workspace id.
 * @returns Work counts, activity revision, monotonic idle start and reliable container observation; unavailable management throws.
 */
activityForUser(userId: UserId, workspaceId: WorkspaceId): SandboxIdleActivity

/**
 * Query the original container and synchronously admit closure only while the observed interval is still idle.
 * @param userId - Authenticated backend owner; native authorization failures are preserved.
 * @param workspaceId - Native workspace id.
 * @param target - Original running identity, close version, activity revision and non-null idle start.
 * @param idleTimeoutMs - Positive idle threshold from validated deployment configuration.
 * @param signal - Scan lifetime, synchronously aborted on unload; does not cancel an already admitted close.
 * @returns Skipped without revocation or DELETE, or confirmed closure; management and Runner failures reject.
 */
async closeIfIdleForUser( userId: UserId, workspaceId: WorkspaceId, target: SandboxIdleCloseTarget, idleTimeoutMs: number, signal: AbortSignal, ): Promise<SandboxIdleCloseResult>

/**
 * Ends all commands in this container without deleting workspace files or sessions.
 * @param userId - Authenticated initiating user.
 * @param workspaceId - Native workspace id.
 * @param target - Optional original execution generation; stale cleanup cannot close a newer generation.
 * @returns Confirmed container absence.
 */
async closeForUser(userId: UserId, workspaceId: WorkspaceId, target?: SandboxCloseTarget): Promise<RunnerClosedSandbox>
```

Types: [UserId](typert.md) · [WorkspaceId](workspace.md)

Source: [`packages/sandbox/harness-sandbox/src/index.ts`](../../packages/sandbox/harness-sandbox/src/index.ts)
<!-- END GENERATED cordis-surface -->

The optional [Vultr provider](../../packages/sandbox/harness-sandbox/README.md#workspace-vultr) owns versioned cloud records, single-writer locking, snapshot-gated deletion and restoration. Its cloud-owned activity keeps cancelled preparations and persistent failure barriers visible to `activityForUser`; idle timing remains with its consumer. `RunnerClosedSandbox.reconciled` is an internal acknowledgement that original cloud mutation identities have been reconciled and the original VM is confirmed absent; only that acknowledgement can clear prior mutation uncertainty.
