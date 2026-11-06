---
description: "Authorize native workspace sandbox operations and call an independent local Runner."
kind: "package-reference"
---

# @deepseek-ai/dsh-harness-sandbox

English | [中文](README.zh.md)

## Summary

Open, query, and close workspace sandboxes after checking the authenticated native user's ownership and persistent directory record. Trusted backend integrations can also submit commands and request cancellation. The independent Runner owns container state and capacity. HTTP requests have bounded waits and validated results; unconfirmed modifications are never replayed or compensated automatically.

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

Use the optional [Web overlay](../../../apps/cli/config/examples/harness-sandbox.patch.yml) with the [deployment guide](../../../docs/user/guide/workspace-sandboxes.md). It enables existing multiuser login and this service, while retaining the multiuser restrictions on host tools. The Web process must not have Docker access; run the Runner separately.

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

The three Typert methods are `workspaceSandbox/open`, `workspaceSandbox/status`, and `workspaceSandbox/close`, carried by Connection POST `/api/<method>`. Their sole business argument is `request: { workspaceId }`. Use the existing login cookie and Connection Host/Origin checks. Extra fields, owner principals and calls without a user invocation are rejected. Results contain only `{ workspaceId, state }`; container identities and deployment paths never appear in management results.

Each call checks native ownership and the same Workspace Registry id. Opening also validates the saved path as an existing non-symlink direct child of the trusted root, then rechecks ownership before contacting the Runner. Queries and closure remain available when the registered directory is missing or moved. Unknown workspaces and cross-user access follow the native `remote-access/denied` policy; invalid business input uses `gateway/bad-request`.

`close` first authorizes, then synchronously revokes earlier message permits and cancels active and queued Agent input in that workspace. It waits for admitted directory validation and PUT requests before sending DELETE; new opens fail immediately while closing. Only a confirmed DELETE with no uncertain older mutation permits reopening. `status` reports local `closing` while this barrier exists; otherwise it queries the Runner for `closed`, `starting`, `running`, `closing`, or `cleanup_required`. Workspace registration, files and sessions remain intact.

Removing a native workspace registration requires a fresh Runner observation of `closed`. An admitted open or any other state refuses deletion with `workspace/sandbox-active` and `{ workspaceId, state }`; close the sandbox first. A failed query leaves registration and ownership intact. The deletion guard rejects new opens of that workspace until the registry write or rollback settles; other workspaces remain available. The registry owns the guard across manager unload and reload: it resolves the current active service and refuses native workspace deletion with `sandbox/failed` reason `runner_unavailable` while management is offline. Unloading the plugin waits for admitted deletion guards to settle, and reloading replaces the named guard without retaining the old service.

Runner failures use `sandbox/failed` with `{ reason, outcomeUnknown }`. Stable reasons distinguish `sandbox_capacity`, `sandbox_not_ready`, `sandbox_closing`, `sandbox_cleanup_required`, `sandbox_workspace_conflict`, `sandbox_name_conflict`, `sandbox_outcome_unknown`, `invalid_workspace_directory`, `docker_unavailable`, `runner_unavailable` and `runner_outcome_unknown`. Failed close retains its barrier and may be retried. An uncertain PUT or DELETE retains `closing` even after another DELETE: this protocol cannot prove a lost mutation has settled. Queries and plugin reloads do not clear this uncertainty. Messages omit raw Runner diagnostics, paths and stacks.

<a id="conversation-admission"></a>
### Conversation admission

The optional overlay also loads `@deepseek-ai/dsh-harness-sandbox/conversation`. It requires the native Session Controller, Agents and multiuser services. The `session/prompt-admission` listener captures the authenticated user and registered workspace before Agent recovery, opening or attachment waits. It rechecks native session/workspace ownership after preparation and immediately before synchronous inbox insertion. Preparation opens or reuses the workspace through `openForUser`; failure does not delete a shared container.

Pending duplicate `requestId` values share preparation. Accepted IDs remain deduplicated through durable inbox-insertion history, including inputs subsequently cleared from the queue. Cancelled, never-admitted IDs have separate process-local receipts and cannot restart on retry. Caller disconnect before insertion revokes preparation; disconnect after insertion leaves accepted work running. Ordinary Session stop retains its existing `keepInbox` behavior.

