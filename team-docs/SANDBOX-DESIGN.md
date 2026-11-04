# Agent Rush 工作区沙箱设计

这份设计让 DeepSeek 在网页里继续调用 Bash，同时把命令交给独立的 Docker 容器执行。每个工作区有自己的文件目录，需要执行命令时才启动容器。容器销毁后，工作区里的脚本和结果仍然保留。

## 文档里的几个角色

| 名称 | 在本项目里的意思 |
| --- | --- |
| fork（团队仓库） | 团队在 GitHub 上从原版 DeepSeek Harness 派生出的独立仓库。本文引用的代码来自这份仓库，团队也在这里维护参赛版本。 |
| DeepSeek Harness（简称 Harness） | 网页和模型之间的应用。它保存会话，调用 DeepSeek，并根据模型的回复发起 Bash 等工具调用。文中的 **Host** 指 Harness 的后端，**Agent** 指在一个会话里调用模型和工具的程序。 |
| Runner（命令执行服务） | 本方案新增的后端服务。它接收 Host 发来的工作区 ID 和 Bash 命令，在对应的容器里运行命令，把输出和退出码交还给 Harness，并负责创建、复用和销毁容器。 |
| 沙箱 | 本方案用来执行命令的 Docker 容器。文中的**宿主机**指运行 Harness、Runner 和 Docker 的 Vultr VM。 |
| 工作区 | 网页里用于组织一次任务的空间，包含文件目录和一个或多个会话。会话各有聊天记录，同一工作区内的会话共享文件。 |

例如，模型要运行 `python main.py`，Harness 先查这个会话属于哪个工作区，再把命令交给 Runner。Runner 在该工作区的沙箱里执行，把输出和退出码交还给 Harness，由 Harness 返回给模型并显示在网页里。

现有版本已在 `agentrush-dsh` 上验证 DeepSeek 对话和 Bash 结果回传。验证时用的是 Linux 的 Landlock 文件访问限制，内核只支持其中一部分。本文的 Docker 方案尚未实施。 [赛题要求][challenge]

## 已对齐的行为

- **一个 Harness 工作区就是一个任务边界。** 用户沿用 Web UI 的工作区和新建会话入口。工作区 A、B 各有自己的持久目录；文件留在各自工作区，需要共享时显式复制。
- **每个工作区最多有一个活跃容器。** 同一个工作区的多个会话共享文件和执行容器，各自保留自己的聊天记录。空闲回收后，A 的下一次命令从预构建镜像启动新容器并挂回 A 的工作区。只写入容器临时目录的文件随容器消失。
- **模型沿用 `bash` 工具。** Harness 把命令转交给 Runner。工具结果照常包含退出码、标准输出（stdout）和错误输出（stderr）。网页可以展示容器创建或回收状态；模型仍会看到命令实际产生的输出。

例如，在工作区 A 的第一个会话生成 `main.py`，新建第二个会话继续运行它，结果仍写进 A。即使两次执行之间回收了容器，新容器也能读到这个文件。在工作区 B 里执行同样的命令，只会访问 B 的文件。

## 团队仓库目前怎样执行 Bash

| 位置 | 当前职责 |
| --- | --- |
| Agent Loop → Native Tool Executor | Agent Loop 从模型回复里取出工具调用，经 `ctx.tools.execute` 交给对应工具。Harness 记录调用和结果（`tool/call`、`tool/result`），让模型在下一步看到结果。 [调用入口][loop-tools] · [工具上下文][tool-context] · [结果提交][tool-log] |
| `dsh-tool-bash` | 标准工具配置（Standard 预设）启用 `bash`。该工具检查参数，获取工作目录、权限和 `DSH_*` 环境变量，然后调用 `ctx.shell.resolve` 和 `ctx.shell.execute`。模型和网页都能收到结果。 [Standard 预设][preset] · [Bash 工具][bash-tool] · [渲染器][bash-render] |
| `dsh-bash-sandbox` → `dsh-bash-local` → `dsh-subprocess-local` | `SandboxBashExecutor` 先通过 `ctx.sandbox.confine` 应用本机执行限制，再由本地执行器通过 `ctx.subprocess.spawn` 启动 Bash，收集输出和退出状态。 [沙箱执行器][bash-sandbox] · [本地启动][bash-local] |
| 文件工具与网页文件面板 | Harness 自带的 `read/write/edit` 通过 `ctx.fs` 访问文件，默认目录来自 `ctx.workingDirectory.ensure`。Bash 改到容器里执行后，文件工具和网页面板也要按同一工作区定位文件，并各自限制可以访问的路径。 [文件工具工作目录][file-cwd] · [读取][file-read] · [写入][file-write] |

