---
description: "将文件以经过授权的流式上传方式写入已注册工作区目录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-workspace-upload

[English](README.md) | 中文

## 概述

将浏览器文件上传到已授权注册工作区的根目录。可选的 Linux Host 服务检查资源权限，限制流式接收的字节数，并保留现有文件。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

将 Host provider 作为 Cordis 插件挂载，并提供经过校验的配置。依赖 Connection、Remote Access、Typert、Workspace Controller 和 Workspace Registry。默认 profile 不启用此服务。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `maxBytes` | `33554432` | 正安全整数；单文件字节数的包含式上限。 |

`workspaceUpload/limits({ workspaceId })` 返回字节数上限。以 `Content-Type: application/octet-stream` 将原始字节发送到 `POST /api/workspace/uploadFileBinary?workspaceId=…&name=…`。两个请求均不接受主机路径。本地 owner 调用使用 owner 权限；多用户账号必须具有工作区所有权绑定。匿名请求和其他工作区均被拒绝。

文件名必须是单一名称，最多 255 个 UTF-8 字节。拒绝目录分隔符、控制字符、盘符前缀、空白名称、`.` 和 `..`。允许空文件。现有文件、目录和符号链接均返回 `exists`；重试前先重命名所选文件。

<a id="understand-the-implementation"></a>
## 理解实现

服务打开可信注册根目录时不跟随末端符号链接，将字节暂存到私有兄弟目录，在接收过程中检查大小，发布前同步文件，再通过已打开的目录描述符创建排他硬链接。发布前重新检查权限和工作区注册。部署必须保证工作区父目录可信，并将暂存位置放在同一文件系统。

发布文件继承工作区目录的组，权限为 `0660`。按 [Runner 部署](../../../team-docs/SANDBOX-RUNNER.md)为工作区目录配置非 root 沙箱账号所需的组和访问权限。上传不创建或配置沙箱。

成功清理后返回 `{ ok: true, value: { name, bytes } }`。失败返回 `{ ok: false, error: { reason, stored } }`；内部路径和原因仅记录在 Host 日志中。`stored` 只在发布后变为 true，因此清理失败可能对应已提交文件。始终不替换现有目录项。


每项操作持有自己的描述符和暂存目录。连接断开、Peer 撤销和服务卸载均会取消阻塞的请求体读取；卸载会等待已接纳操作结束后释放服务。与成功发布竞态的取消不会删除已提交文件。

<a id="model-experience"></a>
## 模型体验

### 直接影响

#### 模型看到的内容

`workspaceUploads.uploadFile` 不添加工具、提示词章节或附件消息。现有工作区工具可以从挂载目录读取上传文件。

#### Token 影响

上传本身为零。后续工具读取按其正常行为计费。

#### KV Cache 影响

独立。上传不改变模型请求前缀。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 依赖 Linux 描述符路径。可信父目录不能允许沙箱用户写入，暂存必须与工作区位于同一文件系统。
- 只支持上传单文件到工作区根目录；目录上传、替换、列表和下载均不在此服务范围。
- 部署负责工作区目录配置、总磁盘配额和沙箱挂载。单文件限制不提供总存储配额。

<a id="dev-note"></a>
### 开发备注

[存储测试](tests/storage.spec.ts)验证二进制保真、重名、路径替换、大小限制和清理。[Host 路由测试](tests/upload.host.spec.ts)验证真实 Connection 接纳、流式请求体和工作区归属授权。
