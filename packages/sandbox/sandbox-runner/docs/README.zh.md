# 执行监管镜像

[English](README.md) | 中文

运行一条命令并清理它的后代，不向同容器的其他执行发信号。Python 监管程序负责本次命令的进程树，保留命令原始状态，只有 Linux 确认没有子进程后才报告完成。Runner Exec 启动该监管程序，通过专属 Docker Upgrade 连接交换控制协议。

## 构建和启动

使用本包目录作为 Docker 构建上下文，构建 [image/Dockerfile](../image/Dockerfile)。基底按摘要固定，提供 Python 3.11、Bash 和 sleep。监管程序位于 `/opt/agentrush/sandbox-runner/supervisor.py`，由 root 持有，权限为 `0444`，所在目录为 `0555`。使用构建结果自身的摘要固定镜像，而非基底摘要。

沿用现有 Runner 容器限制：非 root 数字 UID/GID、无网络、只读根、移除全部能力、no-new-privileges、1 CPU、不使用 swap 的 512 MiB 内存、64 个 PID、32 MiB `/tmp`，以及绑定到 `/workspace` 的一个可写工作区。镜像默认 UID/GID 为 `10001:10001`，运行 `/usr/bin/sleep infinity`。Docker Exec 不使用 TTY，须连接 stdin、stdout 和 stderr。

启动 `/usr/local/bin/python3 -I -B /opt/agentrush/sandbox-runner/supervisor.py`，传入四个必填参数：`--execution-id`、`--run-wait-ms`、`--cleanup-timeout-ms` 和 `--term-grace-ms`。执行 ID 为不含 NUL 的合法 Unicode，长度为 1–128 个 UTF-16 代码单元。run 等待接受 1–2147483647 毫秒，清理接受 1–60000，TERM 宽限接受零或小于清理预算的正整数。Runner 提供部署中的 requestTimeoutMs、cleanupTimeoutMs 和 termGraceMs；脚本要求显式参数。

初始化要求 Linux、非 root 身份、subreaper 和非 dumpable 设置、pidfd 打开及信号支持，以及 `/proc` 中可读取的子进程信息。失败时不发送 ready，不启动用户代码。用户 stdin 为 `/dev/null`，stdout 和 stderr 分别进入监管管道。子进程在 exec 前关闭继承的控制、协议、selector 及其他描述符。

将执行 ID 作为单个 argv 值 `--execution-id=<value>` 传入，使前导连字符和 ID 内的等号都保留为数据。

## 协议参考

每条消息是一个 UTF-8 JSON 对象，后接 LF，不含 BOM。公共字段为 `v: 1`、`type` 和完全匹配的 `executionId`。未知字段、非法类型、错误 ID 或版本均使协议失败。run 消息在 LF 前最多 128 KiB，其余消息最多 16 KiB。尚未完整的输入行受 128 KiB 总上限约束，完整后检查该类型的长度上限。

| 消息 | 方向 | 附加字段 |
| --- | --- | --- |
| `ready` | 监管 → 调用方 | 无。初始化成功，尚未启动用户代码。 |
| `run` | 调用方 → 监管 | `argv`：非空字符串数组，可执行文件非空，参数为合法且不含 NUL 的字符串；`remainingMs`：1–60000 的整数。ready 后只发送一次，使用现有 Runner 规范化后的 Bash 包装程序 argv。 |
| `cancel` | 调用方 → 监管 | `reason`：cancelled、timeout 或 shutdown。run 前取消不会启动命令。重复取消保留首次接纳的原因。 |
| `output` | 监管 → 调用方 | `stream`：stdout 或 stderr；`data`：1–8192 个原始字节的带 padding base64 编码。每路分别保序。 |
| `finished` | 监管 → 调用方 | `reason`：exited、timeout、cancelled、shutdown 或 control_eof；`bash`：下述命令状态；`cleanup: "confirmed"`；`outputTruncated`：stdout/stderr 各自的布尔标记。 |

普通退出时，bash 为 `{exitCode: 0..255, signal: null}`；信号退出时为 `{exitCode: null, signal: 1..64}`；未启动命令时为 null。已启动命令却缺失 wait 状态属于失败，不能写成 null 或退出码零。命令捕获 TERM 后退出零，结束原因仍可能是 timeout 或 cancelled。命令状态和监管程序退出码分别描述不同结果。

