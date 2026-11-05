---
description: "为独立的工作区沙箱 Runner 配置 Docker Engine 和工作区目录挂载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-runner

[English](README.md) | 中文

## 概述

开启、查询和关闭工作区沙箱，同时最多占用两个容器名额。每个容器按固定的资源上限运行，挂载一个预建的工作区目录，因此更换容器后文件仍然保留。镜像、用户身份和工作区根目录由部署配置指定。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将插件挂载到能访问 Docker Engine Unix socket 的独立 Linux Cordis 配置。按摘要预先拉取获准使用的[监管镜像](docs/README.zh.md)，镜像须包含 Python、`/usr/bin/sleep`、`/bin/bash` 和固定的只读监管程序，且不声明卷。每个部署标识只运行一个 Runner。部署方须控制规范化的工作区根目录及其祖先目录，防止工作区进程替换目录入口。预建子目录时，应为配置中的 UID 和 GID 分配相应权限。

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-sandbox-runner)列出必填字段。`requestTimeoutMs` 默认 10,000 毫秒，限制 Docker JSON 请求及等待监管就绪的用时。`cleanupTimeoutMs` 默认 2,000 毫秒；`termGraceMs` 默认 250 毫秒，须小于 cleanupTimeoutMs。这些部署预算与命令的 timeoutMs 分开计算。

`ctx.sandboxRunner` 在启动清理完成后才就绪。清理按项目、部署和工作区标签确认归属。调用 `open(workspaceId, directory)` 开启或复用运行中的容器，调用 `status(workspaceId)` 查询状态，调用 `close(workspaceId)` 删除容器并保留目录。两个名额被占用时，第三个工作区会收到 `sandbox_capacity`。卸载 Runner 时会取消启动清理中正在等待的 Docker 请求，释放 API socket，并等待已发出的开启、关闭和状态查询结束。

受信任的进程内调用方通过 `execute(workspaceId, request)` 提交已查询到的容器 ID、执行 ID、规范化的命令参数和命令时限。同一工作区的不同执行 ID 可以立即并行启动，共用容器的资源限制。检查已开启容器能否复用时，命令可以继续执行。通过 `open` 替换已有代次前，该代的所有执行都须已结算。同 ID、同参数的重试共享在途或已记录的结果，失败也会保留。每代容器最多累计保留 128 个不同的执行 ID，包含在途和已完成的执行，直到 Docker 确认容器已删除。

每条执行在进程清理和监管确认期间一直在途。确认清理的超时或取消保留容器及其他命令。`cancel(workspaceId, {executionId, expectedContainerId})` 取消已有 ID，返回 `cancellation: "requested"` 或 `"settled"`；接纳不代表最终原因或清理已确认。未知 ID 报 execution_not_found，旧容器 ID 报 execution_generation_mismatch。重复取消不改写已结算结果，也不替换首次接纳的结束原因。

Start 后结果不明时，同步将该代标为 `cleanup_required`，阻止新的 Start/run，再按完整 ID 删除容器。受回收影响的执行报 execution_container_recycled，发起回收的失败报 execution_outcome_unknown；终态 Promise 等待删除确认或失败。删除失败保留名额并阻止重开，`close` 可重试删除。确认删除后释放名额，保留工作区文件，旧代重试失效。关闭操作复用正在进行的回收，不重复删除。卸载时停止接纳，并行请求 shutdown 取消，等待清理及由此产生的回收后才释放服务资源。

超时、取消、结果不明及受整代回收影响的失败通过 `SandboxExecutionError.execution` 提供 executionId、containerId、已观察到的 reason（未知为 null）、cleanup，以及已知时的 Bash 状态。其他准备失败保留原来的 Docker 或生命周期错误。超时和取消的 cleanup 为 not_started 或 processes_cleaned；不明结果和整代回收为 container_removed 或 unconfirmed。命令捕获 TERM 并退出零，仍可能被取消。只有完整确认的 Bash 退出返回成功 DTO。

独立的 `sandbox-runner` profile 通过 Linux Unix socket 提供生命周期接口。对 `/v1/workspaces/:workspaceId/sandbox` 使用 `PUT`、`GET` 或 `DELETE`。PUT 接收包含 `workspaceDir` 的 JSON。成功响应包含状态，`running` 还带有 `containerId`。失败响应带有 `error`，容量满返回 HTTP 409 和 `sandbox_capacity`，Docker 不可用返回 HTTP 503 和 `docker_unavailable`。

