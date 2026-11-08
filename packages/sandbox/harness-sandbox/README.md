---
description: "Authorize workspace execution through local Docker, fixed SSH or independent Vultr VMs."
kind: "package-reference"
---

# @deepseek-ai/dsh-harness-sandbox

English | [中文](README.zh.md)

## Summary

Open, query, and close workspace sandboxes after checking the authenticated native user's ownership and persistent directory record. Trusted backend integrations can also submit commands and request cancellation. The selected backend owns execution state; the local Runner also owns container capacity. Local HTTP requests have bounded waits and validated results; unconfirmed modifications are never replayed or compensated automatically.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add the optional [Web overlay](../../../apps/cli/config/examples/harness-sandbox.patch.yml) to Antfarm's default `start:web` or `dev:web` command using the [deployment guide](../../../docs/user/guide/workspace-sandboxes.md). The default entry supplies multiuser login and file services; this overlay adds sandbox management, authenticated message preparation and foreground Runner Bash. The multiuser restrictions on host tools remain in effect. The Web process must not have Docker access; run the Runner separately.

```yaml
- id: workspace-sandbox
  name: '@deepseek-ai/dsh-harness-sandbox'
  config:
    socketPath: /run/agentrush-sandbox/runner.sock
    workspaceRoot: /srv/agentrush/workspaces
```

The composition must also load native multiuser, Workspace Registry, Typert and Remote Access services. `workspaceRoot` must match the canonical root used by multiuser allocation and the Runner. New multiuser directories use mode 0700; configure the container's non-root UID to match the Harness allocator, and grant the Runner traversal and mount access during deployment. Opening a sandbox never changes directory permissions or migrates files.

| Setting | Value |
| --- | --- |
| `socketPath` | Required absolute local Runner socket; never supplied by a browser. |
| `workspaceRoot` | Required absolute persistent root; no default. |
| `queryTimeoutMs` | Total GET deadline, default 15,000 ms. |
| `mutationTimeoutMs` | Total PUT/DELETE deadline, default 120,000 ms. |
| `maxResponseBytes` | Maximum complete lifecycle/cancel response body, default 8192 bytes. |
| `execTimeoutMs` | Total exec transport deadline, default 120,000 ms; independent of the command timeout. |
| `cancelTimeoutMs` | Total cancel deadline, default 15,000 ms; independent of an aborted exec wait. |
| `maxExecResponseBytes` | Maximum complete exec response body, default 1 MiB, including JSON escaping. |

The three Typert methods are `workspaceSandbox/open`, `workspaceSandbox/status`, and `workspaceSandbox/close`, carried by Connection POST `/api/<method>`. Their sole business argument is `request: { workspaceId }`. Use the existing login cookie and Connection Host/Origin checks. Extra fields, owner principals and calls without a user invocation are rejected. Results contain `{ workspaceId, state }` with optional cloud `progress`; container identities and deployment paths never appear in management results.

Each call checks native ownership and the same Workspace Registry id. Opening also validates the saved path as an existing non-symlink direct child of the trusted root, then rechecks ownership before contacting the Runner. Queries and closure remain available when the registered directory is missing or moved. Unknown workspaces and cross-user access follow the native `remote-access/denied` policy; invalid business input uses `gateway/bad-request`.

`close` first authorizes, then synchronously revokes earlier message permits and cancels active and queued Agent input in that workspace. It waits for admitted directory validation and PUT requests before sending DELETE; new opens fail immediately while closing. Only a confirmed DELETE with no uncertain older mutation permits reopening. `status` reports local `closing` while this barrier exists; otherwise it queries the Runner for `closed`, `starting`, `running`, `closing`, or `cleanup_required`. Workspace registration, files and sessions remain intact.

Deleting or archiving a native workspace stops its Session activity, blocks new resource admission, waits for existing mode leases to settle, and confirms sandbox cleanup before committing. Cleanup failure retains the registration and ownership; an unknown mutation requires provider reconciliation before it can be accepted as closed. The registry holds exclusive admission during `SandboxExecutionBackend.closeWorkspace`, so mode providers select the committed target without acquiring another lease. Archival retains files and Sessions and restoration starts no sandbox. The registry owns the deletion and archival guards across manager unload and reload; an unavailable manager refuses cleanup with `sandbox/failed` reason `runner_unavailable`.

Runner failures use `sandbox/failed` with `{ reason, outcomeUnknown }`. Stable reasons distinguish `sandbox_capacity`, `sandbox_not_ready`, `sandbox_closing`, `sandbox_cleanup_required`, `sandbox_workspace_conflict`, `sandbox_name_conflict`, `sandbox_outcome_unknown`, `invalid_workspace_directory`, `docker_unavailable`, `runner_unavailable` and `runner_outcome_unknown`. Failed close retains its barrier and may be retried. An uncertain PUT or DELETE retains `closing` even after another DELETE: this protocol cannot prove a lost mutation has settled. Queries and plugin reloads do not clear this uncertainty. Messages omit raw Runner diagnostics, paths and stacks.

