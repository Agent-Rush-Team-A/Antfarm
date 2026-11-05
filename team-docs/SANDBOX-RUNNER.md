# 启动工作区沙箱 Runner

在 Linux 上用独立的 `sandbox-runner` profile 启动服务。Runner 通过 Docker Engine 的 Unix socket 管理容器，Harness 通过另一个 Unix socket 发出工作区请求。

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

沙箱镜像须提供 `/bin/bash`。先用 PUT 开启工作区，再用 GET 取得 `running` 状态的完整 `containerId`，作为 Exec 请求的 `expectedContainerId`。下面使用 `jq` 构造 JSON，在已开启的 A 中执行可信前台命令。

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

## 进程清理交接

[Runner 服务](../packages/sandbox/sandbox-runner/src/index.ts) 在当前工作区容器代次的内存中按执行 ID 保存各自的在途执行、结果和失败。Start 发出前的失败只影响本次执行，原 ID 仍可重试取回失败。Start 发出后，若连接中断、等待超时或 Docker 无法确认退出，当前代次进入 `cleanup_required`。Runner 阻止新命令和尚未发出的 Start。已启动的其他命令仍可各自结算，关闭容器会结束其中的在途命令。

Issue #9 需要验收按执行 ID 清理进程树，覆盖超时、显式取消和 Bash 正常退出后遗留的后台子进程。清理成功时，同容器的其他命令可以继续并返回自己的结果。无法确认时，先销毁旧容器再重开，并核对工作区已写入的文件仍在。
