# Antfarm workspace sandbox design

English | [中文](SANDBOX-DESIGN.zh.md)

After signing in to Antfarm, users work with files and sessions in their own workspaces. In Docker deployments, the Harness delegates Bash commands to a Runner on the same host. The workspace directory survives container removal. Vultr VM deployments run tools over SSH. Single-session VMs retain files on Vultr File System (VFS), while multi-session VMs save a disk snapshot and a private file copy when they close. A deployment can enable one backend or offer both Docker and Vultr VM modes. [Docker workspace guide](../docs/user/guide/workspace-sandboxes.md) · [Vultr workspace VM guide](../docs/user/guide/workspace-vultr.md)

## Components and terms

| Term | Meaning in Antfarm |
| --- | --- |
| Fork | The team's GitHub repository, derived from DeepSeek Harness. It contains the code referenced here and the version the team maintains for the hackathon. |
| DeepSeek Harness | The application between the Web UI and the model. It stores sessions, calls the model, and dispatches tools such as Bash when the model requests them. **Host** refers to the Harness backend. An **agent** calls the model and tools within a session. |
| Runner | The Docker execution service. It creates, reuses, and removes containers by workspace ID, runs Bash in the assigned container, and returns results to the Harness. |
| Sandbox | The execution environment assigned to a workspace. References to the Runner, containers, and Docker host below describe the Docker deployment. |
| Workspace | A place in the Web UI for task files and one or more sessions. Each session has its own conversation history, and all sessions in the workspace share the same files. |

For example, a user uploads `sales-details.xlsx` to workspace A and asks for monthly sales totals. The Harness identifies A as the workspace for the session. The Runner lists the files, reads the spreadsheet, and runs the analysis in A's sandbox. The user can download `monthly-summary.xlsx` from A's file list. If the sandbox is removed, the user can continue the task in A with the same files.

## What users can do in Docker workspaces

- **Work in separate accounts.** Users sign in with their own accounts and can access only the workspaces, sessions, and files they are authorized to use. Multiple sessions in the same workspace share files and keep separate conversation histories.
- **Manage personal inference credentials.** Users manage their credentials in the Web UI. The Harness checks authorization for the account making the inference request and uses that account's Vultr inference credentials. [Personal models guide](../docs/user/guide/personal-models.md)
- **Open a sandbox.** In multi-session Docker mode, each workspace can run one sandbox at a time. Click **Open sandbox** in the Web UI or send a message to open a closed sandbox before processing begins. The first start can take a moment.
- **Work with files and run commands.** The Docker overlay lets Bash list directories, read and write files, and run scripts. By default, `ls` lists the current workspace files. The Web UI uses separate endpoints for upload, listing, and download.
- **Close a sandbox and keep the results.** In multi-session Docker mode, users can close the sandbox from the Web UI, and Antfarm also removes it after 30 minutes of workspace inactivity. Conversation history, uploaded files, and generated files written to the workspace remain available.

Each Docker container mounts only its assigned workspace directory. Sessions in that workspace share the directory.

## How Bash reaches the Runner

| Component | Responsibility |
| --- | --- |
| Agent loop → native tool executor | The agent loop reads tool calls from the model response and dispatches them through `ctx.tools.execute`. The Harness records the calls and results as `tool/call` and `tool/result` so the model can see the results in its next step. [Dispatch][loop-tools] · [Tool context][tool-context] · [Result recording][tool-log] |
| `dsh-tool-bash` | The Standard preset enables `bash`. For local execution, the tool resolves the directory, permissions, and environment, then calls `ctx.shell.resolve` and `ctx.shell.execute`. The Docker overlay uses the Runner integration below. [Standard preset][preset] · [Bash tool][bash-tool] · [Result renderer][bash-render] |
| Docker Bash integration | The Harness dispatches authorized Bash requests before resolving the host directory and execution permissions. The Runner executes them in the workspace container. [Integration and parameters](../packages/sandbox/harness-sandbox/README.md) |
| Web file panel | The upload, list, and download endpoints each check workspace ownership and the file path. [Upload API](../packages/api/workspace-upload/README.md) · [List and download API](../packages/api/workspace-artifacts/README.md) |

In `dsh-tool-bash.execute`, the Harness identifies the session and workspace for the call, then forwards the command and cancellation signal to the Runner. The Web UI displays the result in the existing Bash tool card. [Bash dispatch][bash-tool] · [Execution context][tool-context]

## How sessions map to workspaces

When the Web UI creates a session from a workspace, it sends the workspace ID (`workspaceId`) to the backend. The backend checks the account's permissions, creates the session using the registered directory, and records which workspace owns it. The multi-user entry point requires an authorized workspace. [Multi-user permissions](../packages/api/multiuser/README.md) · [Session creation][session-create] · [Workspace registry][workspace-registry]

