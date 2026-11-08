# 启动工作区沙箱 Runner

[English](SANDBOX-RUNNER.md) | 中文

在 Linux 上用独立的 `sandbox-runner` profile 启动服务。Runner 通过 Docker Engine 的 Unix socket 管理容器，Harness 通过另一个 Unix socket 发出工作区请求。

工作区根位于 Vultr VFS 时，先配置共享卷和启动前检查，再启动 Runner。[Vultr VFS 工作区部署](VULTR-VFS.zh.md)

## 服务账号和目录

让 Runner 使用专用账号 `agentrush-runner`，主组为 `agentrush-sandbox`。Harness 服务账号加入 `agentrush-sandbox`。在 Docker Engine socket 由 `root:docker` 持有且模式为 `0660` 的主机上，只给 Runner 服务补充 `docker` 组权限。检查 Harness 的实际进程组和 Docker socket 的 ACL，确保它无法直接连接 Docker。

Runner 的 API 目录必须由 Runner 持有，允许共享组穿过目录，禁止组写入和其他账号访问。使用下列 systemd 配置可创建 `/run/agentrush-sandbox`，并让 socket 继承 Runner 的主组。Runner 会将 socket 设为 `0660`。

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

同一个部署标识只启动一个 Runner。若现有路径已被占用，启动会失败。非 systemd 部署在进程异常终止后应先确认旧服务已停止，再移除它留下的 socket 文件。

## 准备 profile

在 Linux 构建仓库产物。设置 Runner 专用的 `DSH_HOME`，以 Runner 账号复制模板并链接当前构建好的包。下面假设仓库位于 `/srv/deepseek-harness`。

```sh
repo=/srv/deepseek-harness
export DSH_HOME=/var/lib/agentrush-runner/dsh
profile="$DSH_HOME/profiles/sandbox-runner"
install -d -m 0700 "$profile/node_modules/@deepseek-ai"
cp "$repo/team-docs/sandbox-runner-profile/package.json" "$profile/package.json"
cp "$repo/team-docs/sandbox-runner-profile/cordis.patch.yml" "$profile/cordis.patch.yml"
ln -s "$repo/packages/sandbox/sandbox-runner" "$profile/node_modules/@deepseek-ai/dsh-sandbox-runner"
```

在环境文件中设置 `DSH_HOME`、唯一的 `DSH_RUNNER_DEPLOYMENT`、已拉取的固定摘要镜像 `DSH_RUNNER_IMAGE`，以及非 root 的 `DSH_RUNNER_CONTAINER_UID` 和 `DSH_RUNNER_CONTAINER_GID`。按部署需要设置 `DSH_RUNNER_DOCKER_SOCKET`、`DSH_RUNNER_SOCKET` 和 `DSH_RUNNER_WORKSPACE_ROOT`。默认路径分别为 `/var/run/docker.sock`、`/run/agentrush-sandbox/runner.sock` 和 `/var/lib/agentrush-workspaces`。预建数据根下的工作区目录，为配置的容器 UID/GID 分配读写权限。

工作区根须位于 Docker 数据根之外。Runner 保持工作区绑定的 `rprivate` 传播方式，Docker 不允许以此方式绑定数据根内部的目录。Runner 在容器内运行时，工作区绝对路径还须与 Docker daemon 看到的路径一致；Runner 的 profile 和控制数据可以使用独立卷。

在前台使用相同环境启动时，运行 `node "$repo/apps/cli/lib/bin.js" --profile sandbox-runner`。完成部署清理后 Runner 开始处理工作区操作。若启动失败，例如 Docker socket 无法连接，CLI 会在 stderr 报告原因并以退出码 1 结束。启动清理期间收到 `SIGTERM` 时，Runner 会取消在途 Docker 请求并释放 API socket。

## 本机调用

下面用预建目录 `/var/lib/agentrush-workspaces/A` 和工作区 ID `A` 演示。部署接入后由 Harness 传入已授权的工作区 ID。

```sh
socket=/run/agentrush-sandbox/runner.sock
url=http://localhost/v1/workspaces/A/sandbox
curl --unix-socket "$socket" -X PUT -H 'Content-Type: application/json' \
  -d '{"workspaceDir":"/var/lib/agentrush-workspaces/A"}' "$url"
curl --unix-socket "$socket" "$url"
curl --unix-socket "$socket" -X DELETE "$url"
```