通过 `POST /v1/workspaces/:workspaceId/sandbox/exec` 传入 `executionId`、从 PUT 或 GET 取得的完整 `expectedContainerId`，以及非空白的 Bash `command`。执行 ID 长度为 1–128 个 UTF-16 代码单元，JSON 请求体上限为 64 KiB。可选的 `workdir` 是相对 POSIX 路径，不能包含 `..` 路径段，默认使用工作区根目录。`timeoutMs` 接受 1–60000 的整数，默认 30000。确认退出时返回 HTTP 200，包含 `executionId`、`exitCode`、`stdout` 和 `stderr`，非零退出码也原样返回。请求无效返回 400，状态或 ID 冲突返回 409。容器清理未确认时返回 503 和 sandbox_cleanup_required。

通过 `POST /v1/workspaces/:workspaceId/sandbox/exec/cancel` 取消。JSON 只接受 executionId 和 expectedContainerId，复用相同的身份校验，上限为 8 KiB。HTTP 202 返回 `{executionId, containerId, cancellation: "requested"}`；HTTP 200 返回相同身份和 cancellation=settled。两种响应都不证明取消胜出或清理成功；应等待原 exec 请求，或用完全相同的内容重试取得终态。在途重复取消共享清理，已结算的结果不变。未知 ID 返回 404/execution_not_found，旧代或不匹配容器返回 409/execution_generation_mismatch。调用方断连不会请求取消。

执行失败保留顶层 error，并包含 executionId、containerId、reason、cleanup；Bash 是否启动及其状态已知时另带 bash。未知 reason 为 null，未知 Bash 状态省略。其他准备或生命周期失败保留原有的仅错误码响应。失败响应不编造 exitCode 或空输出流。

| HTTP | error | 清理保证 |
| --- | --- | --- |
| 504 | execution_timeout | not_started 或 processes_cleaned；reason=timeout。 |
| 409 | execution_cancelled | not_started 或 processes_cleaned；reason 为 cancelled 或 shutdown，与 Bash 状态分别记录。 |
| 503 | execution_outcome_unknown | container_removed 或 unconfirmed；超时/取消后丢失清理确认也使用此错误。 |
| 503 | execution_container_recycled | container_removed 或 unconfirmed；其他操作回收整代而中断了本次执行。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

`ctx.sandboxRunner` 使用 [Docker Engine API v1.51](https://docs.docker.com/reference/api/engine/version/v1.51/)。创建只将一个已存在的直属子目录绑定到 `/workspace`，不启动进程。启动后的容器使用只读根文件系统、无网络、移除所有 Linux 能力、独立的 32 MiB `/tmp`、1 vCPU、不使用 swap 的 512 MiB 内存和 64 个进程的上限。

对已有容器的写操作使用完整 ID。关闭时，Docker 确认该 ID 不存在后才释放名额。创建超时后，即使按稳定名称暂时查不到容器也会保留名额；后续查询或关闭可以通过创建标记确认迟到的容器。结果持续无法确认时，重启 Runner 执行启动清理。启动会检查运行中、已停止和未启动的容器，保留其他部署的容器。

固定 Bash 包装程序从 `/workspace` 解析请求目录，在启动用户命令前检查实际路径。目录无法进入或指向挂载范围之外时，包装程序向 stderr 写入错误并以 125 退出。Docker Exec 用无 TTY 的双向连接启动[监管程序](docs/README.zh.md)。ready 后，Runner 再次核对原执行和容器，才发送一次带剩余命令预算的 run。用户 stdout 和 stderr 从协议消息解码，每路以独立存储保留末尾 64 KiB。完成需要同时确认 finished、完整流 EOF，以及 Inspect 中同一监管 Exec/容器 ID、已停止状态和监管退出码零。原始 Bash 退出码或信号与监管状态分开保存。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [工作区沙箱设计](../../../team-docs/SANDBOX-DESIGN.md) — 独立部署和工作区。
- [Runner 部署](../../../team-docs/SANDBOX-RUNNER.md) — profile 模板、服务账号和本机请求。
- [应用 profile](../../boot/app-boot/README.zh.md#profiles) — 通过正式入口加载独立服务。

<a id="model-experience"></a>
## 模型体验

无。Runner 不提供模型上下文或工具输出。

#### KV 缓存影响

无。Docker 请求在模型请求组装之外运行。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **工作区授权** — 调用方在发请求前验证工作区归属。Runner 使用 socket 权限并校验挂载源。
- **共享文件系统** — Runner 和 Docker 守护进程必须能访问同一个工作区路径。本包不支持远程 TCP 守护进程。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者参考 — 点击展开</summary>

无。

</details>