`ctx.sandboxConversation.forTurn(agent, turn)` returns a `SandboxExecutionPermit` for the exact original Agent, claimed message and turn, including authenticated identities, confirmed container, closing version and cancellation signal. Every call rechecks ownership and revocation; tools must also use that signal. It never opens a sandbox or borrows a newer message's permit. Conversation reload cancels existing managed input instead of reconstructing permits. Application-owned `workspaceSandboxState` retains close barriers and cancelled receipts across manager/conversation reloads; it does not persist them across process restarts or replace Runner container state.

<a id="runner-bash"></a>
### Runner Bash entry

`@deepseek-ai/dsh-harness-sandbox/bash` registers a foreground `bash` definition. Load it with the conversation and management services in a scope without another Bash registration. The supplied multiuser overlay replaces the standard preset with this entry and its persona, disables other shipped presets and host tools, and selects native execution. The default multiuser denial remains; the entry registers a caller-owned exception that checks the exact live definition, admitted step toolSet and original message permission. Same-name replacements, missing admission, nested dispatch and unload retain denial.

Arguments are `command`, `description`, optional `workdir` and integer `timeoutMs` (default 30000, range 1–60000). Extra arguments, including background, escalation and management fields, are rejected. Omitted directory, `.` and `/workspace` become Runner `.`; `src`, `./src` and `/workspace/src` become `src`. Outside absolute paths, Windows paths, `..` segments, malformed text and empty directories fail before exec. The command bytes are unchanged. Each independent call generates one UUID; the tool never opens a sandbox, invokes a host shell or collects host environment variables.

Agent step signals identify the original turn before asynchronous tool policy. The tool rechecks that turn's permission and admitted definition at dispatch. Different calls may run concurrently in the same container. Normal results retain known stdout/stderr, truncation and exit code; nonzero exit remains a successful tool result. The canonical value and terminal metadata use `/workspace` paths and omit internal identities. Rendering reuses the pure Bash output helpers and never infers a signal or a spill file.

The original exec wait remains open during cancellation. At most two cancel requests use independent deadlines; only an initial 404 while exec is unsettled permits the second attempt. Acknowledgements are not cleanup evidence. At most one unchanged exec retrieval is allowed: ordinary recovery requires a fresh matching running container and valid permission; cancelled recovery requires a validated cancellation acknowledgement proving the original record exists. A cancellation arriving during the status query cannot turn a running observation into permission to create a new execution. Every HTTP wait uses the transport's finite budgets.

Verified process cleanup preserves the container and other commands. Unconfirmed execution/cleanup enters `closeForUser` with `SandboxCloseTarget` containing the original container and close version. A changed version rejects before revocation; the close operation drains opens and checks the Runner identity before DELETE. A different or unidentifiable generation retains the barrier without deleting it. Failure reports and backend diagnostics preserve uncertainty; subsequent manual close can inspect and clean the workspace. `execution_limit` is an explicit error. Plugin unload cancels and drains its active calls before releasing listeners.

`activityForUser(userId, workspaceId)` returns local `SandboxActivity`: outstanding requests, openings, executions, closing and derived busy state. Requests cover preparation, queued input and model work through turn settlement; executions cover cancellation, retrieval and cleanup even after permission revocation. Management unavailability throws rather than reporting idle. Deletion protects these intervals; manager unload retains a close barrier while work remains. Releasing local work does not clear an unconfirmed closure. Consumers must recheck immediately before using the unified close operation; the query reserves nothing and adds no idle timer.

<a id="integration-handoff"></a>
### Integration handoff

| Consumer | Available entry | Remaining integration |
| --- | --- | --- |
| Conversation entry | The optional Web profile admits owned input and exposes only Runner Bash. | Deploy matched Harness/Runner builds, workspace paths and filesystem identities. |
| #8: idle reclamation | `activityForUser`, `statusForUser` and `closeForUser` for the persisted owner and workspace. | Add the 30-minute idle decision. |
| #9: Web controls | The three Typert methods, five states and typed `sandbox/failed` reasons. | Add controls and display. Failed close remains blocked; an unknown mutation requires maintenance to establish settlement, and a query cannot clear it. |

