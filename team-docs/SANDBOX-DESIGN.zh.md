# Antfarm 工作区沙箱设计

[English](SANDBOX-DESIGN.md) | 中文

用户登录 Antfarm 后，在所属工作区中使用文件和会话。Docker 部署将 Bash 交给同机 Runner，容器回收后保留宿主机工作区目录。Vultr 工作区 VM 通过 SSH 执行工具。单会话 VM 将文件保存在 Vultr File System（VFS），多会话 VM 则在关闭时保存磁盘快照和私有文件副本。部署可以启用一种后端，也可以同时提供 Docker 和 Vultr VM 模式。[Docker 工作区指南](../docs/user/guide/workspace-sandboxes.zh.md) · [Vultr 工作区 VM 指南](../docs/user/guide/workspace-vultr.zh.md)

## 文档里的几个角色

| 名称 | 在本项目里的意思 |
| --- | --- |
| fork（团队仓库） | 团队在 GitHub 上从原版 DeepSeek Harness 派生出的独立仓库。本文引用的代码来自这份仓库，团队也在这里维护参赛版本。 |
| DeepSeek Harness（简称 Harness） | 网页和模型之间的应用。它保存会话，调用 DeepSeek，并根据模型的回复发起 Bash 等工具调用。文中的 **Host** 指 Harness 的后端，**Agent** 指在一个会话里调用模型和工具的程序。 |
| Runner（Docker 命令执行服务） | 按工作区 ID 创建、复用和回收容器，在对应容器内执行 Bash，再把结果交还给 Harness。 |
| 沙箱 | 与工作区绑定的执行环境。下文的 Runner、容器和宿主机指 Docker 部署。 |
| 工作区 | 网页里用于组织一次任务的空间，包含文件目录和一个或多个会话。会话各有聊天记录，同一工作区内的会话共享文件。 |

例如，用户在工作区 A 上传 `销售明细.xlsx`，让模型汇总每月销售额。Harness 查到会话属于 A，Runner 就在 A 的沙箱里列目录、读表格和运行处理脚本。生成的 `月度汇总.xlsx` 出现在 A 的文件列表，用户可以下载。沙箱回收后，在 A 里继续任务还能打开同一份表格。

## Docker 部署的用户能力

- **多用户。** 每个人用自己的账号登录，只能操作自己有权限的工作区、会话和文件。同一个工作区可以开多个会话，聊天记录各自保存，文件共用。
- **按用户管理密钥。** 用户在网页管理个人凭证，Harness 按发起推理请求的账号检查权限并使用该账号的 Vultr 推理凭证。[个人模型指南](../docs/user/guide/personal-models.zh.md)
- **开启沙箱。** 在多会话 Docker 模式下，每个工作区最多有一个正在运行的沙箱。用户可以在网页点「开启沙箱」。沙箱处于关闭状态时，发送消息也会先开启沙箱，再继续处理。第一次启动可能需要稍等。
- **在沙箱里操作文件和运行命令。** Docker overlay 通过 Bash 提供列目录、读写文件和执行脚本。`ls` 默认列出当前工作区的文件。网页通过独立接口提供上传、列表和下载。
- **关闭沙箱并保留产物。** 在多会话 Docker 模式下，用户可以在网页关闭沙箱，系统也会在工作区空闲 30 分钟后自动回收。会话记录、上传文件和写入工作区的产物可以继续查看或下载。

每个 Docker 容器只挂载对应工作区的任务目录。同一个工作区内的会话共享该目录。

## Bash 怎样交给 Runner

| 位置 | 当前职责 |
| --- | --- |
| Agent Loop → Native Tool Executor | Agent Loop 从模型回复里取出工具调用，经 `ctx.tools.execute` 交给对应工具。Harness 记录调用和结果（`tool/call`、`tool/result`），让模型在下一步看到结果。 [调用入口][loop-tools] · [工具上下文][tool-context] · [结果提交][tool-log] |
| `dsh-tool-bash` | 标准工具配置（Standard 预设）启用 `bash`。本机执行路径先解析目录、权限和环境，再调用 `ctx.shell.resolve` 和 `ctx.shell.execute`。Docker overlay 使用下列 Runner 接入。 [Standard 预设][preset] · [Bash 工具][bash-tool] · [渲染器][bash-render] |
| Docker overlay 的 Bash 接入 | Harness 在解析宿主机目录和执行权限之前分派已授权的 Bash 请求，Runner 在工作区容器中执行。 [接入与参数](../packages/sandbox/harness-sandbox/README.zh.md) |
| 网页文件面板 | 上传、列表和下载分别检查工作区归属和文件路径。 [上传接口](../packages/api/workspace-upload/README.zh.md) · [列表与下载接口](../packages/api/workspace-artifacts/README.zh.md) |