The Harness routes commands from the session to its workspace and then to the sandbox. When a user creates a session or sends a message, the backend checks workspace access. Once it admits a new message, the Harness ensures the sandbox is open before processing it. For Bash calls, the Runner uses `workspaceId` to find the running sandbox. The tool returns an error if the workspace is invalid, the sandbox is closed, or the request has been cancelled. [Tool context][tool-context]

The workspace ID captures the user's choice directly. Routing uses that ID alone, with no separate task record, message tag, or classifier. Switching workspaces means opening a session in the destination workspace. Creating a new session in the original workspace reuses its running container.

## How files persist

The backend creates and registers one directory per workspace under the root shared by the Harness and Docker. The Runner bind-mounts that directory at `/workspace` so the container can read and write files directly. [Workspace registration API][workspace-create] · [Docker bind mounts][docker-bind] · [Docker storage][docker-volumes]

The model sees `/workspace` inside the sandbox. For example, `/workspace/monthly-summary.xlsx` is the same file as `monthly-summary.xlsx` in workspace A's Web file panel. The Harness interprets paths supplied by the model inside the sandbox. The Web backend separately checks user permissions and file paths for uploads, listings, and downloads.

The Web UI uses dedicated workspace file endpoints. When opening a file, the backend confines access to the registered directory and rejects symlinks that escape it. Downloads serve regular files only. [Workspace file API](../packages/api/workspace-artifacts/README.md)

The container mounts only its assigned workspace. The Harness code, SSH files, inference keys, and Docker socket stay outside the container. Docker containers share the host's Linux kernel. Antfarm can remove a container during manual closure, idle reclamation, or failure cleanup. [Hackathon isolation requirements][challenge] · [Docker security model][docker-security]

