# Agent Rush 工作区沙箱设计

用户在网页上打开一个工作区，就能在自己的文件和会话里继续任务。模型列目录、读写文件和运行脚本，都在该工作区的沙箱里完成。沙箱可以销毁和重建，工作区里的文件和结果会保留。

## 文档里的几个角色

| 名称 | 在本项目里的意思 |
| --- | --- |
| fork（团队仓库） | 团队在 GitHub 上从原版 DeepSeek Harness 派生出的独立仓库。本文引用的代码来自这份仓库，团队也在这里维护参赛版本。 |
| DeepSeek Harness（简称 Harness） | 网页和模型之间的应用。它保存会话，调用 DeepSeek，并根据模型的回复发起 Bash 等工具调用。文中的 **Host** 指 Harness 的后端，**Agent** 指在一个会话里调用模型和工具的程序。 |
| Runner（命令执行服务） | 本方案新增的后端服务。它根据 Harness 发来的工作区 ID 找到对应沙箱，在里面执行命令或文件操作，把结果交还给 Harness，并负责创建、复用和回收沙箱。 |
| 沙箱 | 本方案用来执行命令的 Docker 容器。文中的**宿主机**指运行 Harness、Runner 和 Docker 的 Vultr VM。 |
| 工作区 | 网页里用于组织一次任务的空间，包含文件目录和一个或多个会话。会话各有聊天记录，同一工作区内的会话共享文件。 |

例如，用户在工作区 A 上传 `销售明细.xlsx`，让模型汇总每月销售额。Harness 查到会话属于 A，Runner 就在 A 的沙箱里列目录、读表格和运行处理脚本。生成的 `月度汇总.xlsx` 出现在 A 的文件列表，用户可以下载。沙箱回收后，在 A 里继续任务还能打开同一份表格。

现有版本已在 `agentrush-dsh` 上验证 DeepSeek 对话和 Bash 结果回传。验证时用的是 Linux 的 Landlock 文件访问限制，内核只支持其中一部分。本文的 Docker 方案尚未实施。 [赛题要求][challenge]

## 首版要做什么

- **多用户。** 每个人用自己的账号登录，只能操作自己有权限的工作区、会话和文件。同一个工作区可以开多个会话，聊天记录各自保存，文件共用。
- **按用户管理密钥。** 首版提供单独的密钥管理入口，由后端按用户保存和控制使用权限。首版是否接入真实的外部服务，仍待决定。
- **开启沙箱。** 每个工作区最多有一个正在运行的沙箱。用户可以在网页点「开启沙箱」。沙箱处于关闭状态时，发送消息也会先开启沙箱，再继续处理。第一次启动可能需要稍等。
- **在沙箱里操作文件和运行命令。** 首版只向模型开放 Bash 来列目录、读写文件和运行脚本。`ls` 默认列出当前工作区的文件。原有的 `read/write/edit` 等工具会逐个改造，确认操作发生在沙箱内后再开放。网页仍提供文件上传、列表和下载。
- **关闭沙箱并保留产物。** 用户可以在网页关闭沙箱，系统也会在工作区空闲 30 分钟后自动回收。会话记录、上传文件和写入工作区的产物可以继续查看或下载。

工作区 A 的沙箱只能操作 A 的任务数据。在 B 里执行同样的命令，只能看到 B 自己的文件。需要共享文件时，由用户明确复制，服务端检查对两个工作区的权限。

## 团队仓库目前怎样执行 Bash

