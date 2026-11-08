# Run the workspace sandbox Runner

English | [中文](SANDBOX-RUNNER.zh.md)

Start the Runner on Linux with a dedicated `sandbox-runner` profile. The Runner manages containers through the Docker Engine Unix socket. The Harness sends workspace requests through a separate Unix socket.

If the workspace root is on Vultr VFS, configure the shared volume and preflight checks before starting the Runner. [VFS workspace deployment](VULTR-VFS.md)

## Service accounts and directories

Run the Runner under the dedicated `agentrush-runner` account with `agentrush-sandbox` as its primary group. Add the Harness service account to `agentrush-sandbox`. On hosts where the Docker Engine socket is owned by `root:docker` with mode `0660`, grant supplementary `docker` group membership only to the Runner service. Check the Harness process's effective groups and the Docker socket ACL to confirm that the Harness has no direct Docker access.

The Runner must own its API socket directory. The shared group needs traversal permission without write permission, and other accounts need no access. The following systemd configuration creates `/run/agentrush-sandbox` and places the socket in the Runner's primary group. The Runner sets the socket to mode `0660`.

```ini
[Service]
User=agentrush-runner
Group=agentrush-sandbox
SupplementaryGroups=docker
RuntimeDirectory=agentrush-sandbox
RuntimeDirectoryMode=0750
EnvironmentFile=/etc/agentrush/sandbox-runner.env
ExecStart=/usr/local/bin/node /srv/deepseek-harness/apps/cli/lib/bin.js --profile sandbox-runner
```

Start only one Runner per deployment identifier. If the socket path is already in use, startup fails. After an unexpected exit in a deployment without systemd, confirm that the old service has stopped before removing its socket file.

## Prepare the profile

Build the repository artifacts on Linux. Set a dedicated `DSH_HOME` for the Runner, then copy the profile template and link the built package as the Runner account. The example assumes that the repository is at `/srv/deepseek-harness`.

```sh
repo=/srv/deepseek-harness
export DSH_HOME=/var/lib/agentrush-runner/dsh
profile="$DSH_HOME/profiles/sandbox-runner"
install -d -m 0700 "$profile/node_modules/@deepseek-ai"
cp "$repo/team-docs/sandbox-runner-profile/package.json" "$profile/package.json"
cp "$repo/team-docs/sandbox-runner-profile/cordis.patch.yml" "$profile/cordis.patch.yml"
ln -s "$repo/packages/sandbox/sandbox-runner" "$profile/node_modules/@deepseek-ai/dsh-sandbox-runner"
```

In the environment file, set `DSH_HOME`, a unique `DSH_RUNNER_DEPLOYMENT`, `DSH_RUNNER_IMAGE` to a pulled image pinned by digest, and `DSH_RUNNER_CONTAINER_UID` and `DSH_RUNNER_CONTAINER_GID` to non-root IDs. Set `DSH_RUNNER_DOCKER_SOCKET`, `DSH_RUNNER_SOCKET`, and `DSH_RUNNER_WORKSPACE_ROOT` as needed. Their defaults are `/var/run/docker.sock`, `/run/agentrush-sandbox/runner.sock`, and `/var/lib/agentrush-workspaces`, respectively. Create workspace directories under the data root in advance and grant the configured container UID and GID read and write access.

Place the workspace root outside the Docker data root. The Runner uses `rprivate` propagation for workspace bind mounts. Docker rejects this propagation mode for directories inside its data root. When the Runner itself runs in a container, it must see the workspace at the same absolute path as the Docker daemon. The Runner profile and control data can use separate volumes.

To start the Runner in the foreground with the same environment, run `node "$repo/apps/cli/lib/bin.js" --profile sandbox-runner`. The Runner accepts workspace operations after startup cleanup. If startup fails, for example because the Docker socket is unreachable, the CLI reports the cause on stderr and exits with code 1. If it receives `SIGTERM` during startup cleanup, the Runner cancels in-flight Docker requests and releases the API socket.

## Make local requests

This example uses workspace ID `A` and the pre-created directory `/var/lib/agentrush-workspaces/A`. When the Runner is integrated with the Harness, the Harness supplies the authorized workspace ID.

```sh
socket=/run/agentrush-sandbox/runner.sock
url=http://localhost/v1/workspaces/A/sandbox
curl --unix-socket "$socket" -X PUT -H 'Content-Type: application/json' \
  -d '{"workspaceDir":"/var/lib/agentrush-workspaces/A"}' "$url"
curl --unix-socket "$socket" "$url"
curl --unix-socket "$socket" -X DELETE "$url"
```

A successful request returns HTTP 200 and a JSON status. The `running` status includes the full `containerId`. An invalid workspace parameter or directory returns 400. A workspace conflict such as exhausted capacity returns 409 and a JSON `error` code. The capacity error is `sandbox_capacity`. If cleanup is still pending, Docker is unavailable, or the Runner cannot confirm the outcome, the request returns 503.