After removing a Docker container, the Runner reuses the same directory. Recovering an accidentally deleted file requires a copy made before the deletion. A shared VFS volume retains files independently of the execution environment. The multi-session Vultr VM backend saves a disk snapshot and a copy for Web downloads when it closes. [VFS workspace deployment](VULTR-VFS.md) · [Closing and restoring Vultr workspace VMs](../docs/user/guide/workspace-vultr.md#close-and-restore)

## How tasks use credentials and skills

The Harness uses the inference credentials for the account that owns the current request. It checks workspace access and credential access separately. It stores credentials outside the workspace and passes them to the selected inference transport. The sandbox receives only the data it needs for the task. [Personal credentials and inference authorization](../packages/api/user-credentials/README.md) · [Hackathon credential requirements][challenge]

A skill gives the agent instructions and may include scripts. The Harness can give the model reviewed skill instructions. Put programs or scripts required by the sandbox into the base image or provide read-only copies according to an allowlist. The model sees sandbox paths, and scripts run inside the sandbox. Each workspace receives only the files needed for its tasks.

## File operations with destructive effects

Bash runs as a non-root user and can delete or overwrite files it can write within the workspace. The Docker overlay rejects privilege escalation flags. Deletes and overwrites inside a script proceed without per-file confirmation. The sandbox confines these operations to the workspace. Keep backups of workspace files when recovery is required. [Docker Bash parameters](../packages/sandbox/harness-sandbox/README.md)

## Runner interface and container lifecycle

The Harness and Runner are separate services on the same VM. They exchange execution requests and results over a local Unix socket. Only the Runner uses the Docker Engine socket to create and manage containers. Workspace directories and session ownership come from the Harness registry. The Runner manages commands and container state and labels each container with its workspace so it can find leftover containers after a restart.

The manual and idle controls below apply to multi-session Docker. In single-session Docker mode, the container closes automatically after the task settles. [Docker task modes](../docs/user/guide/workspace-sandboxes.md#docker-task-modes)

| Operation | Behavior |
| --- | --- |
| Open sandbox | Manual opens and new messages use the same flow in multi-session Docker mode. If the workspace already has a running sandbox, the Runner reuses it. |
| Execute Bash | The Host supplies the verified `workspaceId`, `expectedContainerId`, `executionId`, and `command`, with optional relative `workdir` and `timeoutMs`. Commands with different execution IDs can start immediately in parallel and share the container's resource limits. Retries with the same execution ID and parameters within one container generation share the result. |
| Close sandbox | Cancel active and queued requests and commands, then remove the container. Sessions and files remain available. The sandbox can reopen once closure completes. |
| Read status | The Web UI shows workspace files and execution state. Container recreation details stay in execution records or the Web UI, outside model messages. |

The Runner starts and inspects commands through Docker and runs them from `/workspace` by default. The Harness uses the existing Bash result format for standard output, standard error, exit code, and timeout status. It marks truncated output. The model can use actual errors to correct a failed command. If a command's start is uncertain, the Runner prevents an automatic rerun. The hackathon version supports foreground execution without privilege escalation. [Docker Exec API][docker-exec] · [Bash result][bash-result]

- **Command completion.** The Runner uses the supervisor in the image to wait for the execution's process tree to be cleaned up. It then returns the actual exit code and output, including nonzero exits.
- **Command timeout or cancellation.** The Runner stops the command and its descendants by `executionId`. Once it confirms that cleanup, other commands can continue. If cleanup is uncertain, the Runner stops accepting executions for that container generation and attempts to remove it. The sandbox can reopen only after removal is confirmed. Removing the container ends other in-flight commands and leaves files already written to the workspace intact. [Runner process cleanup](SANDBOX-RUNNER.md#process-cleanup)
- **Idle reclamation.** The timer starts once the workspace has no session requests being processed and no commands running or being cleaned up. After 30 consecutive minutes without activity, Antfarm removes the container. An admitted request stops the timer, which restarts after the work finishes.
- **Manual closure.** When the user clicks **Close sandbox**, Antfarm marks active and queued requests as cancelled, stops commands, and removes the container. It rejects late tool calls from those requests even if the sandbox later reopens. The Web UI asks the user to wait while closure is in progress. Once closure completes, a manual open or a new message can start a new container. Generated files remain visible and downloadable.
- **Unexpected exit.** A workspace can have only one container at a time. The Runner must confirm removal of the old container before creating a new one. At startup it uses workspace labels to remove leftover containers.

The sandbox uses an image pinned by digest. Commands run as a non-root user, system directories are read-only, and networking is disabled. Docker keeps its default system call restrictions, drops all capabilities (`cap-drop=ALL`), and prevents privilege escalation (`no-new-privileges`). Each container is limited to 1 virtual CPU, 512 MiB of memory, 64 processes, and 32 MiB of temporary storage. A command can run for up to 30 seconds by default and up to 60 seconds at most. The Runner retains up to 64 KiB each of standard output and standard error. One Runner can host up to two sandboxes at once. [Runner image and limits](../packages/sandbox/sandbox-runner/docs/README.md)

If both slots are occupied and a third workspace requests a sandbox, the Web UI shows **Sandbox capacity is full. Close one or try again later.** The request fails immediately. Workspaces with a running sandbox can keep using it.

## Bash paths and Web files

The model can pass `/workspace/src` from `pwd` directly as `workdir` on its next Bash call. The Harness also accepts `src` and `./src`. It converts all three to `src`, the relative path the Runner receives. The Harness rejects absolute paths outside the workspace and paths containing a `..` segment before contacting the Runner. The file panel is rooted at the registered workspace directory, so `/workspace/src/result.xlsx` appears in the panel as `src/result.xlsx`. [Bash path rules](../packages/sandbox/harness-sandbox/README.md)

## Prepare a demo

Before the demo, decide how visitors will get accounts and which workspaces they can use. Check their access to sessions, files, and sandbox controls through the multi-user entry point. If the demo uses skills, check that the required programs and scripts are available in the container image. If the Docker deployment needs recovery from accidental deletion, set a retention period for workspace copies and decide who can restore them. [Guest workbench guide](../docs/user/guide/antfarm-guest-workbench.md)

## Verify the deployment

Use two accounts to verify workspace permissions. Check that each account can start its sandbox, run Bash against its own directory, and download results from the Web UI. Close and reopen the sandbox and confirm that the workspace files remain accessible. [Runner setup and local requests](SANDBOX-RUNNER.md)

[challenge]: https://lablab.ai/ai-hackathons/vultr-hackathon
[loop-tools]: ../packages/core/agent-loop/src/agent.ts#L587
[tool-context]: ../packages/core/tools/src/contracts.ts#L174
[tool-log]: ../packages/core/tools/src/batch.ts#L252
[preset]: ../packages/bundle/web-app/presets/standard.patch.yml#L5
[bash-tool]: ../packages/shell/tool-bash/src/index.ts#L478
[bash-result]: ../packages/shell/tool-bash/src/index.ts#L155
[bash-render]: ../packages/shell/tool-bash/src/render.ts#L28
[session-create]: ../packages/api/session-controller/src/commands.ts#L103-L141
[workspace-registry]: ../packages/workspace/workspace/src/index.ts#L373-L382
[workspace-create]: ../packages/api/workspace-controller/src/commands.ts#L91-L115
[docker-bind]: https://docs.docker.com/engine/storage/bind-mounts/
[docker-volumes]: https://docs.docker.com/engine/storage/volumes/
[docker-security]: https://docs.docker.com/engine/security/
[docker-exec]: https://docs.docker.com/reference/api/engine/version/v1.51/#tag/Exec
