---
description: "部署基于 VFS 的工作区 VM 模式，并运维旧快照提供方。"
kind: "user-guide"
---

# Vultr 工作区 VM

[English](workspace-vultr.md) | 中文

## 准备部署

Harness 运行模型通道、账号鉴权、执行协调和 Session 存储。[工作区模式部署](#offer-vm-and-docker-modes-together)使用共享 VFS 存储，不创建整机快照。下文独立 `/vultr` 配置为现有部署和旧数据导出保留快照行为。每个活跃 Workspace 获得一台独立 Vultr VM，同一 Workspace 的会话共享该 VM。VM 运行非 root 的 `workspace-exec` 账号与独立 SSH helper，不安装 Docker 或完整 Harness。

将 Vultr 管理密钥存入 Harness 用户拥有的私有文件，并准备私有 SSH 客户端密钥及私有持久状态目录。两个凭据文件和状态目录都必须位于所有登记项目之外。管理密钥保留在 Harness，不要用只有 Cloud Inference 权限的密钥管理实例。状态目录权限须为 0700，凭据文件不得授予组或其他用户访问权。一个 Harness 通过内核锁独占该目录；退出或崩溃时锁会释放。

构建包产物后，构建该部署的[独立 helper 归档](../../../packages/ssh/ssh-helper-runtime/README.zh.md)。保留归档摘要和 `manifest.json` 中的可执行文件摘要。提供方在分配 VM 前检查归档，将其安装到 VM 工作区之外，并在 helper 握手时核对可执行文件摘要。每个 Workspace 单独生成主机密钥，通过私有 OpenSSH 配置固定信任；启动不会接受未知主机密钥。

```sh
pnpm run build:artifacts
pnpm exec tsx scripts/build-exe-for-ssh-helper.ts --skip-build --output /srv/antfarm/helpers
```

创建包含以下显式设置的部署 JSON 文件。使用 helper 支持的操作系统镜像；`2284` 是验证部署采用的 Ubuntu 24.04 镜像。地区和套餐须从账号当前的 Vultr 目录中选择。

```json
{
  "apiKeyFile": "/srv/antfarm/secrets/vultr.key",
  "stateRoot": "/srv/antfarm/cloud-workspaces",
  "deploymentId": "antfarm-production",
  "region": "nrt",
  "plan": "vc2-1c-2gb",
  "osId": 2284,
  "sshKeyFile": "/srv/antfarm/secrets/workspace-ssh",
  "helperArchive": "/srv/antfarm/helpers/helper.tar.gz",
  "helperArchiveHash": "replace-with-archive-sha256",
  "helperHash": "replace-with-executable-sha256",
  "maxInstances": 2
}
```

将 `DSH_MULTIUSER_WORKSPACE_ROOT` 设为登记项目的规范根目录。把部署 JSON 导出为 `DSH_VULTR_CONFIG_JSON`；其中保存凭据路径，不含密钥值。使用 [Vultr overlay](../../../apps/cli/config/examples/harness-vultr.patch.yml) 启动 Antfarm，不要同时加载固定 SSH 或 Docker overlay。

```sh
export DSH_MULTIUSER_WORKSPACE_ROOT=/srv/antfarm/workspaces
export DSH_VULTR_CONFIG_JSON="$(cat /srv/antfarm/vultr-config.json)"
pnpm run start:web --patch apps/cli/config/examples/harness-vultr.patch.yml --no-open
```

## 使用工作区文件与执行

开启 Workspace 沙箱或发送已认证消息时，会创建或复用其 VM。就绪要求云端电源状态、SSH 可访问、已安装 helper 完整性及远程目录检查全部通过。并发开启共用一次分配。Bash、原生 read/write/edit 与网页上传、列表、下载访问同一远程目录。远程失败不会将执行转到 Harness 本机工具。

首次开启会导入已有登记文件。初始导入中断后，只有已存在的远程文件内容一致才继续；冲突会停止准备。准备完成后，VM 是执行目录的权威来源。Harness 上的登记项目路径仍用于账号与 Session 元数据，不作为执行回退。

后端沿用 `workspaceSandbox/open`、`status`、`close` 方法。浏览器结果保留原状态，并通过 `progress` 提供云阶段：创建、连接、恢复、保存文件、停机、保存快照、删除或失败。进度不含云资源标识、主机地址或凭据路径。开启和保存可能需要数分钟；API 成功分配不等于 helper 已就绪。

## 关闭与恢复

关闭会撤销旧请求代次、停止托管命令并阻止新的远程写入。helper 确认已接收写入收束后，才复制受上限约束的只读文件副本。提供方关闭 helper、刷新 VM 磁盘、确认 VM 停机，再创建磁盘快照。完成快照和副本的持久记录后才删除源 VM。保存失败会保留源磁盘并显示失败阶段，不删除唯一数据来源。

关闭时，文件列表和下载读取已完成的私有副本，无需分配 VM。副本只读，不作为执行目录。上传或开始新任务时从快照恢复 VM。恢复会重新应用 cloud-init，保留固定 SSH 主机密钥，确认当前分配的就绪标记，检查 helper，并更新执行代次。磁盘文件和已安装环境恢复；旧任务进程需要重新启动。

## 恢复与运维

保留云状态目录及部署 SSH 密钥；目录记录实例、快照、副本和执行标识。Harness 重启后先通过云清单核对元数据，不盲目重建实例。中断或结果不明的创建，通过原标签或快照描述核对，不自动重放结果未知的修改。磁盘缺失或归属不匹配会阻止继续执行，需要运维检查。

默认容量为两台实例。轮询、请求和操作期限，以及副本的总字节数和条目数上限，均为[包参考](../../../packages/sandbox/harness-sandbox/README.zh.md)中说明的部署配置。超过副本上限时保存失败并保留 VM。新的完整保存记录成功前保留上一份完整快照；保存完成后移除旧快照。即使没有运行 VM，快照存储仍会计费。

Vultr overlay 启用网页沙箱控件及共用空闲插件，空闲阈值为 30 分钟、扫描间隔为 10 秒。持续的云端准备、文件传输和清理阻止空闲关闭。上传恢复 VM 后重新进入空闲跟踪，取得新的运行状态观察后才开始计时。条件关闭调用本后端的保存流程，不另加计时器。面板显示通用沙箱状态和云端失败提示；详细阶段可通过管理 API 获取。云验收使用隔离凭据和可丢弃工作区；显式启用的 Loader 测试仅清理自己的带标签资源，保留账号中的其他资源。

<a id="offer-vm-and-docker-modes-together"></a>

## 同时提供 VM 和 Docker 模式

使用[工作区模式叠加层](../../../apps/cli/config/examples/harness-docker-modes.patch.yml)同时提供两种 Docker 模式和两种 VM 模式。先准备 [Docker 模式配置](workspace-sandboxes.zh.md)，再向 `DSH_DOCKER_MODES_CONFIG_JSON` 添加 `vultr` 对象。

- `vultr.multi` 和 `vultr.single` 各自使用上文的分配与 helper 配置，指定独立的私有 `stateRoot` 目录和 `deploymentId`。两者必须使用相同 `volumeId` 和 `region`，并将 `vfsScriptsRoot` 指向部署方持有的脚本目录，其中包含 `check-mount.sh` 和 `run-workspace-helper.sh`。客体机根目录保持为 `/workspace`；不得把旧快照状态目录直接用作 VFS 分配目录。
- `vultr.vfs` 使用 Harness 侧的 `mountPoint`、字符串形式的 `mountTag`、挂载上直接子目录 `workspaceRoot`、存储共享任务身份绑定的私有 `stateRoot` 和预留的数字 `taskIds`。两种 VM 模式共用此池，并在相互切换时保留相同 UID/GID。
- Web 以非 root 用户运行，并把全部预留 ID 配置为补充组。工作区文件仍被保留时，身份继续占用，即使 VM 已关闭或工作区已归档。部署预留 128 个 ID 时，最多容纳 128 个此类绑定；VM 容量和可用宿主内存分别构成额外限制。部署步骤见 [VFS 说明](../../../team-docs/VULTR-VFS.md#执行-vm-的挂载和权限)。
- 可选 `vultr.legacyMultiStateRoot` 指向旧快照提供方的私有状态，只导入已确认关闭的多会话 VM 的完整文件副本，不关闭仍运行的旧 VM，也不删除快照。没有旧 VM 记录的工作区从登记文件初始化 VFS 目录。验证导入后仍保留原状态和快照，由运维检查。

```sh
export DSH_MULTIUSER_WORKSPACE_ROOT=/srv/antfarm/workspaces
export DSH_DOCKER_MODES_CONFIG_JSON="$(cat /srv/antfarm/workspace-modes.json)"
pnpm run start:web --patch apps/cli/config/examples/harness-docker-modes.patch.yml --no-open
```

叠加层让新工作区从多会话 Docker 模式开始。`workspace.defaultMode` 保持为 Docker 模式，在创建首个会话前选择 VM 模式。Antfarm 将 VM 环境称为 **Sandbox Pro (VM)**；DeepSeek Harness 对应名称是 **VM**。切换会准备 VFS 目录，并搬入工作区中已有的上传文件。两种 VM 模式下，执行 VM 关闭时，网页仍直接通过已验证的 VFS 目录上传、列表和下载。处于 `cleanup_required` 时，已验证的 VFS 目录仍可供列表和下载。

单会话 VM 模式下，首条有效任务启动 VM，最后一项任务释放 VM。同一会话中的后续消息会启动新 VM，并继续使用 VFS 中的文件。多会话 VM 在工作区的多个回合和会话间保留实例。手动关闭、空闲关闭、工作区归档或删除会禁止 helper 再启动，等待任务进程和写入收束，同步并卸载客体机的挂载，然后确认 VFS 连接解除和 VM 删除。不创建新的整机快照。文件留在 VFS 中；`/workspace` 之外安装的工具和配置会在 VM 重建时丢失。通过部署镜像或可重复执行的安装提供这些工具。

将基于快照的工作区迁入这些模式前，按 [VM VFS 升级指南](../../upgrade-guide/v0.2.2-alpha.3/vm-vfs-storage/guide.zh.md)操作。工作区文件经验证并持久导入 VFS 之前，保留原记录和快照。