参赛版本在 **`dsh-tool-bash.execute`** 接入 Runner。先确认调用所属的会话和工作区，再把命令交给 Runner，并转发该次执行的取消信号。这一步发生在解析宿主机工作目录、收集本机环境变量、申请本机权限升级或启动本机 Bash 之前。Harness 复用原有的工具名、参数、结果格式和网页工具卡片。 [Bash 分派][bash-tool] · [运行上下文][tool-context]

## 复用 Harness 的会话和工作区关系

在 fork 的标准 Web UI 中，从工作区新建会话时，客户端把 `workspaceId` 传给 `session/create`。Host 以该工作区的路径创建会话，并将会话加入工作区的 `sessionIds`。注册表对同一规范化目录复用已有工作区，`attachSession` 还会检查会话记录里的 `cwd` 与工作区路径一致。底层 API 也允许只传 `cwd` 或使用默认目录，所以“必须绑定工作区”是参赛入口的约束。 [Web 新建会话][web-session] · [Host 创建会话][session-create] · [注册表][workspace-registry] · [会话归属校验][workspace-membership]

**路由：`sessionId → workspaceId → 当前 sandboxId`。** 参赛入口新建会话时要求提供已授权的受管理 `workspaceId`。Bash 工具从执行上下文中的 Agent 取会话 ID，Host 按现有注册表查唯一归属，把确认过的 `workspaceId` 交给 Runner。Runner 按工作区查找容器，首次执行时创建，回收后按需重建。缺少有效归属时返回工具错误，不回退到本机 Bash。 [工具上下文][tool-context]

工作区 ID 已经表达了用户的选择，不另建任务实体、不按消息打标签，也不需要分类模型。切换工作区时打开目标工作区的会话；在原工作区开新会话仍会复用同一容器。

## 文件怎样留下

同一台 Vultr VM 上，参赛入口由后端在专用数据根下分配目录，例如 `/var/lib/agentrush-runner/workspaces/<目录ID>`，再通过 Harness 现有注册表注册该目录，取得 `workspaceId`。Runner 只接受已注册的受管理目录，把该目录以读写方式挂到容器的 `/workspace`。禁止在参赛入口把任意宿主路径注册成可执行工作区，现有文件可显式导入。Bash 写到 `/workspace` 的文件立即落到工作区目录，销毁容器时保留，无需在每条命令前后复制。 [工作区注册入口][workspace-create] · [Docker bind mounts][docker-bind] · [持久卷与容器生命周期][docker-volumes]

Harness 原生文件工具和前端文件列表从同一个授权工作区解析文件根，展示容器逻辑路径或工作区相对路径。容器返回的路径和用户传入的绝对路径都不能直接变成宿主文件路径。宿主上级目录不挂载给任何容器。跨工作区复制文件时，服务端分别检查源和目标权限。