| 位置 | 当前职责 |
| --- | --- |
| Agent Loop → Native Tool Executor | Agent Loop 从模型回复里取出工具调用，经 `ctx.tools.execute` 交给对应工具。Harness 记录调用和结果（`tool/call`、`tool/result`），让模型在下一步看到结果。 [调用入口][loop-tools] · [工具上下文][tool-context] · [结果提交][tool-log] |
| `dsh-tool-bash` | 标准工具配置（Standard 预设）启用 `bash`。该工具检查参数，获取工作目录、权限和 `DSH_*` 环境变量，然后调用 `ctx.shell.resolve` 和 `ctx.shell.execute`。模型和网页都能收到结果。 [Standard 预设][preset] · [Bash 工具][bash-tool] · [渲染器][bash-render] |
| `dsh-bash-sandbox` → `dsh-bash-local` → `dsh-subprocess-local` | `SandboxBashExecutor` 先通过 `ctx.sandbox.confine` 应用本机执行限制，再由本地执行器通过 `ctx.subprocess.spawn` 启动 Bash，收集输出和退出状态。 [沙箱执行器][bash-sandbox] · [本地启动][bash-local] |
| 文件工具与网页文件面板 | 现有的 `read/write/edit` 通过 `ctx.fs` 访问文件，默认目录来自 `ctx.workingDirectory.ensure`。这些工具改为在沙箱内操作之前，不在参赛版中开放。网页面板有单独的文件接口，按工作区检查权限和路径。 [文件工具工作目录][file-cwd] · [读取][file-read] · [写入][file-write] |

参赛版本在 **`dsh-tool-bash.execute`** 接入 Runner。先确认调用所属的会话和工作区，再把命令交给 Runner，并转发该次执行的取消信号。这一步发生在解析宿主机工作目录、收集本机环境变量、申请本机权限升级或启动本机 Bash 之前。Harness 复用原有的工具名、参数、结果格式和网页工具卡片。 [Bash 分派][bash-tool] · [运行上下文][tool-context]

## 复用 Harness 的会话和工作区关系

现有网页从工作区新建会话时，已经会把工作区 ID（`workspaceId`）传给后端。后端用该工作区的目录创建会话，并记录会话归属。现有接口还支持直接指定目录，参赛入口统一要求先选择有权限的工作区。 [网页新建会话][web-session] · [后端创建会话][session-create] · [工作区记录][workspace-registry] · [会话归属检查][workspace-membership]

Harness 按「会话 → 工作区 → 沙箱」找到命令该去哪里。用户新建会话或发消息时，后端检查其是否有权操作这个工作区。新消息通过检查后，Harness 先确认沙箱已开启，再处理消息。调用 Bash 时，Runner 用工作区 ID（`workspaceId`）定位已经开启的沙箱。工作区无效、沙箱已关闭或请求已取消时，工具直接返回错误。 [工具上下文][tool-context]

工作区 ID 已经表达了用户的选择，不另建任务实体、不按消息打标签，也不需要分类模型。切换工作区时打开目标工作区的会话；在原工作区开新会话仍会复用同一容器。

## 文件怎样留下

后端在 Vultr VM 的专用位置为每个工作区创建一个目录，并登记到 Harness。Runner 把这一个目录接到容器的 `/workspace`，让容器能直接读写工作区里的文件。这种连接也叫挂载。用户可以上传或导入文件，工作区目录由后端分配。 [登记工作区的接口][workspace-create] · [Docker 目录挂载][docker-bind] · [Docker 文件持久化][docker-volumes]

模型在沙箱里看到的是 `/workspace`。例如 `/workspace/月度汇总.xlsx` 和网页里 A 的「月度汇总.xlsx」是同一份文件。模型提供的路径只按沙箱里的目录解释。网页上传、列出和下载文件时，后端单独检查用户权限和文件路径。

网页的文件接口只允许访问授权的工作区目录。例如，容器可以创建一个指向宿主机其他目录的符号链接，也可能在路径检查通过后、文件打开前替换它。文件接口要在实际打开文件时约束访问范围。下载只提供普通文件。现有的网页读取接口允许访问工作区外的文件，参赛版需要使用限制在工作区内的接口。 [现有网页读取接口][workspace-file-read]

沙箱只得到自己的任务数据和经过批准的只读工具文件。Harness 程序目录、其他工作区、SSH 文件、推理密钥和 Docker 管理接口都留在沙箱外。每条命令受时间限制，容器受内存等资源限制，任务结束后销毁执行环境。Docker 容器与宿主机共用 Linux 内核。 [赛题隔离要求][challenge] · [Docker 安全边界][docker-security]

