# Docker 工作区专用执行 VM

[English](README.md) | 中文

每套 Antfarm 部署使用一台 Harness VM A 和一台 Docker 执行 VM B。两种 Docker 工作区模式都通过现有 Runner API 在 B 上执行。A、B 共用一个专用 Vultr File System 卷，B 为每个容器挂载一个已登记的工作区目录。 [安装 Runner](../SANDBOX-RUNNER.md) · [安装 VFS](../VULTR-VFS.md)

## 安装服务

1. 准备同一 Vultr 区域和私网内的两台 Linux VM。在两台主机的 `/srv/antfarm/source` 构建同一份 Antfarm 源码。在 B 使用 Runner profile 和固定镜像摘要，使用文档中的 `agentrush-runner` 服务账号。在 A 使用 `antfarm-web` 服务账号。
2. 将 Docker 专用 VFS 卷连接到 A 和 B。在两台主机上创建 root 持有、模式为 `0755` 的空挂载点 `/srv/antfarm/docker`。安装 [srv-antfarm-docker.mount](srv-antfarm-docker.mount)，将 `What` 设为各主机对应的 Mount Tag。挂载成功后，在卷内创建 `workspaces`，使用 Web 账号的数字 UID 和 GID。迁移已有部署时，先按下文核对原登记根。
3. 在 B 安装 [antfarm-docker-runner.service](antfarm-docker-runner.service)。在 `/etc/antfarm/docker-runner.env` 填写 Runner profile 的环境配置。将 `DSH_RUNNER_WORKSPACE_ROOT` 设为 `/srv/antfarm/docker/workspaces`，填写匹配的容器 UID/GID、唯一的 `DSH_RUNNER_DEPLOYMENT` 和 B 对应的 `ANTFARM_DOCKER_MOUNT_TAG`。Runner socket 使用 `/run/agentrush-sandbox/runner.sock`。
4. 在 B 创建 `antfarm-runner-link` 账号，加入 `agentrush-sandbox` 组，并配置 A 专用的 SSH 公钥。将 Docker 组权限授给 Runner 服务。把 [runner-link.sshd.conf](runner-link.sshd.conf) 安装到 sshd 的配置目录，先运行 `sshd -t` 再重载。仅允许 A 和受信部署管理员通过私网访问 B 的 SSH 端口。
5. 在 A 将 [runner-ssh.conf](runner-ssh.conf) 安装为 `/etc/antfarm/runner-ssh.conf`。设置 B 的私网地址，并把经核实的 SSH 主机公钥写入指定的 known-hosts 文件。让 Web 账号能够读取转发私钥。安装 [antfarm-runner-tunnel.service](antfarm-runner-tunnel.service) 和 [antfarm-docker-web.service](antfarm-docker-web.service)。将下表的设置和现有 Web profile 私有配置写入 `/etc/antfarm/docker-web.env`。

   | 设置 | 值 |
   | --- | --- |
   | `ANTFARM_DOCKER_MOUNT_TAG` | A 的 VFS Mount Tag |
   | `ANTFARM_WEB_PORT` | 回环 HTTP 端口 |
   | `DSH_MULTIUSER_WORKSPACE_ROOT` | `/srv/antfarm/docker/workspaces` |
   | `DSH_DOCKER_MODES_CONFIG_JSON` | 将 `workspaceRoot` 设为共享工作区根，`socketPath` 设为 `/run/antfarm-runner-tunnel/runner.sock`，`drainSocket` 设为 `/run/antfarm-docker-web/drain.sock`。同时填写私有 `stateRoot` 以及迁移上限 `maxFiles` 和 `maxBytes` |

将单元文件安装到 `/etc/systemd/system`，并在两台主机执行 `systemctl daemon-reload`。对应服务启动时会拉起挂载。A 启动 Web 前会检查模式配置使用的是已校验的工作区根和转发 socket。若原登记路径与示例不同，在两台主机保留同一实际路径，同时更新挂载单元名称、服务依赖及单元文件和 `host-control.sh` 的检查路径。两种工作区 VM 模式共用独立于 Docker 卷的 VM VFS 卷及 UID/GID 池。保留共享身份状态，并将各 VM 模式的独立私有分配状态放在两个卷之外。

## 成对启停

在 A、B 之外的 Linux 管理主机运行 [pair.py](pair.py)。准备一份私有 JSON 配置，包含 `region`、与 `DSH_RUNNER_DEPLOYMENT` 匹配的 `deployment`，以及指向私有 Vultr API 密钥文件的 `apiKeyFile`。为 `harness` 和 `runner` 各填一个对象，包含实例 `id`、实例 `label` 和已固定主机身份的 SSH 别名 `ssh`。别名对应能够以 root 运行 [host-control.sh](host-control.sh) 的 SSH 管理账号。配置、私钥和部署源码应对任务进程不可写。

运行 `python3 pair.py /path/to/private-pair.json start` 或 `stop`。启动时先等 B 的 Runner 就绪，再检查 A 的 Web 入口和工作区模式就绪 socket。停机通过 A 的私有 socket 停止接纳模式操作，并等待已有任务和文件操作结算。等待超时会让部署保持暂停和通电，待已有任务结算后可以重试 `stop`。A 确认结算后停止 Web 并刷盘。B 确认受管容器已关闭，停止 Runner 和 Docker，再刷盘。随后申请关停实例。Vultr 停机的实例仍计费。 [Vultr 停机说明](https://docs.vultr.com/products/compute/instances/cloud-compute/management/stop-instance)

## 迁移已有工作区文件

停止原有 Web 和 Docker Runner 部署，阻止新写入。将已登记的目录复制到暂挂的 Docker VFS 卷，保留名称、内容、所有者和权限。例如先执行 `rsync -aH --numeric-ids`，再用相同来源和目标运行 `rsync -aHnci --numeric-ids --delete`，确认差异报告为空。复制前盘点目录，确保控制状态与凭据位于卷外。将原目录移到私有备份位置，在计划位置挂新卷，以 Web 和任务身份分别验证读写，再恢复接纳。A、B 使用原有的登记绝对路径。

如果恢复接纳前校验失败，停止候选服务，切回备份目录与原 Runner 入口。恢复接纳后如需回退，先冻结写入并核对这段时间新发布的文件，再恢复备份。