Harness 在 `dsh-tool-bash.execute` 确认调用所属的会话和工作区，再把命令及取消信号交给 Runner。网页继续使用 Bash 工具卡片显示结果。 [Bash 分派][bash-tool] · [运行上下文][tool-context]

## 复用 Harness 的会话和工作区关系

网页从工作区新建会话时，把工作区 ID（`workspaceId`）传给后端。后端检查账号权限，用登记目录创建会话，并记录会话归属。多用户入口要求使用已授权的工作区。 [多用户权限](../packages/api/multiuser/README.zh.md) · [后端创建会话][session-create] · [工作区记录][workspace-registry]

Harness 按「会话 → 工作区 → 沙箱」找到命令该去哪里。用户新建会话或发消息时，后端检查其是否有权操作这个工作区。新消息通过检查后，Harness 先确认沙箱已开启，再处理消息。调用 Bash 时，Runner 用工作区 ID（`workspaceId`）定位已经开启的沙箱。工作区无效、沙箱已关闭或请求已取消时，工具直接返回错误。 [工具上下文][tool-context]

工作区 ID 已经表达了用户的选择，不另建任务实体、不按消息打标签，也不需要分类模型。切换工作区时打开目标工作区的会话；在原工作区开新会话仍会复用同一容器。

## 文件怎样留下

后端在 Harness 与 Docker 共用的工作区根目录下为每个工作区创建并登记一个目录。Runner 将该目录挂载到容器的 `/workspace`，供容器直接读写。 [登记工作区的接口][workspace-create] · [Docker 目录挂载][docker-bind] · [Docker 文件持久化][docker-volumes]

模型在沙箱里看到的是 `/workspace`。例如 `/workspace/月度汇总.xlsx` 和网页里 A 的「月度汇总.xlsx」是同一份文件。模型提供的路径只按沙箱里的目录解释。网页上传、列出和下载文件时，后端单独检查用户权限和文件路径。

网页使用工作区专用文件接口。后端在实际打开文件时把访问范围限定在登记目录内，拒绝通过符号链接越界。下载只提供普通文件。[工作区文件接口](../packages/api/workspace-artifacts/README.zh.md)

容器只挂载所属工作区，Harness 程序、SSH 文件、推理密钥和 Docker socket 位于容器外。Docker 容器与宿主机共用 Linux 内核，容器可在手动关闭、空闲回收或异常清理时销毁。 [赛题隔离要求][challenge] · [Docker 安全边界][docker-security]