Vultr 自动备份和手动快照用于恢复整台 VM 的磁盘。保留工作区用于在沙箱重建后接着做任务。恢复误删的单个工作区需要单独保存一份可恢复的副本，是否在首版提供见下文。 [Vultr 自动备份][vultr-backups] · [Vultr 快照][vultr-snapshots]

## 密钥和工具怎样进入任务流程

推理服务的密钥由 Harness 使用。用户自己的 API 密钥和登录凭证通过专门的网页表单提交，由后端按用户保管。如果接入外部服务，后端按发起当前请求的用户检查凭证的使用权限，再代为请求。多人共用一个工作区时，工作区权限不会自动授予其他人的密钥使用权。模型和沙箱只接收任务需要的结果，密钥值不进入聊天、命令参数、日志或工作区文件。 [赛题凭证要求][challenge]

赛题要求沙箱内没有 API 密钥或凭证。首版的表格处理演示不需要用户提供凭证，也不依赖外部服务接入。需要在沙箱里生成临时密钥的测试，先向主办方确认规则。工作区的恢复流程不保存密钥。 [赛题凭证要求][challenge]

Skill 是给 Agent 的操作说明，有时会附带脚本。Harness 可以向模型提供经过审核的说明。需要在沙箱里用的程序或脚本，可以事先放进容器的基础镜像，或按清单提供只读副本。模型看到的是沙箱内的路径，脚本也在沙箱内运行。每个工作区只需拿到任务所需的文件。

## 有风险的文件操作

删除文件等操作即使在沙箱里，也可能破坏当前工作区。对于纳入审批范围的删除或覆盖，Harness 会在网页上展示影响范围，等有权限的用户确认后再交给 Runner。用户拒绝时，操作不执行。现有 Bash 审批用于申请更高权限，普通命令和脚本里的删除不会自动触发它。首版要为哪些操作提供确认，见「待决定」。沙箱负责把影响限制在当前工作区内。 [现有 Bash 审批入口][bash-approval]

## Runner 接口与回收

Harness 和 Runner 是同一台 VM 上的两个服务，通过本机通信接口（Unix socket）交换执行请求和结果。只有 Runner 能通过 Docker Engine socket 创建和管理容器。目录和会话归属复用 Harness 的工作区记录。Runner 管理命令和容器状态，在容器上标记所属工作区，便于服务重启后找到遗留容器。

| 内部操作 | 行为 |
| --- | --- |
| 开启沙箱 | 手动开启和收到新消息时走同一条流程。如果该工作区已有运行中的沙箱，就直接复用。 |
| 执行 Bash | 输入由 Host 确认的 `workspaceId`、`expectedContainerId`、`executionId`、`command`、可选相对 `workdir` 和 `timeoutMs`。同一工作区的不同执行 ID 可以立即并行启动，共用容器的资源限制。同一代内，相同执行 ID 和参数的重试共享结果。 |
| 关闭沙箱 | 取消当时正在处理或等待的请求和命令，回收容器。会话和文件保留，关闭完成后可以重新开启。 |
| 读取状态 | 前端展示工作区文件和执行状态。容器重建信息留在运行记录或前端，不写进模型消息。 |

Runner 通过 Docker 启动并检查命令，默认从 `/workspace` 运行。Harness 沿用现有的 Bash 结果格式，分别接收普通输出、错误输出、退出码和超时状态，输出太长时也会标明是否截断。命令报错时，模型可以根据真实错误继续修正。如果无法确定上一条命令是否已经启动，Runner 不会自动再跑一遍。参赛版不提供后台运行或提升权限的工具选项。 [Docker 命令接口][docker-exec] · [Bash 返回值][bash-result]