## Run and cancel Bash commands

The sandbox image must provide Python, `/bin/bash`, and a fixed, read-only supervisor. Follow the [supervisor image reference](../packages/sandbox/sandbox-runner/docs/README.md) for the build and startup requirements. Open the workspace with PUT, then use GET to retrieve the full `containerId` from the `running` status. Pass it as `expectedContainerId` in the Exec request. The example uses `jq` to build the request and runs a command in workspace A.

```sh
socket=/run/agentrush-sandbox/runner.sock
url=http://localhost/v1/workspaces/A/sandbox
container_id=$(curl -fsS --unix-socket "$socket" "$url" | jq -er 'select(.state == "running") | .containerId')
execution_id=$(cat /proc/sys/kernel/random/uuid)
jq -n --arg id "$execution_id" --arg container "$container_id" \
  '{executionId: $id, expectedContainerId: $container, command: "printf hello; printf warning >&2; exit 7"}' \
  | curl -sS --unix-socket "$socket" -H 'Content-Type: application/json' \
      --data-binary @- -w '\nHTTP %{http_code}\n' "$url/exec"
```

The example returns HTTP 200, exit code 7, and separate standard output and standard error. Bash commands with different execution IDs can start immediately in the same container and share its resource limits. If the caller disconnects, it can retry with the original execution ID, container ID, and request body. If the result is uncertain for the current container generation, query its status first. For `cleanup_required`, send DELETE and confirm closure. After reopening the sandbox, use a new container ID and execution ID. See the [Runner reference](../packages/sandbox/sandbox-runner/README.md#use-this-package) for field limits and errors.

To cancel an existing execution, use the same execution and container IDs. The cancellation request contains only those IDs and targets an existing record.

```sh
jq -n --arg id "$execution_id" --arg container "$container_id" \
  '{executionId: $id, expectedContainerId: $container}' \
  | curl -sS --unix-socket "$socket" -H 'Content-Type: application/json' \
      --data-binary @- -w '\nHTTP %{http_code}\n' "$url/exec/cancel"
```

An in-flight cancellation returns 202 with `requested`. A settled execution returns 200 with `settled`, which is the usual outcome for the short example above. To verify cleanup, wait for the original Exec request or retry it with the same parameters to obtain the final result. An unknown execution ID returns 404. A request for an old container generation returns 409. Execution failures include `error`, `executionId`, `containerId`, `reason`, `cleanup`, and `bash` when the Bash result is known. The Runner omits `bash` when that result is unknown. A cancellation with confirmed process cleanup returns 409 with `execution_cancelled`. A timeout returns 504 with `execution_timeout` if cleanup was confirmed or the Start request was never sent. When cleanup cannot be confirmed, the response is 503. Check `cleanup` to see whether the container was removed or cleanup remains unconfirmed. Other preparation and lifecycle failures include only `error`. The `sandbox_cleanup_required` error uses 503.

<a id="进程清理交接"></a>

## Process cleanup

The [Runner service](../packages/sandbox/sandbox-runner/src/index.ts) keeps in-flight executions, results, and failures in memory by execution ID for the current container generation. A failure before Start affects only that execution. Retrying with its original ID retrieves the failure. Docker Exec starts the supervisor. After `ready`, the Runner rechecks the execution and container before sending `run` once. It returns the original Bash result after it receives `finished` with cleanup complete, the stream ends in full, and Docker Inspect confirms that the supervisor exited with code zero. The command deadline and shutdown signals request cancellation. The Runner closes the transport when the separate cleanup budget expires. The profile can override that budget and the TERM grace period with `DSH_RUNNER_CLEANUP_TIMEOUT_MS` and `DSH_RUNNER_TERM_GRACE_MS`.

When the Runner confirms cleanup after an individual timeout or cancellation, the container remains available and other executions can continue. If the outcome is uncertain, the Runner immediately blocks new commands and pending Start or `run` requests for that generation. It deletes the container by its full ID and verifies removal. The original failure is `execution_outcome_unknown`, and other executions interrupted by removal receive `execution_container_recycled`. After successful removal, the workspace can reopen. If deletion fails, the Runner keeps the slot reserved and reports `cleanup_required` until a close operation retries removal. Both the HTTP endpoint and the in-process `cancel(workspaceId, {executionId, expectedContainerId})` method target an existing record. Repeated cancellation requests share the same cleanup.

Use `POST /exec` to execute and `POST /exec/cancel` to cancel. Check the cleanup status in the execution result. `processes_cleaned` means this execution's descendants have been cleaned up and other executions can continue. `container_removed` means the entire container generation has been removed and other in-flight executions receive a container recycling error. `unconfirmed` means cleanup is still unverified. A cancellation for an old generation cannot affect a reopened container.