Docker 回收后重用同一目录，文件误删恢复需要事先保存副本。使用 VFS 共享卷时，文件随卷保留，执行环境可独立回收。多会话 Vultr VM 后端在关闭时保存磁盘快照和供网页下载的文件副本。[Vultr VFS 工作区部署](VULTR-VFS.zh.md) · [Vultr 工作区 VM 的关闭与恢复](../docs/user/guide/workspace-vultr.zh.md#关闭与恢复)

## 密钥和工具怎样进入任务流程

Harness 使用当前请求所属账号的推理凭证。工作区权限与个人凭证权限分别校验，密钥保存在工作区之外。Harness 把凭证交给选定的推理传输层，沙箱只接收任务所需的数据。 [个人凭证与推理授权](../packages/api/user-credentials/README.zh.md) · [赛题凭证要求][challenge]

Skill 是给 Agent 的操作说明，有时会附带脚本。Harness 可以向模型提供经过审核的说明。需要在沙箱里用的程序或脚本，可以事先放进容器的基础镜像，或按清单提供只读副本。模型看到的是沙箱内的路径，脚本也在沙箱内运行。每个工作区只需拿到任务所需的文件。

## 有风险的文件操作

Bash 以普通用户身份运行，可以删除或覆盖当前工作区中有写权限的文件。Docker overlay 拒绝提权参数，脚本中的删除和覆盖也不会触发逐文件确认。沙箱隔离限制操作范围，工作区内的文件仍需按需备份。[Docker Bash 参数](../packages/sandbox/harness-sandbox/README.zh.md)

## Runner 接口与回收

Harness 和 Runner 是同一台 VM 上的两个服务，通过本机通信接口（Unix socket）交换执行请求和结果。只有 Runner 能通过 Docker Engine socket 创建和管理容器。目录和会话归属复用 Harness 的工作区记录。Runner 管理命令和容器状态，在容器上标记所属工作区，便于服务重启后找到遗留容器。

下文的手动控制和空闲回收适用于多会话 Docker 模式。单会话 Docker 模式在任务收尾后自动关闭容器。[Docker 任务模式](../docs/user/guide/workspace-sandboxes.zh.md#docker-task-modes)

| 内部操作 | 行为 |
| --- | --- |
| 开启沙箱 | 在多会话 Docker 模式下，手动开启和收到新消息时走同一条流程。如果该工作区已有运行中的沙箱，就直接复用。 |
| 执行 Bash | 输入由 Host 确认的 `workspaceId`、`expectedContainerId`、`executionId`、`command`、可选相对 `workdir` 和 `timeoutMs`。同一工作区的不同执行 ID 可以立即并行启动，共用容器的资源限制。同一代内，相同执行 ID 和参数的重试共享结果。 |
| 关闭沙箱 | 取消当时正在处理或等待的请求和命令，回收容器。会话和文件保留，关闭完成后可以重新开启。 |
| 读取状态 | 前端展示工作区文件和执行状态。容器重建信息留在运行记录或前端，不写进模型消息。 |

Runner 通过 Docker 启动并检查命令，默认从 `/workspace` 运行。Harness 沿用现有的 Bash 结果格式，分别接收普通输出、错误输出、退出码和超时状态，输出太长时也会标明是否截断。命令报错时，模型可以根据真实错误继续修正。如果无法确定上一条命令是否已经启动，Runner 不会自动再跑一遍。参赛版不提供后台运行或提升权限的工具选项。 [Docker 命令接口][docker-exec] · [Bash 返回值][bash-result]

- **命令完成。** Runner 通过镜像中的监管程序等待该次执行的进程树清理，再返回真实退出码和输出，包括非零退出。
- **命令超时或取消。** Runner 按 `executionId` 停止本次命令及其子进程。单次清理确认后，其他执行可以继续。若无法确认清理，Runner 停止接纳该代的新执行并尝试回收容器，确认移除后才允许重开。回收会结束同一容器中的其他在途命令，工作区保留已写入的文件。[Runner 进程清理](SANDBOX-RUNNER.zh.md#进程清理交接)
- **空闲回收。** 工作区里没有正在处理的会话请求，也没有正在执行或清理的命令时开始计时。工作区连续 30 分钟没有新活动，就销毁当前容器。新请求被接纳后停止计时，处理结束后重新计时。
- **手动关闭。** 用户点「关闭沙箱」后，系统先把当时正在处理或等待的请求标记为取消，再停止命令并回收容器。迟到的工具调用直接拒绝，即使沙箱后来重新打开，也不能接着执行旧请求。关闭过程中，网页提示用户等关闭完成。关闭完成后，只有手动开启或发送新消息才会启动新容器。网页仍能查看和下载产物。
- **异常退出。** 同一工作区一次只允许一个容器。Runner 确认旧容器已删除后，才允许创建新容器。服务重启时，Runner 根据容器上的工作区标记清理遗留容器。

沙箱使用固定摘要的镜像，命令以普通用户身份运行，系统目录只读，网络关闭。Docker 保留默认的系统调用限制，移除额外权限（`cap-drop=ALL`、`no-new-privileges`）。每个容器限制为 1 个虚拟 CPU、512 MiB 内存、64 个进程和 32 MiB 临时空间。单条命令默认最多运行 30 秒，最长 60 秒，普通输出和错误输出各保留最多 64 KiB。一个 Runner 同时最多运行两个沙箱。[Runner 镜像和限制](../packages/sandbox/sandbox-runner/docs/README.zh.md)

两个沙箱都占用时，如果第三个工作区需要开启，网页提示「沙箱已满，请关闭一个或稍后重试」。这次开启请求不排队。已有沙箱的工作区可以继续复用自己的沙箱。

## Bash 路径与网页文件

模型可以把 `pwd` 返回的 `/workspace/src` 原样用作下一次 Bash 的 `workdir`。Harness 也接受 `src` 和 `./src`，三者都转换为 Runner 接收的相对路径 `src`。工作区外的绝对路径和含 `..` 路径段的路径会在请求发给 Runner 前被拒绝。网页文件面板以登记目录为根，因此文件 `/workspace/src/result.xlsx` 对应网页的 `src/result.xlsx`。[Bash 路径约定](../packages/sandbox/harness-sandbox/README.zh.md)

## 演示准备

演示前确定访客账号的发放方式和可用的演示工作区，再用多用户入口核对访客的会话、文件和沙箱操作权限。涉及 Skill 的演示需核对所需程序与脚本在容器镜像中可用。Docker 部署若要提供误删恢复，需要另外决定工作区副本的保存时间和恢复权限。[访客工作台指南](../docs/user/guide/antfarm-guest-workbench.zh.md)

## 部署检查

用两个账号确认工作区权限，检查沙箱可启动、Bash 能读写自己的目录、网页能下载产物。关闭并重新开启沙箱后，确认工作区文件仍可访问。[启动与本机调用](SANDBOX-RUNNER.zh.md)

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