- **命令完成。** Runner 返回各执行的真实退出码和输出，包括非零退出。每条命令的进程树清理由 #9 交付。
- **命令超时或取消。** #9 按 `executionId` 停止本次命令及其子进程，其他已启动的命令可以继续。Harness 通过本次调用的 `exec.signal` 传递取消。若清理失败或无法确认进程已退出，先销毁该代容器，再允许重新执行。销毁会结束该容器中的其他在途命令，工作区已写入的文件保留。[工具取消信号][tool-context]
- **空闲回收。** 工作区里没有正在处理的会话请求，也没有正在执行或清理的命令时开始计时。工作区连续 30 分钟没有新活动，就销毁当前容器。新请求被接纳后停止计时，处理结束后重新计时。
- **手动关闭。** 用户点「关闭沙箱」后，系统先把当时正在处理或等待的请求标记为取消，再停止命令并回收容器。迟到的工具调用直接拒绝，即使沙箱后来重新打开，也不能接着执行旧请求。关闭过程中，网页提示用户等关闭完成。关闭完成后，只有手动开启或发送新消息才会启动新容器。网页仍能查看和下载产物。
- **异常退出。** 同一工作区一次只允许一个容器。Runner 确认旧容器已删除后，才允许创建新容器。服务重启时，Runner 根据容器上的工作区标记清理遗留容器。

沙箱使用固定版本的镜像，命令以普通用户身份运行，系统目录只读，网络关闭。实现时保留 Docker 默认的系统调用限制，关闭额外权限（`cap-drop=ALL`、`no-new-privileges`）。每个容器的初始限制是 1 个虚拟 CPU、512 MiB 内存、64 个进程和 32 MiB 临时空间。单条命令默认最多运行 30 秒，最长可设到 60 秒，普通输出和错误输出各保留最多 64 KiB。同一台 VM 初始最多运行两个沙箱。工作区的文件另外设磁盘容量上限，开放演示前需要在 VM 上确认它确实生效。 [Docker 运行参数][docker-run] · [Docker 资源限制][docker-resources]

两个沙箱都占用时，如果第三个工作区需要开启，网页提示「沙箱已满，请关闭一个或稍后重试」。这次开启请求不排队。已有沙箱的工作区可以继续复用自己的沙箱。

## 待决定

### 1. 哪些文件工具优先改造？

首版用 Bash 完成文件操作。后续需要决定先改造 `read`、`write` 还是 `edit`，以及网页是否要增加文件预览。每个工具开放前都要验证它在沙箱里操作文件。网页预览开放前，也要验证它只能读取授权工作区内的文件。

### 2. 演示访客怎么进入，能操作哪些工作区？

Harness 能查出某个会话属于哪个工作区。访客能否操作它，需要 Host 另行判断。团队仓库里的 `owner` 身份默认放行所有远程操作，因此建议演示访客使用权限受限的身份。 [远程访问控制][remote-access]

需要决定访客怎么进入演示，以及每个身份能使用哪些工作区。Host 在访客给已有会话发消息、列出或下载文件、开启或关闭沙箱时都要核验权限。用两个身份验收。例如只被授权访问 A 的访客，即使知道 B 的会话 ID，也不能给 B 发消息、读文件或关闭 B 的沙箱。

### 3. Runner 怎么确认本次命令留下的进程都停了？

一条 Bash 命令可以启动其他进程。例如 `sleep 300 >/dev/null 2>&1 &` 会让 Bash 很快返回，`sleep` 仍可能在后台运行。Runner 需要按执行 ID 识别和清理这条命令留下的进程，使同一容器中的其他执行可以继续。[Docker Exec][docker-exec]

回收规则已经确定。待定的是 Runner 用什么机制跟踪本次 `executionId` 启动的进程，以及用什么证据确认清理完成。验收要覆盖 Bash 已正常退出但子进程仍在运行的情况。

### 4. 模型传给 Bash 的目录和网页打开的文件怎样对应？

假设模型运行 `pwd` 得到 `/workspace/src`，它很可能把这个值直接用作下一次命令的工作目录（`workdir`）。Runner 接口只收工作区内的相对路径，这个例子对应 `src`。建议 Host 接受这两种写法，统一转换后把 `src` 传给 Runner。 [Bash 路径和返回值][bash-path]