成功返回 HTTP 200 和 JSON 状态，`running` 带完整 `containerId`。工作区参数或目录无效返回 400。容量满等工作区冲突返回 409，错误码由 JSON 的 `error` 字段给出，容量满时为 `sandbox_capacity`。清理尚未完成、Docker 不可用或操作结果无法确认时返回 503。

## Bash 执行交接

沙箱镜像须提供 Python、`/bin/bash` 和固定的只读监管程序，构建及启动约定见[监管镜像参考](../packages/sandbox/sandbox-runner/docs/README.zh.md)。先用 PUT 开启工作区，再用 GET 取得 `running` 状态的完整 `containerId`，作为 Exec 请求的 `expectedContainerId`。下面使用 `jq` 构造 JSON，在已开启的 A 中执行命令。

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

示例返回 HTTP 200、退出码 7 和两路独立输出。同一容器可立即启动多个不同执行 ID 的 Bash，命令共享容器的资源限制。调用方断开连接后可用原执行 ID、容器 ID 和请求内容重试。同一代结果不明时先查询沙箱状态，`cleanup_required` 表示需要 DELETE 并确认关闭。重开后使用新容器 ID 和新执行 ID。字段限制和错误状态见 [Runner 参考](../packages/sandbox/sandbox-runner/README.zh.md#use-this-package)。

使用相同身份取消已有执行；该请求不包含 command，也不创建执行记录。

```sh
jq -n --arg id "$execution_id" --arg container "$container_id" \
  '{executionId: $id, expectedContainerId: $container}' \
  | curl -sS --unix-socket "$socket" -H 'Content-Type: application/json' \
      --data-binary @- -w '\nHTTP %{http_code}\n' "$url/exec/cancel"
```

在途取消返回 202/requested，已结算返回 200/settled；上面的快速命令通常已经结算。两者都不表示清理成功，应等原 exec 请求或原样重试取得最终结果。未知 ID 返回 404，旧代返回 409。原 exec 的执行错误保留 error，另带 executionId、containerId、reason、cleanup 和已知时的 bash；未知 Bash 状态省略，不编造成功结果。进程已清理的取消为 409/execution_cancelled，已清理或未发 Start 的超时为 504/execution_timeout；清理失证为 503，需根据 cleanup 判断容器已删除还是仍未确认。其他准备/生命周期错误仍只含 error，sandbox_cleanup_required 使用 503。

## 进程清理交接

[Runner 服务](../packages/sandbox/sandbox-runner/src/index.ts) 在当前工作区容器代次的内存中按执行 ID 保存各自的在途执行、结果和失败。Start 发出前的失败只影响本次执行，原 ID 仍可重试取回失败。Docker Exec 启动监管程序，ready 后重新确认原执行及容器，再发送一次 run。只有收到清理完成的 finished、流完整结束及 Docker Inspect 确认监管退出零后，才返回原 Bash 结果。命令期限和停机信号请求取消；独立的清理预算到达后才关闭传输。profile 可通过 DSH_RUNNER_CLEANUP_TIMEOUT_MS 和 DSH_RUNNER_TERM_GRACE_MS 覆盖部署清理预算和 TERM 宽限。

确认单次超时或取消已清理时，容器继续可用，其他执行不受影响。结果无法确认则同步冻结该代的新命令和尚未发出的 Start/run，按完整 ID 删除并确认。原失败报 execution_outcome_unknown，受回收影响的其他执行报 execution_container_recycled。删除成功可重新开启；删除失败继续保留名额和 cleanup_required，需要关闭操作重试。HTTP 与进程内 `cancel(workspaceId, {executionId, expectedContainerId})` 均只定位已有记录，重复取消复用同一次清理。

执行入口为 `POST /exec`，取消入口为 `POST /exec/cancel`。`processes_cleaned` 表示本次后代已清理，`container_removed` 表示整代已删除，`unconfirmed` 表示仍没有清理保证。用执行结果核对清理状态。一次清理成功时，其他执行可以继续。回收该代容器时，其他在途执行会收到回收错误。旧代取消不能作用到重开的容器。
