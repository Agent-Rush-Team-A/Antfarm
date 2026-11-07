# Vultr VFS 工作区部署

在共享卷部署中，Harness 挂载 Vultr File System（VFS），负责网页上传和下载。Harness、Runner 和 Docker 在同一台 VM 上使用同一个工作区根。Runner 只把工作区登记目录挂载到对应容器的 `/workspace`。单独部署执行 VM 时，管理员挂载整卷，再把分配给该任务的目录绑定到 `/workspace`。工作区登记和文件保留在执行 VM 生命周期之外。

## 启动 Harness

1. 在卷所在区域准备 Linux VM，启用 Shared Memory Backing，将卷连接到 VM，并从控制台读取 Mount Tag。将卷以 `virtiofs` 挂到 `/srv/antfarm/vfs`。挂载前，本地挂载点由 root 持有，模式为 `0755`，目录保持为空。确认 Docker daemon 能看到同一路径。[Vultr 挂载指南](https://docs.vultr.com/products/storage/file-system/mount/linux)
2. 在已挂载的卷内创建 `workspace/`，由 Web 服务账号持有。将 Web 的 `DSH_MULTIUSER_WORKSPACE_ROOT` 和 Runner 的 `DSH_RUNNER_WORKSPACE_ROOT` 都设为 `/srv/antfarm/vfs/workspace`。在 Web 服务环境中将 `DSH_SANDBOX_RUNNER_SOCKET` 设为 Runner 实际监听的路径，默认是 `/run/agentrush-sandbox/runner.sock`。在 Linux 上构建项目、准备 Runner profile 和沙箱镜像。Harness 创建的工作区默认由 Web 账号持有，模式为 `0700`，因此 Runner 的 `DSH_RUNNER_CONTAINER_UID` 必须与 Web 服务账号的数字 UID 一致。[启动 Runner](SANDBOX-RUNNER.md)
3. 用 `srv-antfarm-vfs.mount` 持久挂载，设置 `What` 为 Mount Tag、`Where=/srv/antfarm/vfs`、`Type=virtiofs`、`Options=nosuid,nodev`，并设为随 `local-fs.target` 启动。Web 和 Runner 都以 `BindsTo` 和 `After` 依赖该挂载。用 `Requires` 和 `After` 让 Runner 依赖 Docker、Web 依赖 Runner。
4. 安装[挂载检查脚本](vfs/check-mount.sh)并赋予执行权限，将它用作两项服务的 `ExecStartPre`。参数依次为挂载点、预期来源、卷内路径、数据目录和访问模式。Harness 上使用 `/srv/antfarm/vfs`、Mount Tag、`/`、`/srv/antfarm/vfs/workspace`。Web 以自己的账号执行 `read-write` 探针，Runner 以自己的账号执行 `traverse` 检查，实际文件读写由容器身份完成。挂载缺失、来源或类型不符时，服务拒绝启动，底层本地目录保持为空。

以下配置放入 Web 的 systemd 服务单元，与上面的挂载依赖和 `ExecStartPre` 一起使用。按部署环境填写 Web 账号、Runner 共享组、仓库路径和 `pnpm` 路径。配置完成后通过 `systemctl` 启动 Web 单元。网页通过 SSH 隧道访问本机监听端口。

```ini
[Service]
User=antfarm-web
SupplementaryGroups=agentrush-sandbox
WorkingDirectory=/srv/deepseek-harness
Environment=DSH_MULTIUSER_WORKSPACE_ROOT=/srv/antfarm/vfs/workspace
Environment=DSH_SANDBOX_RUNNER_SOCKET=/run/agentrush-sandbox/runner.sock
ExecStart=/usr/local/bin/pnpm run start:web --patch apps/cli/config/examples/harness-sandbox.patch.yml --host 127.0.0.1 --port 3080 --no-open
```

服务启动后，用 `findmnt` 核对来源、类型和卷内路径，并在两项服务的日志中查找 `VFS preflight accepted`。浏览器登录后打开一个工作区，确认可以启动沙箱和上传、下载文件。

```sh
findmnt -rn --mountpoint /srv/antfarm/vfs -o TARGET,SOURCE,FSTYPE,FSROOT
```

## 执行 VM 的挂载和权限

- 从 Harness 读取已登记的绝对目录，确认它是 `/srv/antfarm/vfs/workspace` 下的真实直接子目录。去掉挂载根 `/srv/antfarm/vfs` 可得到卷内路径，例如 `/workspace/ws-…`。工作区 ID 与目录名分别生成。
- 卷根与工作区总目录使用 `0711`。在首次上传和启动任务前，为该工作区的任务账号分配独立的数字 UID/GID，保持 Web 账号为登记目录所有者，将目录的组设为任务 GID，模式设为 `2770`。让 Web 服务账号加入该共享组。Web 已在运行时，更新组成员后重启服务以应用新的补充组。
- 上传文件使用上传时登记目录的 GID。迁移已有工作区时，先暂停该工作区的上传和任务，再将执行 VM 需要访问的已有上传文件改为新的共享 GID。保留文件所有者和权限。用任务账号确认这些文件可读后再恢复任务。
- 在同一区域为执行 VM 启用 Shared Memory Backing，再连接卷。挂载整卷后，只将登记目录绑定到 `/workspace`。记录卷 ID 和实例 ID。任务进程使用分配的 UID/GID，清除补充组和 capabilities，并启用 `no_new_privs`。在启动任务前，以任务身份核对挂载点、类型、来源和卷内路径，并用 `read-write` 实际读写。绑定挂载的预期来源形如 `<Mount Tag>[/workspace/ws-…]`。检查失败时拒绝执行任务。[挂载检查脚本](vfs/check-mount.sh)
- 文件所有者在任务结束前将网页需要访问的产物设为工作区组可读，例如 `0640`。任务生成的 `0600` 文件可能使网页文件列表或下载失败。
- 原生挂载依靠受限任务身份隔离工作区，执行 VM 的管理员和初始化程序需要受信。若需要在存储层按子目录和客户端 IP 限制访问，Storage Gateway 需要另行接入。[Vultr Storage Gateway](https://docs.vultr.com/products/storage/storage-gateway/provisioning)

单会话 VM 使用独立的登记根和 VFS 工作区根。`SingleVmWorkspaces` 按登记目录名映射到卷内目录。Web 的补充组预先包含所有预留的任务组，卷内工作区总目录由 Web 持有且模式为 `0711`。提供方把 UID/GID 绑定保存在挂载外的私有 `stateRoot`，迁移 Harness 时随登记一起保留。切入单会话 VM 时，暂存目录使用 `2770`，暂存文件给对应任务组读写权限。现有的可执行文件保留执行权限。

管理员用[挂载检查脚本](vfs/check-mount.sh)核对整卷与绑定挂载，并验证实际任务账号可读写后，从可信安装目录调用[受限 helper 启动脚本](vfs/run-workspace-helper.sh)。参数依次为绑定的任务 UID/GID、已验证的 `/workspace` 路径和已安装 helper 的绝对路径。脚本以该任务身份启动 helper，Bash 子进程继承同一身份和权限限制。文本工具的新文件以 `0660` 发布，替换保留原权限。Bash 创建的私有文件仍由所有者发布。

单会话分配提供方从部署配置取得卷 UUID，并从 `vfsScriptsRoot` 读取上述两个脚本。该目录、管理密钥、helper 归档和分配记录位于所有工作区挂载之外。执行 VM 镜像需提供 OpenSSH、`sudo`、util-linux 的 `setpriv` 和 `flock`、procps 的 `pgrep`，以及 `virtiofs` 支持。管理连接负责挂载和安装，并在任务账号的 home 目录下准备仅该账号可写的本机 helper 缓存。任务用户的 SSH 密钥只允许启动固定 helper，并允许其 Unix 套接字转发。[OpenSSH 密钥选项](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT)

## 回收执行 VM

单会话 VM 等已排队的输入、命令和写入收尾后，由任务生命周期回收原代次。管理员在原 VM 上禁止 helper 再启动，确认任务用户的进程退出，同步文件系统，再依次卸载 `/workspace` 和卷根。提供方按卷 ID 和实例 ID 解除连接，确认连接消失后删除实例，再确认实例和连接均已消失。下一台 VM 使用同一卷和登记目录。[Vultr 卷连接管理](https://docs.vultr.com/products/storage/file-system/management/attach-instances)

Harness 启动时串行核对保留的记录，后续任务也可触发核对。创建未获应答时用原唯一标签查找实例。卷连接、删除或写入结果仍不明确时，保留原阶段和容量，状态显示 `cleanup_required`。核对时仅操作符合原标签和资源 ID 的实例与连接。

团队预留的 `antfarm-i40-vfs` 卷位于东京（`nrt`），容量 10 GB，ID 为 `a785919f-b9d2-42b9-8771-6d48b28af5b3`。复用前在控制台核对连接与 Mount Tag。
