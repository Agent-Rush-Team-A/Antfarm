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

将插件挂载到能访问 Docker Engine Unix socket 的独立 Linux Cordis 配置。按摘要预先拉取获准使用的镜像；镜像须包含 `/usr/bin/sleep`，且不声明卷。每个部署标识只运行一个 Runner。部署方须控制规范化的工作区根目录及其祖先目录，防止工作区进程替换目录入口；预建子目录时，应为配置中的 UID 和 GID 分配相应权限。

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-sandbox-runner)列出必填字段。`requestTimeoutMs` 默认 10,000 毫秒，限制整个请求的用时。

`ctx.sandboxRunner` 在启动清理完成后才就绪。清理按项目、部署和工作区标签确认归属。调用 `open(workspaceId, directory)` 开启或复用运行中的容器，调用 `status(workspaceId)` 查询状态，调用 `close(workspaceId)` 删除容器并保留目录。两个名额被占用时，第三个工作区会收到 `sandbox_capacity`。卸载 Runner 时会取消启动清理中正在等待的 Docker 请求，释放 API socket，并等待已发出的开启、关闭和状态查询结束。

独立的 `sandbox-runner` profile 通过 Linux Unix socket 提供生命周期接口。对 `/v1/workspaces/:workspaceId/sandbox` 使用 `PUT`、`GET` 或 `DELETE`。PUT 接收包含 `workspaceDir` 的 JSON。成功响应包含状态，`running` 还带有 `containerId`。失败响应带有 `error`，容量满返回 HTTP 409 和 `sandbox_capacity`，Docker 不可用返回 HTTP 503 和 `docker_unavailable`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`ctx.sandboxRunner` 使用 [Docker Engine API v1.51](https://docs.docker.com/reference/api/engine/version/v1.51/)。创建只将一个已存在的直属子目录绑定到 `/workspace`，不启动进程。启动后的容器使用只读根文件系统、无网络、移除所有 Linux 能力、独立的 32 MiB `/tmp`、1 vCPU、不使用 swap 的 512 MiB 内存和 64 个进程的上限。

对已有容器的写操作使用完整 ID。关闭时，Docker 确认该 ID 不存在后才释放名额。创建超时后，即使按稳定名称暂时查不到容器也会保留名额；后续查询或关闭可以通过创建标记确认迟到的容器。结果持续无法确认时，重启 Runner 执行启动清理。启动会检查运行中、已停止和未启动的容器，保留其他部署的容器。

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

- **工作区授权** — 调用方在发请求前验证工作区归属。Runner 使用 socket 权限并校验挂载源。接口负责容器生命周期。
- **共享文件系统** — Runner 和 Docker 守护进程必须能访问同一个工作区路径。本包不支持远程 TCP 守护进程。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者参考 — 点击展开</summary>

无。

</details>