<a id="workspace-ssh"></a>
### Workspace SSH backend

The optional [SSH overlay](../../../apps/cli/config/examples/harness-ssh.patch.yml) selects `backend: provided` and loads `@deepseek-ai/dsh-harness-sandbox/ssh` before management. Set `DSH_WORKSPACE_SSH_BINDINGS_JSON` to a JSON dictionary keyed by existing native WorkspaceId. Each entry contains a distinct externally managed `instanceId` and the [SSH connection settings](../../ssh/ssh/README.md#deployment-prerequisites), including an existing host alias, helper launch and digest, and absolute remote `workspace`. Keep private SSH keys in the OpenSSH configuration. Invalid or missing bindings refuse work; they never use the Harness host as a fallback.

Execution coordination, user authorization and Session storage stay on Harness. Each opened Workspace owns a private SSH service realm with matching file and subprocess providers. The VM needs the helper and Bash, without Docker or the full Harness. Native registered project paths remain on Harness; Bash relative directories resolve against the remote root. Model-facing cwd remains `/workspace`; using `/workspace` as the VM root also keeps `pwd` output usable as a subsequent absolute workdir. Command bytes and output are never rewritten.

Repeated opens share the same generation. Execution ids retain original requests and results; changed requests conflict, pre-dispatch cancellation prevents launch, and full record capacity refuses new ids without evicting mutation history. Timeout and cancellation await managed-process cleanup. SSH loss immediately revokes file leases, quarantines the generation and reports `cleanup_required`. Closing drains accepted executions and requires acknowledgement from the original helper before allowing a new generation. If acknowledgement is unavailable, verify remote cleanup externally before restarting the owning provider; reload alone is not cleanup evidence.

`files(workspaceId, containerId, signal)` returns the captured generation's filesystem, remote root, abort signal and `assertCurrent()`. Trusted consumers retain original user/turn authority, recheck it and the lease before each operation, pass the lease signal, and enforce their path policy. The backend does not register model tools. The local Runner refuses file capability requests instead of accessing host files.

SSH close releases the helper and its managed processes; it does not power off or delete the VM. The [Vultr backend](#workspace-vultr) supplies cloud allocation, snapshot preservation and Web transfers separately; idle timing remains a consumer policy. Bindings and execution receipts are process-local; endpoint isolation depends on correctly prepared distinct VMs and SSH aliases, not merely distinct `instanceId` strings. Shared-host SSH tests validate dispatch and directory separation, not VM isolation.

<a id="workspace-vultr"></a>
### Vultr Workspace VMs

The optional [Vultr overlay](../../../apps/cli/config/examples/harness-vultr.patch.yml) selects the legacy snapshot provider `@deepseek-ai/dsh-harness-sandbox/vultr` with deployment JSON in `DSH_VULTR_CONFIG_JSON`; use the [deployment guide](../../../docs/user/guide/workspace-vultr.md). This standalone entry retains its snapshot behavior for existing deployments and data export; Workspace VM modes use VFS instead. It keeps Runner coordination on Harness and assigns one bare VM per active Workspace. Private control credentials, region, plan, image and helper artifact are deployment choices. The first open imports registered files once; restored snapshots retain the execution environment. SSH and helper integrity must pass before work is accepted. Remote failure never selects host execution.

The cloud owner persists versioned metadata under private `stateRoot` and holds an exclusive kernel lock. Concurrent callers share preparation; startup reconciles recorded labels, VM ids and snapshot descriptions. It reconnects to verified instances recorded as running or starting without allocating another VM. A connection failure before the SSH runtime binds can be retried explicitly against the same instance. An unacknowledged creation is never replayed, and ambiguous or missing resources block dependent work. Provider unload rejects new work, drains accepted requests and SSH cleanup, then releases the lock while retaining cloud disks for reconciliation. Startup failure also releases ownership after cleanup. Browser-safe `SandboxValue.progress` exposes phases and sanitized failure categories, without VM ids or paths.

Closure revokes the original generation, stops commands and waits for the helper's write-quiescence acknowledgement. It produces a complete bounded file copy, confirms helper cleanup, flushes the guest disk and confirms stopped power state before snapshotting. Temporary errors reading an acknowledged snapshot are retried within the operation deadline. After restart, an interrupted close with a recorded snapshot and file copy continues against that same snapshot. Only a complete, durably recorded snapshot and copy authorize VM deletion. Save failure retains the source. A failed connection can be replaced during closure only after the cloud owner confirms the original VM is stopped. Explicit cloud reconciliation may clear the manager's unknown-mutation barrier; the local Runner's earlier conservative semantics remain unchanged.

The provider supplies `ctx.workspaceFileAccess`; upload and artifact APIs select it with `storage: provided`. Closed listings and downloads use the private read-only copy; an unopened Workspace has an empty view without writing lifecycle metadata. Uploads or execution restore a VM and renew its generation. A copied file is never executed on Harness. `maxInstances`, polling and deadline settings, `maxSavedBytes` and `maxSavedFiles` bound resource usage. Capacity counts pending creation, unknown creation outcomes and owned orphan instances; unknown creation keeps its reservation across restart until the original VM is reconciled and reclaimed. A complete new save replaces superseded snapshots; snapshot storage remains billable. The Vultr overlay enables the shared idle plugin and Web controls; this backend adds no separate timer.

File requests against a revoked cloud generation fail before admitting another VM open. Failed requests retain the VM and its recovery state until closure confirms preservation and cleanup.

The `/vultr` entry accepts these deployment settings. Keep credential files and `stateRoot` outside every registered project. Creation and snapshot restoration both install the pinned host key through cloud-init; readiness checks the current allocation label before installing the helper.

| Setting | Default | Meaning |
| --- | --- | --- |
| `apiKeyFile` | Required | Absolute private Vultr management-key file. |
| `stateRoot` | Required | Absolute private durable directory owned by one Harness. |
| `deploymentId` | Required | Stable 1–32 character identifier using letters, digits, `_` or `-`. |
| `region`, `plan`, `osId` | Required | Vultr region, plan and positive OS image id for initial creation. |
| `sshKeyFile` | Required | Absolute private client-key file; public key is derived locally. |
| `helperArchive` | Required | Absolute verified standalone-helper archive path. |
| `helperArchiveHash`, `helperHash` | Required | SHA-256 of the archive and its executable. |
| `remoteRoot` | `/workspace` | Absolute writable VM directory; keep it stable across restarts. |
| `apiEndpoint` | `https://api.vultr.com/v2` | HTTPS management endpoint; HTTP is permitted only for loopback tests. |
| `maxInstances` | `2` | Maximum simultaneous live or pending owned VMs, including orphans. |
| `requestTimeoutMs` | `30000` | Per-request API and helper deadline. |
| `operationTimeoutMs` | `1800000` | Total opening or preservation deadline. |
| `pollIntervalMs` | `3000` | Cloud and SSH readiness polling interval. |
| `maxInventoryPages` | `100` | Maximum pages per complete cloud inventory. |
| `maxApiResponseBytes` | `4194304` | Maximum complete management response body. |
| `maxSavedBytes` | `1073741824` | Aggregate bytes for initial import or one completed file copy. |
| `maxSavedFiles` | `100000` | Aggregate regular-file and directory entries per import or copy. |
| `maxExecutions` | `1024` | Maximum retained execution records per generation. |
| `maxOutputBytes` | `65536` | Retained command-output byte limit. |
| `graceMs` | `5000` | Managed-process termination grace period. |

Both Workspace VM modes use the registered project leaf under one [VFS workspace root](../../../team-docs/VULTR-VFS.md#执行-vm-的挂载和权限), with one shared UID/GID pool. The provider checks the live whole-volume mount and its tag. The first transition into a VM mode reserves an identity in private state and stages a complete file copy under that group. Publication makes the workspace binding permanent; switching between VM modes keeps that identity. Rollback removes staged files before releasing a new reservation. Web uploads, listings, and downloads use the verified VFS directory without starting an execution VM. Identity capacity counts retained workspace directories as well as active VMs; a deployment with 128 reserved identities cannot admit another binding once all 128 remain assigned.

Both VM allocation providers save the original generation, label, and volume before sending a create request. They verify instance ownership and Shared Memory Backing, then confirm the matching VFS attachment and its Mount Tag. Pinned SSH prepares and probes the guest's whole-volume mount and `/workspace` bind as the assigned task user. Only a verified helper on that generation admits commands and text files. Interrupted allocations remain in private state and count against capacity until cleanup confirms their disposition.

Single-session VM mode releases its VM after the last task reservation settles. Multi-session VM mode retains its VM across turns; manual closure, idle closure, Workspace archival, or deletion initiates release. Release fences the original helper, confirms task processes exited, synchronizes and unmounts the guest, then confirms VFS detachment and instance removal. Neither mode creates a whole-VM snapshot. Files remain in VFS; installed tools and configuration outside the workspace mount are lost when the VM is recreated. Harness startup and later admission reconcile retained records against the original label and resource IDs before permitting a new allocation.

<a id="workspace-text-tools"></a>
### Workspace text tools

The optional `@deepseek-ai/dsh-harness-sandbox/files` entry registers native `read`, `write` and `edit` alongside SSH Bash. The SSH overlay loads both entries in the standard preset and disables host filesystem tools. The text entry reuses [tool-fs](../../fs/tool-fs/README.md) schemas, prompts, line windows, literal matching, diff metadata and result rendering. Its native arguments remain available; undeclared extra arguments, including Workspace and generation overrides, are rejected. `readLimit`, `readMaxLineLength` and `readMaxBytes` use the native defaults and accept positive integers. Remote reads stream to avoid the helper's whole-file RPC limit.

Each call captures its exact tool definition, Agent, admitted turn and original message permission. The private filesystem maps native project cwd and `/workspace` paths to that generation's remote root. Relative paths retain remote filesystem resolution, including `symlink/..`; canonical paths outside the root are refused. Each operation rechecks permission and containment, and mutations additionally carry the remote workspace-write policy. Targets include Workspace and generation identity so observations cannot cross generations. No file call falls back to the Harness filesystem or selects a newer connection after cancellation.

Workspace SSH realms enable [confined text reads](../../ssh/fs-ssh/README.md#use-this-package). The Linux helper pins directories and the final file while opening them without following symlinks, so replacement after path validation cannot redirect a read outside the negotiated root. Streams release their handles on completion, failure, cancellation or early close. Workspace text reads require accessible Linux procfs and fail on unsupported remote hosts.

The existing optional `fs-observation-policy` continues to supply no-clobber and version guards; without it, native writes and edits retain unconditional behavior. Failed matches and stale guards leave bytes unchanged. Cancellation does not promise rollback of a mutation that already committed. Helper closure joins accepted file requests before acknowledging cleanup; lost acknowledgement blocks reuse. Unloading the text entry cancels and drains its calls and removes all three definitions. Web upload/download still needs the cloud migration's remote file adapter; this entry does not change those endpoints.

<a id="conversation-admission"></a>
### Conversation admission

The optional overlay also loads `@deepseek-ai/dsh-harness-sandbox/conversation`. It requires the native Session Controller, Agents and multiuser services. The `session/prompt-admission` listener captures the authenticated user and registered workspace before Agent recovery, opening or attachment waits. It rechecks native session/workspace ownership after preparation and immediately before synchronous inbox insertion. The validated readiness phase opens or reuses the captured backend; failure does not delete a shared multi-session environment.

Pending duplicate `requestId` values share preparation. Accepted IDs remain deduplicated through durable inbox-insertion history, including inputs subsequently cleared from the queue. Cancelled, never-admitted IDs have separate process-local receipts and cannot restart on retry. Caller disconnect before insertion revokes preparation; disconnect after insertion leaves accepted work running. Ordinary Session stop retains its existing `keepInbox` behavior.

`ctx.sandboxConversation.forTurn(agent, turn)` returns a `SandboxExecutionPermit` for the exact original Agent, claimed message and turn, including authenticated identities, confirmed container, closing version and cancellation signal. Every call rechecks ownership and revocation; tools must also use that signal. It never opens a sandbox or borrows a newer message's permit. Conversation reload cancels existing managed input instead of reconstructing permits. Application-owned `workspaceSandboxState` retains close barriers and cancelled receipts across manager/conversation reloads; it does not persist them across process restarts or replace Runner container state.

<a id="runner-bash"></a>
### Runner Bash entry

`@deepseek-ai/dsh-harness-sandbox/bash` registers a foreground `bash` definition. Load it with the conversation and management services in a scope without another Bash registration. The supplied multiuser overlay replaces the standard preset with this entry and its persona, disables other shipped presets and host tools, and selects native execution. The default multiuser denial remains; the entry registers a caller-owned exception that checks the exact live definition, admitted step toolSet and original message permission. Same-name replacements, missing admission, nested dispatch and unload retain denial.

Arguments are `command`, `description`, optional `workdir` and integer `timeoutMs` (default 30000, range 1–60000). Extra arguments, including background, escalation and management fields, are rejected. Omitted directory, `.` and `/workspace` become Runner `.`; `src`, `./src` and `/workspace/src` become `src`. Outside absolute paths, Windows paths, `..` segments, malformed text and empty directories fail before exec. An exec request exceeding the complete 64 KiB UTF-8 JSON limit returns `SANDBOX_INVALID_REQUEST` before dispatch, with an actionable size-limit message. The command bytes are unchanged. Each independent call generates one UUID; the tool never opens a sandbox, invokes a host shell or collects host environment variables.

Agent step signals identify the original turn before asynchronous tool policy. The tool rechecks that turn's permission and admitted definition at dispatch. Different calls may run concurrently in the same container. Normal results retain known stdout/stderr, truncation and exit code; nonzero exit remains a successful tool result. The canonical value and terminal metadata use `/workspace` paths and omit internal identities. Rendering reuses the pure Bash output helpers and never infers a signal or a spill file.

The original exec wait remains open during cancellation. At most two cancel requests use independent deadlines; only an initial 404 while exec is unsettled permits the second attempt. Acknowledgements are not cleanup evidence. At most one unchanged exec retrieval is allowed: ordinary recovery requires a fresh matching running container and valid permission; cancelled recovery requires a validated cancellation acknowledgement proving the original record exists. A cancellation arriving during the status query cannot turn a running observation into permission to create a new execution. Every HTTP wait uses the transport's finite budgets.

Verified process cleanup preserves the container and other commands. Unconfirmed execution/cleanup enters `closeForUser` with `SandboxCloseTarget` containing the original container and close version. A changed version rejects before revocation; the close operation drains opens and checks the Runner identity before DELETE. A different or unidentifiable generation retains the barrier without deleting it. Failure reports and backend diagnostics preserve uncertainty; subsequent manual close can inspect and clean the workspace. `execution_limit` is an explicit error. Plugin unload cancels and drains its active calls before releasing listeners.

`activityForUser(userId, workspaceId)` returns internal `SandboxIdleActivity`, extending `SandboxActivity` with activity `revision`, closing `version`, `idleSince` and `sandbox`. Manual opening is counted synchronously before mode or resource admission yields and remains counted through resource release. Requests cover preparation, queued input and model work through turn settlement; executions cover cancellation, retrieval and cleanup even after permission revocation. Actual registration and settlement synchronously change the revision, independently of the closing version. Repeated releases and duplicate input do not create another activity change. Management unavailability throws rather than reporting idle; deletion protects outstanding work and uncertain closure.

`sandbox` distinguishes confirmed `running` with its full container identity, confirmed `closed`, and `unconfirmed`. `idleSince` is a process-local `performance.now()` timestamp, set only after the last work settles while a reliably observed container is running. Successful opening or a current status observation establishes the generation; repeated status polling does not refresh the start. Failed queries, non-running states, generation changes and management unavailability invalidate the old interval; late observations cannot overwrite new activity or a newer observation. Queries during an outstanding PUT do not establish its final state. Conversation reload preserves settled idle history; manager reload requires a fresh observation, and a process restart does not reuse timestamps. Provider-owned preparation, execution and cleanup also invalidate idle history; both close eligibility checks include that work. File activity after a closed observation re-enters discovery because an upload can restore a VM. A fresh running observation starts the next interval. These fields stay in trusted backend results, outside browser values.

<a id="conditional-idle-close"></a>
### Conditional idle close

Trusted backend consumers call `closeIfIdleForUser(userId, workspaceId, target, idleTimeoutMs, signal)`. `SandboxIdleCloseTarget` combines the observed running container's `containerId`, closing `version`, activity `revision` and non-null `idleSince`. The threshold comes from validated deployment configuration; the required signal belongs to the scan lifetime and must be aborted synchronously on unload. The method checks local eligibility before querying Runner, then rechecks native ownership, the active manager, the signal, the full observation and monotonic elapsed time after the query. Callers need no separate preflight status request.

`SandboxIdleCloseResult` is `{ state: 'skipped' }` when the interval is no longer eligible or the scan aborts before close admission, including while mode admission or the preflight query is pending, or `{ state: 'closed' }` after confirmed closure. Skipping does not revoke message permits, call Agent.cancel or send DELETE. The final check enters the existing synchronous close barrier without an intervening await. Work admitted first makes reclamation skip; messages arriving after the barrier keep the existing rejection and are not queued or resent automatically. Repeated idle calls skip the admitted barrier, while ordinary close joins its existing promise.

An admitted close retains the original full-container/closing-version checks before DELETE, workspace deletion protection, files and sessions. Aborting the scan after admission does not cancel this manager-owned operation. Authorization, unavailable management, Runner and resource cleanup failures retain their existing errors; a failure after admission retains the closing barrier rather than reporting a skip or successful close.

<a id="idle-reclamation"></a>
### Idle reclamation

The optional `@deepseek-ai/dsh-harness-sandbox/idle` function plugin belongs once at application scope. The supplied Web overlay loads it as `sandbox-idle`, outside Session presets; Web without this overlay does not require a Runner or load the reclaimer. Deployment overrides use this entry's validated configuration.

| Setting | Default | Valid values |
| --- | --- | --- |
| `idleTimeoutMs` | 1800000 ms (30 minutes) | Positive safe integer milliseconds. |
| `sweepIntervalMs` | 10000 ms (10 seconds) | Integer milliseconds from 1 to 2147483647. |

Startup discovers Workspace Registry entries with stored native owners. Authorized queries establish a fresh full idle interval for running containers without history; closed containers leave the candidate set. Normal activity and opening register candidates through application-owned state. Failed or invalidated observations stay pending for later bounded queries; recovery establishes an interval without closing in that round. Native workspace deletion removes its history, and late observations cannot recreate it.

Each sweep inspects candidates serially and schedules its next timer only after the round settles. Busy and not-yet-due candidates need no Runner query. Due candidates go through `closeIfIdleForUser`, which owns preflight and admission. One workspace's error does not stop the rest. The existing query and mutation deadlines apply; the scanner never sends PUT, bypasses ownership, clears a closing barrier or retries a failed DELETE. Its warnings reach standard error without another logger plugin; failed closure reports retained `closing`, no automatic retry and required maintenance. The warning sink remains available until admitted management settles on unload, then is removed; unrelated loggers and debug messages are not forwarded. Cleanup-required observations also warn that maintenance is needed.

Unload synchronously aborts the scan lifetime and clears its timer, then drains its pending round and any admitted manager-owned close. `statusForUser` accepts an optional observer signal: abort suppresses history updates without cancelling the bounded query; omission records normally. Reloading only the scanner preserves reliable application history. Manager replacement invalidates history through its own provider token, and process restart requires fresh discovery. Unload does not close other containers.

<a id="integration-handoff"></a>
### Integration handoff

| Consumer | Available entry | Remaining integration |
| --- | --- | --- |
| Conversation entry | The optional Web profiles admit owned input and expose Bash through the selected backend. | Prepare the configured Runner or SSH endpoint, execution directory and filesystem identity. |
| #8: idle reclamation | The optional Web overlay discovers owned candidates and performs conditional idle closure through the selected backend with validated timings. | Validate the deployment's actual reclamation, capacity release and persistent-file continuation. |
| #9: Web controls | The optional overlay enables the Web panel over the three Typert methods, five states and typed `sandbox/failed` reasons. | Failed close remains blocked; an unknown mutation requires maintenance to establish settlement, and a query cannot clear it. |

Each additional file, search or browser tool needs its own isolated implementation, exact-definition authorization, original-turn permission and cancellation handling before the overlay advertises it. File operations must resolve against the registered workspace inside the sandbox and preserve their actual results through logs, replay and presentation. The Bash exception does not authorize another definition or a host implementation with the same name.

Internal explicit-user methods accept only identities recovered by trusted backend code. They do not infer an owner from a missing invocation. The child `sandboxRunnerClient` service is transport only and must not be exposed as a user management API. Local Runner client disposal aborts local waits, waits for request connections and deadline timers to be released, and unregisters methods without sending DELETE or cancel; neither disconnect nor timeout confirms remote cleanup.

<a id="web-control-handoff"></a>
### Web control handoff

Automatic reclamation uses the existing `SandboxValue`: only `workspaceId` and one of the five states. `closed` does not identify the close cause; `running` does not report activity or an idle deadline. No countdown, container identity or backend timestamp is exposed. Status polling and viewing persistent files do not keep the container alive. After confirmed closure, a new message reopens the same workspace through normal preparation; the browser need not open it before every message.

Manual `close` revokes admitted and queued input. Idle reclamation checks continuous inactivity before admitting that close. A message arriving after the barrier receives the existing `gateway/cancelled` rejection; that code also covers other revocations and does not identify idle reclamation. Cancelled original request IDs remain revoked; continuation after closure uses a new request ID. `sandbox/failed` retains typed `reason` and `outcomeUnknown`: `sandbox_capacity` reports full deployment capacity without exposing other users' containers, while failed or uncertain closure must not be displayed as confirmed `closed`. Queries and manager reload do not clear an unknown-mutation barrier. Native ownership and disabled-account restrictions apply to every operation, including background checks.

<a id="execution-transport"></a>
### Execution transport

After authorizing the initiating user, a backend consumer calls `ctx.sandboxRunnerClient.execute(workspaceId, request, signal?)` with a saved `RunnerExecutionRequest`: `executionId`, full `expectedContainerId`, unchanged `command`, relative POSIX `workdir` and integer `timeoutMs` from 1 to 60,000. The caller resolves the directory and command timeout before calling. The complete UTF-8 JSON request is limited to 64 KiB and the execution ID to 128 UTF-16 code units. The client never generates IDs, changes generations, opens a sandbox or retries. Explicit result retrieval calls `execute` with the same saved request only when the caller has established that doing so is safe.

`RunnerExecutionResult` preserves the execution ID, exit code and independent stdout/stderr text and truncation flags. Nonzero exit codes remain completed command results. `RunnerExecutionError` retains the Runner code, HTTP status and `execution` fields: matching execution/container identity, reason, cleanup and Bash status when known. Missing Bash status is not replaced with null or a fabricated exit. Other complete rejections, including `execution_limit`, remain `RunnerResponseError`; malformed, mismatched or incomplete responses and lost modification results use `RunnerRequestError`. An unknown result stops dependent work until the caller can establish the original outcome; the transport does not recover or replay it.

`ctx.sandboxRunnerClient.cancel(workspaceId, identity)` sends only the original `executionId` and `expectedContainerId` over its own bounded connection. It accepts no caller signal, so an aborted tool signal cannot prevent cancellation from being sent. `RunnerCancellationResult` distinguishes HTTP 202/requested from 200/settled; neither confirms that cancellation won or cleanup completed. A 404 or old-generation rejection preserves the original error and never creates an execution. The caller obtains the final result and cleanup evidence from the original execution path.

The optional execute signal cancels only the local wait; without it, service lifetime and `execTimeoutMs` bound that wait. Cancellation has its own `cancelTimeoutMs`, and Runner command supervision and cleanup use the Runner's independent settings. Both output streams can contain 64 KiB before JSON escaping; the separate exec response limit accommodates their complete encoded response. Disconnect, local deadline and disposal never imply that a remote command stopped.

-----

<a id="workspace-modes"></a>
### Workspace modes

The optional `./modes` entry receives a trusted workspace mode coordinator, an explicit map of execution/file targets, and a transition runtime. Load independent targets in isolated service realms, then use the management entry with `backend: provided`. The mode entry also supplies `workspaceFileAccess`; HTTP upload/artifact entries use `storage: provided`. The [Loader test](tests/mode-loader.host.spec.ts) exercises explicit targets with the real registry coordinator and Docker. The entry supplies no mode or provider defaults.

The [Docker mode overlay](../../../apps/cli/config/examples/harness-docker-modes.patch.yml) loads `./docker-modes`, which supplies both Docker targets and durable directory transitions. Set `DSH_DOCKER_MODES_CONFIG_JSON` to Runner transport settings plus `workspaceRoot`, a private absolute `stateRoot`, `maxFiles` and `maxBytes`; set `DSH_MULTIUSER_WORKSPACE_ROOT` to the same root. Copy limits apply to the complete transition. The overlay sets the new-workspace default to `multi-docker`; choose another mode before the first Session. Optional `vultr` configuration enables both VFS VM targets; without it, loading rejects retained VM modes. Both VM targets require the same `volumeId` and `region`, separate private `stateRoot` directories, and trusted `vfsScriptsRoot` assets. Keep the default on a Docker mode. Optional `vultr.legacyMultiStateRoot` permits completed legacy file-cache import without altering the original records or snapshots; see the [deployment guide](../../../docs/user/guide/workspace-vultr.md#offer-vm-and-docker-modes-together). The allocator, Runner and container identity must share directory access.

For Docker targets, `./docker` uses the Runner transport settings plus `workspaceRoot`, without creating a nested container. It supplies native text access to that verified bind directory and displays paths under `/workspace`. The Harness allocator, Runner and container uid/gid must already agree. Persistent binary files use the verified directory provider independently of container lifetime.

The mode entry reserves incoming work before coordinator or preparation waits, validates attachments before starting the environment, and retains the selected backend through inbox and turn settlement. Bash, native text tools, and binary streams retain their own cleanup under that same selection. The last single-session reservation destroys its captured environment; input received before deletion retains that generation, and input received during deletion waits for a fresh one. Manual lifecycle controls are refused for single-session modes. Multi-session modes keep manual and idle controls.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [management service](src/index.ts) owns authorization, directory validation and browser-safe projection. [Application state](src/lifecycle.ts) coordinates close barriers; [permits](src/permits.ts) bind [conversation admission](src/conversation.ts) to real inbox events. The [transport child](src/transport.ts) owns the [HTTP client](src/runner-client.ts) and ties request settlement to disposal. [Wire settings](src/config.ts) separate lifecycle, execution and cancellation budgets; [execution validation](src/execution.ts) checks identities and results, while [management types](src/types.ts) declare sanitized browser values and errors.


The [mode backend](src/mode-backend.ts) retains shared mode admission through message and resource settlement. [Directory resources](src/mode-directory-resources.ts) save complete bounded checkpoints and private recovery journals, stage files beside the target directory, and publish with synchronized renames. Rollback attempts destination cleanup and source restoration independently. Linux directory copies preserve setgid and sticky bits; publication retains the destination root permissions. Symlinks and special entries refuse directory preservation; incomplete copies never replace the workspace. Journals and backups remain until a ready, later coordinator revision authorizes collection.

VFS mode transitions quiesce the source VM before taking a bounded directory checkpoint. Target publication and rollback retain the verified ownership and shared workspace identity. Migration from the legacy snapshot provider requires a verified, durably published VFS import before any original snapshot is retired; interrupted imports retain the original records and data. See the [VM VFS upgrade guide](../../../docs/upgrade-guide/v0.2.2-alpha.3/vm-vfs-storage/guide.md) for operator actions.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Runner reference](../sandbox-runner/README.md) — lifecycle and persistent directories.
- [Multiuser reference](../../api/multiuser/README.md) — account and workspace ownership.
- [Sandbox subsystem](../../../docs/subsystems/sandbox.md) — generated service reference.

<a id="model-experience"></a>

## Model Experience

### Bash

#### What the model sees

Conversation admission prepares the sandbox before input reaches the model. The optional Bash entry exposes only foreground command arguments and retained command results. Its description uses `/workspace`, without management identities or host environment facts. The supplied overlay configures the Working Directory model display as `/workspace`, disables host file-policy context, result spilling and development/file-delivery guidance, and advertises only Bash; backend paths remain recorded.

#### Token effect

Mounting the Bash entry adds its schema and logged tool results. Normal outputs use the existing stdout/stderr layout, with accurate truncation and nonzero-exit markers. Each stream retains at most the Runner's 64 KiB tail; the overlay disables host `spill-policy` so results contain no host recovery path or instruction to use unavailable file tools. Lifecycle operations add no model tokens.

#### KV Cache effect

The stable tool description can share the prompt prefix; results append as ordinary tool history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Deployment** — the Runner requires Linux Unix sockets and a separately provisioned non-root filesystem identity. Windows named pipes support transport tests only.
- **Mode composition** — Deployments provide the coordinator and explicit backend mappings; shipped profiles do not activate `./modes` automatically. VM modes require a verified shared-filesystem execution provider. Uncertain allocation and removal outcomes block new VM generations until the provider reconciles the original resources.
- **Capabilities** — The Runner overlay exposes only Bash. SSH text files require the separate `./files` entry and generation-bound backend access. Search, PowerShell, background, terminal, browser and indirect tools still require isolation before activation. The Runner overlay enables Web management controls.
- **Legacy cloud retention** — Workspace registration deletion does not remove the standalone snapshot provider's retained snapshots or private copies. Deployment operators manage retention for deleted workspaces. Its closed download copy preserves only regular files and directories; symlinks and special entries remain available only in the full disk snapshot.
- **Cloud acceptance** — `DSH_VULTR_TEST_CONFIG` selects a private deployment JSON for [the opt-in real-cloud Loader test](tests/vultr-loader.e2e.ts). Run it with `pnpm exec vitest run --config vitest.e2e.config.ts packages/sandbox/harness-sandbox/tests/vultr-loader.e2e.ts`; `DSH_VULTR_TEST_EVIDENCE` optionally selects its report path. It creates two billable VMs and disk snapshots, checks real SSH and authenticated HTTP with a scripted model, and removes its uniquely tagged resources. It does not verify a live model provider or browser controls.
- **Idle scope** — Reclamation assumes one application instance managing its selected backend. It does not merge activity across Harness processes; the local Runner integration does not discover containers created directly through Runner after startup. Disabled accounts or missing ownership require maintenance; the background loop does not bypass native authorization.
- **Uncertain mutations** — Lost PUT/DELETE outcomes require deployment maintenance to establish that old Runner requests have settled. This protocol cannot automatically clear that process-local barrier; restarting the Harness alone does not prove remote settlement.
- **Validation** — the opt-in [conversation Docker fixture](../../../apps/cli/tests/profiles/harness-sandbox/fixtures/docker-acceptance.mjs) and [idle Docker fixture](../../../apps/cli/tests/profiles/harness-sandbox/fixtures/docker-idle-acceptance.mjs) use a controlled model and real authenticated Web and Runner profiles. They require Linux, root for setup, current built artifacts with Linux dependencies and Docker access. `M5_DATA_ROOT` must select the fixture's dedicated daemon-visible bind: `/tmp/antfarm-issue7-m5` for conversation or `/tmp/antfarm-issue8-m5` for idle; `M5_EVIDENCE_DIR` selects evidence output. The idle fixture uses 5000 ms idle and 100 ms sweep settings, independently checks Docker identities, capacity and retained files, and cleans its isolated deployment; nonzero child exits or exit signals fail acceptance. These fixtures establish no real-model or Vultr result.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