监管 stdout 只承载协议，stderr 承载诊断。用户输出始终放进 output 消息的 base64 字段，包括看起来像 ready 或 finished 的文本。监管程序每路最多保留 64 KiB 待发字节，另加一个编码块，低于 256 KiB 的输出缓冲上限。背压时丢弃较早的待发字节，设置该路 outputTruncated，保留最后的尾部。调用方持续排空、各自保留末尾 64 KiB，并将本地截断标记与监管标记合并。

## 清理和失败

首次观察到命令退出、命令超时、cancel 或控制 EOF 时开始清理，固定结束原因。超时使用单调时钟，不以关闭输出连接代替清理。监管程序通过 pidfd 向自己的实际直接子进程发信号，等待退出，再处理新收养的后代。所有轮次共用 TERM 宽限；宽限结束后，对已有及新收养的子进程发 KILL。setsid 和双重 fork 的后代仍受本次监管。Linux 的 `waitpid(-1, WNOHANG | __WALL)` 必须报告 ECHILD 才能确认清理；返回零仍表示有子进程。参见 [Linux wait 语义](https://man7.org/linux/man-pages/man2/waitpid.2.html)。

清理预算包括发信号、收养、等待、排空两路用户管道、发送保留的尾部及 finished。控制与管道操作均非阻塞，每轮工作量有上限，因此输出繁忙或对端不读时仍能检查期限、取消和回收。对端未在清理预算内恢复读取时，即使子进程已经回收，监管程序也以非零码退出。

监管成功时发送一次 finished 并退出零。非法控制、重复 run、不完整控制 EOF、能力缺失、wait 状态丢失、信号失败或预算耗尽均以非零码退出，不提供可信的 finished。诊断使用 `error: "supervisor_failed"` 和 `cleanup: "unconfirmed"`；诊断传输损坏也不能变成成功。Docker 适配层同时验证 finished 和监管程序的 Docker Exec 退出状态。结果无法确认时，Runner 阻止新执行并删除该代容器；删除失败则继续阻塞，直到关闭操作确认删除。脚本无法确认或执行宿主侧的容器删除。

## Docker 适配层

[docker.ts](../src/docker.ts)启用 stdin 和 TCP Upgrade，不使用 TTY。ready 后，Runner 再次核对捕获的执行、完整容器 ID、运行状态、归属标签和工作区挂载；核对失败则不发送 run。[protocol.ts](../src/protocol.ts)处理 Upgrade head 字节及任意 Docker/JSON 分片，校验各条消息和 base64 块，分别保留用户输出及监管诊断，拒绝不完整或顺序错误的流。

适配层最多排入一条有界 run 和一条 cancel；写入背压不阻塞协议读取或取消。ready 前的取消保存到就绪后发送；核对过程中的取消阻止迟到结果启动命令。等待 ready 和 run 均有期限；取消后继续读取结果，清理及确认的期限与命令期限分开。重复取消不会延长预算或替换首次请求。

完成 Promise 等待 finished、完整流 EOF，以及 Docker Inspect 中匹配的 Exec/容器 ID。在剩余确认预算内，可以再次检查仍在运行的监管程序；确认停止时，监管退出码必须为零。原始 Bash 退出码或信号来自 finished，包含非零退出。不重试 Start 或 run。HTTP 取消和自动整代回收由 Runner 管理，其响应及保证见[包参考](../README.zh.md#use-this-package)。

## Linux 验证

[tests/supervisor/test_supervisor.py](../tests/supervisor/test_supervisor.py)启动镜像内的真实监管程序，从 `src/server.ts` 读取现有 Bash 包装程序。在独立可写的 `/workspace` 中按相同包路径放置该源码和测试，监管程序保留在镜像内。使用 `cc -static -O2 -Wall -Wextra -Werror` 编译 [clone_child.c](../tests/supervisor/clone_child.c)，在测试文件旁生成 clone-child。编译器和辅助程序不进入运行镜像。

在受限容器的 `/workspace` 下运行 `python3 -I -B -m unittest discover -s packages/sandbox/sandbox-runner/tests/supervisor -p 'test_*.py' -v`。断言同时检查 finished、独立的 `/proc` 观察及另一条执行的文件进度。clone 辅助程序创建一个在被收养前 exit_signal=0 的真实子进程。独立的能力拒绝容器检查验证初始化在启动用户代码前失败。这些检查验证镜像监管程序；Runner HTTP 取消及构建后的正式 profile 需要单独集成验证。