还要确定工具结果里的当前目录（`cwd`）和网页文件面板用哪种路径显示。验收时把 `pwd` 的结果原样传给下一次 Bash 调用，从网页打开同一目录下的产物，并确认指向工作区外的路径会被拒绝。

### 5. 首版是否接入外部服务，要提供哪些 Skill？

首版确定提供按用户保管密钥的入口。还需决定是否在首版跑通一次真实的外部请求。如果要接入，再确定服务、用户怎样授权和撤销，以及如何验证另一位用户不能用这把密钥。

Skill 方面，先列出首版演示需要的说明和脚本，确认模型能在沙箱里找到并运行这些脚本。选用哪些 Skill 和工具，由实际演示任务决定。

### 6. 哪些操作需要用户确认？

先确定哪些删除或覆盖操作能在执行前可靠识别，以及网页怎样显示将受影响的文件。用演示文件验证用户拒绝时文件仍在。另用脚本直接修改文件，验证即使没有弹出确认，影响也限制在当前工作区。脚本可以间接删除文件，单凭命令里是否出现 `rm` 无法判断。

### 7. 回收前要额外留一份文件副本吗？

重开沙箱时，系统会重新挂载同一个工作区，已经保存的上传文件和结果可以直接使用。还需要确认首版是否在回收前额外复制一份工作区文件。如果目的是找回误删文件，副本必须在误删之前生成。只有回收时才复制，可能已经来不及。如果要提供恢复，再确定何时生成副本、保存哪些文件、保留多久，以及由谁发起恢复。

## 最小实施与验收

1. **看见自己的文件。** 在 A 上传一份表格，请模型用 Bash 列目录，再运行脚本生成汇总。核对 `ls`、命令输出和网页可下载的结果。让 A 的另一个会话在汇总命令仍运行时调用 Bash，两条命令的结果各自回到原会话，切到 B 看不到 A 的文件。检查模型可用工具，确认首版没有开放尚未改造的 `read/write/edit`。
2. **关掉再继续。** 在模型回复或工具调用尚未完成时关闭沙箱，验证迟到的调用不会重启容器，也不会在新容器里执行。关闭完成后，分别验证手动开启和发送新消息能启动新容器，并读到原文件。确认空闲 30 分钟后会自动回收，以及 Runner 重启后能清理遗留容器。
3. **停止一条命令。** 同时执行两条命令，验证其中一条超时或被取消后，它的子进程全部退出，另一条仍能完成。模拟无法确认清理完成，确认旧容器先销毁。已写入工作区的产物应保留。
4. **检查权限和资源限制。** 用两个用户验证越权请求被拒绝。用假凭证确认容器访问不到推理密钥、用户密钥或其他宿主机文件。检查外网、运行时间和内存限制。尝试在网页读取工作区外的绝对路径、通过符号链接越界，以及在检查通过后替换链接。对外开放前检查所有模型工具，确保它们不能绕过 Runner 在宿主机直接操作任务文件或执行命令。 [Web 预设][preset] · [赛题要求][challenge]
5. **沙箱满额时给出反馈。** 开启 A 和 B 的沙箱，再到 C 发消息。验证 C 显示容量提示，请求没有进入等待队列，A 和 B 仍可继续使用。

[challenge]: https://lablab.ai/ai-hackathons/vultr-hackathon
[loop-tools]: ../packages/core/agent-loop/src/agent.ts#L587
[tool-context]: ../packages/core/tools/src/contracts.ts#L174
[tool-log]: ../packages/core/tools/src/batch.ts#L252
[preset]: ../packages/bundle/web-app/presets/standard.patch.yml#L5
[bash-tool]: ../packages/shell/tool-bash/src/index.ts#L478
[bash-approval]: ../packages/shell/tool-bash/src/index.ts#L218-L245
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
[vultr-backups]: https://docs.vultr.com/vps-automatic-backups
[vultr-snapshots]: https://docs.vultr.com/products/compute/instances/cloud-compute/features/snapshots