Each additional file, search or browser tool needs its own isolated implementation, exact-definition authorization, original-turn permission and cancellation handling before the overlay advertises it. File operations must resolve against the registered workspace inside the sandbox and preserve their actual results through logs, replay and presentation. The Bash exception does not authorize another definition or a host implementation with the same name.

Internal explicit-user methods accept only identities recovered by trusted backend code. They do not infer an owner from a missing invocation. The child `sandboxRunnerClient` service is transport only and must not be exposed as a user management API. Service disposal aborts local waits, waits for request connections and deadline timers to be released, and unregisters methods without sending DELETE or cancel; neither disconnect nor timeout confirms remote cleanup.

<a id="execution-transport"></a>
### Execution transport

After authorizing the initiating user, a backend consumer calls `ctx.sandboxRunnerClient.execute(workspaceId, request, signal?)` with a saved `RunnerExecutionRequest`: `executionId`, full `expectedContainerId`, unchanged `command`, relative POSIX `workdir` and integer `timeoutMs` from 1 to 60,000. The caller resolves the directory and command timeout before calling. The complete UTF-8 JSON request is limited to 64 KiB and the execution ID to 128 UTF-16 code units. The client never generates IDs, changes generations, opens a sandbox or retries. Explicit result retrieval calls `execute` with the same saved request only when the caller has established that doing so is safe.

`RunnerExecutionResult` preserves the execution ID, exit code and independent stdout/stderr text and truncation flags. Nonzero exit codes remain completed command results. `RunnerExecutionError` retains the Runner code, HTTP status and `execution` fields: matching execution/container identity, reason, cleanup and Bash status when known. Missing Bash status is not replaced with null or a fabricated exit. Other complete rejections, including `execution_limit`, remain `RunnerResponseError`; malformed, mismatched or incomplete responses and lost modification results use `RunnerRequestError`. An unknown result stops dependent work until the caller can establish the original outcome; the transport does not recover or replay it.

`ctx.sandboxRunnerClient.cancel(workspaceId, identity)` sends only the original `executionId` and `expectedContainerId` over its own bounded connection. It accepts no caller signal, so an aborted tool signal cannot prevent cancellation from being sent. `RunnerCancellationResult` distinguishes HTTP 202/requested from 200/settled; neither confirms that cancellation won or cleanup completed. A 404 or old-generation rejection preserves the original error and never creates an execution. The caller obtains the final result and cleanup evidence from the original execution path.

The optional execute signal cancels only the local wait; without it, service lifetime and `execTimeoutMs` bound that wait. Cancellation has its own `cancelTimeoutMs`, and Runner command supervision and cleanup use the Runner's independent settings. Both output streams can contain 64 KiB before JSON escaping; the separate exec response limit accommodates their complete encoded response. Disconnect, local deadline and disposal never imply that a remote command stopped.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [management service](src/index.ts) owns authorization, directory validation and browser-safe projection. [Application state](src/lifecycle.ts) coordinates close barriers; [permits](src/permits.ts) bind [conversation admission](src/conversation.ts) to real inbox events. The [transport child](src/transport.ts) owns the [HTTP client](src/runner-client.ts) and ties request settlement to disposal. [Wire settings](src/config.ts) separate lifecycle, execution and cancellation budgets; [execution validation](src/execution.ts) checks identities and results, while [management types](src/types.ts) declare sanitized browser values and errors.

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
- **Capabilities** — Only Runner Bash has a multiuser execution exception. File, search, PowerShell, background, terminal, browser and indirect tools require their own isolation before activation; idle timers and Web management controls remain separate integrations.
- **Uncertain mutations** — Lost PUT/DELETE outcomes require deployment maintenance to establish that old Runner requests have settled. This protocol cannot automatically clear that process-local barrier; restarting the Harness alone does not prove remote settlement.
- **Validation** — the [opt-in Docker acceptance fixture](../../../apps/cli/tests/profiles/harness-sandbox/fixtures/docker-acceptance.mjs) uses a controlled model and real authenticated Web and Runner profiles. It requires Linux, root for test setup, current built artifacts with Linux dependencies, Docker access, and the dedicated daemon-visible `/tmp/antfarm-issue7-m5` bind, selected with `M5_DATA_ROOT`; `M5_EVIDENCE_DIR` selects its evidence directory. Its isolated test deployment and containers are disposable; it establishes no real-model or Vultr result.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