读、写、编辑、预览和下载都必须限制在授权的工作区目录内。例如，容器可以创建一个指向宿主机其他目录的符号链接，也可能在路径检查通过后、文件打开前替换它。文件接口要在实际打开文件时约束访问范围。下载只提供普通文件。首版用哪些接口见[待决定](#待决定)。

赛题允许容器运行代码，要求执行进程不接触宿主或应用运行环境、沙箱内无凭证、每次运行有时间与内存限制、任务结束后重置或销毁沙箱。这里将工作区作为任务的输入与产物边界，只把任务数据目录挂给容器。Harness 程序目录、推理凭证、SSH 文件、其他任务目录和 Docker socket 都在挂载边界之外。Docker 容器仍与 VM 共享内核。若希望控制端不直接访问工作区目录，可改用任务独立的 Docker 命名卷，经 Runner 文件接口取回产物，路由规则不变。 [赛题隔离要求][challenge] · [Docker 安全边界][docker-security]

## Runner 接口与回收

Harness 和 Runner 是同一台 VM 上的两个服务，通过本机通信接口（Unix socket）交换执行请求和结果。只有 Runner 能通过 Docker Engine socket 创建和管理容器。目录和会话归属复用 Harness 现有的工作区注册表，任务结束状态随工作区保存。Runner 负责命令和容器状态，并在 Docker 容器标签里记录工作区 ID 和容器代次，便于重启后识别旧容器。

| 内部操作 | 行为 |
| --- | --- |
| 执行 Bash | 输入由 Host 确认的 `workspaceId`、`executionId`、`command`、可选相对 `workdir` 和 `timeoutMs`。同一工作区同时只执行一条命令，本次清理完成后才启动下一条。同一执行 ID 不重复启动。 |
| 结束工作区任务 | 先禁止该工作区接收新执行，再移除容器。工作区和会话记录保留，文件仍可查看和下载。 |
| 读取状态 | 前端展示工作区文件和执行状态。容器重建信息留在运行记录或前端，不写进模型消息。 |

Runner 用 Docker Engine 的 `ExecCreate → ExecStart → ExecInspect` 执行 `/bin/bash -c <command>`，把命令作为单独参数传给容器。默认目录是 `/workspace`，`workdir` 只接受该目录下的相对位置。关闭 TTY 并分开采集 stdout 和 stderr，按原来的 `foreground` 结构回传退出码、截断和超时。非零退出码是可用于修复的真实结果。Runner 错误单独分类，无法确定是否已经执行的请求不自动重放。参赛预设禁用后台晋升和提升权限入口。 [Docker Exec API][docker-exec] · [Bash 结果形状][bash-result]

- **命令完成。** Runner 返回真实退出码和输出，包括非零退出。确认本次执行的进程已清理后，后续会话或消息可继续复用容器。
- **命令超时或取消。** Runner 按 `executionId` 停止本次命令及其子进程。Harness 通过本次调用的 `exec.signal` 传递取消。确认相关进程均已退出后保留容器。若清理失败或无法确认所有相关进程都已退出，销毁该代容器，确认销毁后才允许再次执行。工作区中已经写入的文件保留。 [工具取消信号][tool-context]
- **空闲回收。** 工作区没有正在执行、正在清理或等待执行的命令时开始计时。收到新的执行请求并接纳后停止计时，连续空闲 30 分钟则回收容器。工作区保持可用，下次 Bash 执行时创建新容器并挂回原目录。
- **主动结束。** 用户点“结束工作区任务”时，先关闭该工作区的执行入口，再立即回收容器并终止其中仍在运行的进程。已接纳但尚未开始的命令结束等待并返回取消，工作区产物仍可查看和下载。
- **异常退出。** 创建、执行和销毁按 `workspaceId` 协调，关闭中的旧代确认已删除后才允许下一代。Runner 重启按专用标签清理遗留容器，工作区继续保留。Docker 响应不确定时先核对实际资源，只有确认不存在才记录已销毁。

容器先用固定 digest 的本地镜像、非 root UID、只读根文件系统、无外网、默认 seccomp、`cap-drop=ALL` 与 `no-new-privileges`。只挂任务目录，`/tmp` 用 32 MiB tmpfs。起步限制为每容器 1 vCPU、512 MiB RAM、64 个进程，单命令默认 30 秒、最多 60 秒，每路输出 64 KiB，同时最多 2 个容器。持久 workspace 的磁盘容量也要有实际配额，目录本身没有容量上限，需在 VM 上验证底层配额能力后再对外开放。 [Docker 运行参数][docker-run] · [Docker 资源限制][docker-resources]

## 待决定

### 1. 首版开放哪些文件功能？

Agent 需要读写任务文件，队友需要在网页查看和下载结果。目前网页的文件读取接口（`workspaceFiles.read`）允许读取工作区外的文件，Agent 自带的 `read` 工具也通过宿主机读取。把 Bash 放进容器之后，这两条路径依然要单独限制。 [网页文件读取][workspace-file-read] · [Agent 文件读取][file-read]

建议首版让 Agent 在容器里用 Bash 读写文件，网页通过 Runner 列出和下载工作区内的文件。是否保留自带的读写工具或网页预览，取决于对应接口能否限制文件访问范围。验收时尝试直接读取宿主机路径、通过符号链接越界，以及在检查通过后替换链接，确认这些操作都读不到工作区外的文件。

### 2. 演示访客怎么进入，能操作哪些工作区？

Harness 能查出某个会话属于哪个工作区。访客能否操作它，需要 Host 另行判断。团队仓库里的 `owner` 身份默认放行所有远程操作，因此建议演示访客使用权限受限的身份。 [远程访问控制][remote-access]

需要决定访客怎么进入演示，以及每个身份能使用哪些工作区。Host 在访客给已有会话发消息、列出或下载文件、结束工作区时都要核验权限。用两个身份验收。例如只被授权访问 A 的访客，即使知道 B 的会话 ID，也不能给 B 发消息、读文件或结束 B。

### 3. Runner 怎么确认本次命令留下的进程都停了？

一条 Bash 命令可以启动其他进程。例如 `sleep 300 >/dev/null 2>&1 &` 会让 Bash 很快返回，`sleep` 仍可能在后台运行。Runner 需要知道哪些进程来自本次执行，并确认这些进程确实退出，才能把容器交给下一条命令。 [Docker Exec][docker-exec]

回收规则已经确定。待定的是 Runner 用什么机制跟踪本次 `executionId` 启动的进程，以及用什么证据确认清理完成。验收要覆盖 Bash 已正常退出但子进程仍在运行的情况。

### 4. 模型传给 Bash 的目录和网页打开的文件怎样对应？

假设模型运行 `pwd` 得到 `/workspace/src`，它很可能把这个值直接用作下一次命令的工作目录（`workdir`）。Runner 接口只收工作区内的相对路径，这个例子对应 `src`。建议 Host 接受这两种写法，统一转换后把 `src` 传给 Runner。 [Bash 路径和返回值][bash-path]

还要确定工具结果里的当前目录（`cwd`）和网页文件面板用哪种路径显示。验收时把 `pwd` 的结果原样传给下一次 Bash 调用，从网页打开同一目录下的产物，并确认指向工作区外的路径会被拒绝。

## 最小实施与验收

1. 实现 Runner 并复用工作区注册表。用工作区 A 的两个会话执行命令，两者读取到同一个标记且容器 ID 相同。回收 A 的容器后再次执行，容器 ID 变化，标记仍在。工作区 B 不能读到 A 的标记。
2. 接通参赛预设。用 Vultr DeepSeek 在 A 中跨会话创建、编辑并运行同一个 Python 文件，核对工具轨迹的 stdout、stderr、退出码和前端产物。切到 B 执行相同命令，确认命中 B。验证仅提交 `cwd` 无法通过参赛入口创建会话，无工作区归属、归属非受管理目录或无权访问的会话无法执行。
3. 验证文件和进程边界。用合成凭证证明容器无法读到 Harness 的文件，验证容器无网络、时间与内存限制生效，以及容器制造的链接无法让宿主文件面板读取其他目录。验证命令超时和取消后，相关进程都已退出且下一条命令复用同一容器。模拟无法确认清理完成，验证旧容器销毁后才允许重建。验证连续空闲 30 分钟后回收、再次执行能看到原文件，以及主动结束时立即回收、后续执行被拒绝、产物仍可下载。Runner 重启后也应清理遗留容器。
4. 对外开放前固定参赛预设，封住可绕过 Runner 的本地 Bash、PTY、PTC、动态插件等执行路径。确认原生文件工具和前端预览只访问授权任务目录。当前团队 SSH 访问方式继续用于内部验证。 [Web 预设][preset] · [赛题要求][challenge]

[challenge]: https://lablab.ai/ai-hackathons/vultr-hackathon
[loop-tools]: ../packages/core/agent-loop/src/agent.ts#L587
[tool-context]: ../packages/core/tools/src/contracts.ts#L174
[tool-log]: ../packages/core/tools/src/batch.ts#L252
[preset]: ../packages/bundle/web-app/presets/standard.patch.yml#L5
[bash-tool]: ../packages/shell/tool-bash/src/index.ts#L478
[bash-result]: ../packages/shell/tool-bash/src/index.ts#L155
[bash-render]: ../packages/shell/tool-bash/src/render.ts#L28
[bash-sandbox]: ../packages/shell/bash-sandbox/src/index.ts#L89
[bash-local]: ../packages/shell/bash-local/src/index.ts#L259
[file-cwd]: ../packages/fs/tool-fs/src/session-cwd.ts#L23
[file-read]: ../packages/fs/tool-fs/src/read.ts#L147
[file-write]: ../packages/fs/tool-fs/src/write.ts#L124
[web-session]: ../packages/client/ui-workspace/src/client/navigation.ts#L235-L249
[session-create]: ../packages/api/session-controller/src/commands.ts#L103-L141
[workspace-registry]: ../packages/workspace/workspace/src/index.ts#L510-L526
[workspace-membership]: ../packages/workspace/workspace/src/entity.ts#L110-L149
[workspace-create]: ../packages/api/workspace-controller/src/commands.ts#L40-L54
[workspace-file-read]: ../packages/api/workspace-files/src/index.ts#L226-L246
[remote-access]: ../packages/api/remote-access/README.md#L25-L33
[bash-path]: ../packages/shell/tool-bash/src/index.ts#L146-L167
[docker-bind]: https://docs.docker.com/engine/storage/bind-mounts/
[docker-volumes]: https://docs.docker.com/engine/storage/volumes/
[docker-security]: https://docs.docker.com/engine/security/
[docker-exec]: https://docs.docker.com/reference/api/engine/version/v1.51/#tag/Exec
[docker-run]: https://docs.docker.com/reference/cli/docker/container/run/
[docker-resources]: https://docs.docker.com/engine/containers/resource_constraints/
