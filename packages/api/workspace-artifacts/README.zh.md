---
description: "按工作区授权的文件列表与二进制下载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-workspace-artifacts

[English](README.md) | 中文

## 概述

列出并下载授权工作区保留的普通文件。此可选 Linux 插件不依赖沙箱生命周期，拒绝符号链接和宿主机路径，并限制列表元数据与浏览器下载内存。插件启用时，会话输入栏显示文件浏览入口。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

Host 文件预览与 HTTP 下载共用 `openDownload()`。消费方传入已认证的 Peer 和经校验的正整数字节上限，消费或取消返回的 body，并等待其描述符关闭。两条读取路径均使用配置的本地或提供方存储，并在读取过程中复查工作区归属。

通过 Web 配置启用[文件指南及可选补丁](../../../docs/user/workspace-artifacts.zh.md)。插件依赖 Connection、Remote Access、Typert、Workspace Controller 和 Workspace Registry；默认配置不启用。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `maxEntries` | `2000` | 单次目录扫描检查的最大条目数，包含被省略的条目。 |
| `maxDownloadBytes` | `33554432` | 单次完整下载的字节上限，含边界值。 |

`workspaceArtifacts/list({ workspaceId }, path, signal)` 返回 `{ path, entries, truncated, maxDownloadBytes }`。路径相对于已登记工作区；空字符串列出根目录。条目包含原始 `name`、`kind`（`file` 或 `directory`）及可选文件 `bytes`。

`GET /api/workspace/downloadFileBinary?workspaceId=…&path=…` 以附件方式返回一个普通文件。owner 使用本地所有者权限；多用户账号必须具有对应工作区的归属授权。匿名或未授权请求在访问文件前被拒绝。

路径使用 `/` 分隔原始组成部分。绝对路径、盘符前缀、`.` 或 `..`、中间空组成部分、反斜杠、控制字节、超过 255 个 UTF-8 字节的组成部分以及超过 4095 个 UTF-8 字节的路径均被拒绝。列表省略符号链接和特殊文件，下载也拒绝这些文件。

### 远程工作区存储

设置 `storage: provided` 并注入 `workspaceFileAccess`，即可使用[云工作区提供方](../../sandbox/harness-sandbox/README.zh.md#workspace-vultr)。提供方缺失时拒绝启动，远程错误不回退到登记的宿主目录。上传发布或下载收束之前，请求持续保留原工作区权限与取消信号。设置 `storage: local` 时，继续提供原有基于描述符的本地行为。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>文件描述符所有权与浏览器传输</summary>

每个目录组成部分通过父目录描述符使用 `O_DIRECTORY | O_NOFOLLOW` 打开；最终文件使用 `O_NOFOLLOW | O_NONBLOCK` 打开，并检查已打开的描述符是否为普通文件。替换路径不能把该描述符重定向到符号链接目标。已登记根目录的父目录必须可信，且不可由沙箱用户替换。

下载流传输预检查时已打开文件的字节范围。每次读取前后复查权限及工作区登记。请求取消、Peer 撤销和插件卸载都会关闭文件；插件卸载等待所有请求及响应流结束。

Client 仅在插件启用时提供 `workspaceArtifactFiles.listFiles` 和 `downloadFile`。HTTP URL 相对于当前文档，保留部署前缀；调用者与插件取消信号联合控制操作。浏览器缓冲时执行列表返回的上限，仅把完整接收的 Blob 交给下载管理器，发起下载后撤销临时对象 URL。

列表拒绝使用 `workspace-artifact/failed`，并携带类型化的 `reason`；HTTP 失败返回 `{ ok: false, error: { reason } }`。类别为 `invalid-path`、`denied`、`not-found`、`not-regular`、`too-large`、`cancelled` 和 `io`。内部原因留在 Host 日志；界面提供本地化恢复提示，不保存不完整的字节。

归档工作区的准入拒绝返回 `denied`，下载请求使用 HTTP 403。访问文件前先恢复工作区；拒绝访问会保留已存储文件，也不会启动沙箱。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [文件浏览器指南](../../../docs/user/workspace-artifacts.zh.md)——启用文件浏览和下载。
- [工作区登记](../../../docs/subsystems/workspace.zh.md)——持久工作区身份。
- [多用户归属](../multiuser/README.zh.md)——账号的工作区访问权限。

-----

<a id="model-experience"></a>
## 模型体验

### 直接影响

#### 模型看到什么

浏览器通过 `workspaceArtifactFiles` 读取工作区文件。不新增工具、提示词段落或会话事件。

#### Token 影响

零；列出和下载文件不调用模型。

#### KV Cache 影响

无；文件操作不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **Linux 部署**——描述符路径依赖 Linux，工作区父目录必须可信。沙箱生命周期及挂载配置由部署方负责。
- **手动刷新列表**——扫描达到 `maxEntries` 时报告截断；分页和文件监听暂未实现。可进入子目录缩小列表范围。
- **完整下载有上限**——超过 `maxDownloadBytes` 的文件被拒绝。浏览器先缓冲完整文件，再发起下载。
- **并发写入**——下载保留已打开的 inode 和初始字节范围，但不建立文件系统快照。并发写入可能改变返回字节；文件截短会使传输失败。
- **浏览器只读**——符号链接解析、预览、打包生成、删除、备份和恢复不属于此插件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文</summary>

[存储测试](tests/storage.spec.ts)验证二进制内容、描述符固定路径替换和取消。[Host 测试](tests/artifacts.host.spec.ts)覆盖真实 Connection 路由。浏览器验收使用真实 Web Loader 和两个账号。

</details>
