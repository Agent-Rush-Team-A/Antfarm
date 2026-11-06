---
description: "个人凭证以认证密文保存，由当前登录账号管理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-user-credentials

[English](README.md) | 中文

## 概述

通过需要登录的浏览器 API 管理个人测试凭证。Host 在 `user_credentials` 存储域保存密文，工作区权限不会授予凭证访问权。本插件需要多用户组合和明确初始化的主密钥文件。

## 目录

- [使用本包](#use-this-package)
- [API 行为](#api-behavior)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将 `DSH_HOME` 设为 Host 私有数据目录，并在配置的工作区根目录之外初始化一次主密钥：

```sh
pnpm exec tsx scripts/user-credentials-key.ts --path "$DSH_HOME/secrets/user-credentials.key"
```

命令独占创建权限受限的 32 字节文件，并拒绝已有路径。请将主密钥与加密存储一起安全备份。缺失密钥、文件权限过宽或密文认证失败会拒绝服务启动，不会自动重新生成密钥。

配置账号认证后挂载插件：

```yaml
- insert:
    - id: user-credentials
      name: '@deepseek-ai/dsh-api-user-credentials'
      config:
        encryptionKeyFile: /absolute/private/secrets/user-credentials.key
        maxCredentialBytes: 16384
        maxRecordsPerUser: 64
- id: ui-user-credentials
  disabled: false
```

`maxCredentialBytes` 限制凭证值的 UTF-8 字节数；`maxRecordsPerUser` 限制每个账号的记录数量，包括并发新增。记录名称非空且最多 128 个字符。主密钥路径必须在工作区挂载目录外，包括父目录包含符号链接的情况。存储也必须路由到工作区挂载目录之外的 Host 私有目录。多用户测试 overlay 从 `DSH_USER_CREDENTIALS_KEY_FILE` 读取密钥路径。

<a id="api-behavior"></a>
## API 行为

`userCredentials` Remote 命名空间提供安全元数据列表、新增凭证、替换凭证值、删除记录与密文检查。调用者只来自已认证的 invocation。不存在与属于其他用户的记录 ID 都返回 `user-credentials/not-found`。Owner Peer 和没有用户 invocation 的调用会被拒绝。排队操作在执行前重新检查请求与登录生命周期。

响应仅包含 ID、名称、保存状态和时间戳。检查在 Host 内存中认证并解密当前用户的记录，随后清除明文字节缓冲区；结果表示存储可读，不表示外部服务授权有效。明文和凭证片段不会进入存储域事件、浏览器事件、模型消息、执行环境或工作区文件。错误仅包含固定消息与空详情，不携带原始存储或加密异常。

可选的 `inferenceBindings` 数组将每个 pi-ai provider 绑定到精确的 `baseURL` 和账号内的 `credentialName`。pi-ai 路由必须配置 `credentialScope: request`；即使凭证消费者被卸载，也不会回退到部署密钥。例如绑定 provider `vultr`、接口 `https://api.vultrinference.com/v1` 和名称 `Vultr API Key`，再配置对应的 `openai-completions` 路由与所需模型。接口必须使用 HTTPS；`allowLoopbackHttp` 仅允许显式配置的本地测试服务。模型列表只展示已配置的元数据，不读取凭证；鉴权仅在推理时执行。推理在当前轮次捕获已认证提示的 principal，拒绝混合账号输入，并在解密前重新检查会话的当前归属。缺少有效轮次授权、同名凭证重复或目标接口变化时拒绝请求。Host 内部凭证 waterfall 不转发给浏览器，只有选定的传输层接收密钥。新增、替换和删除已绑定凭证只发布模型列表失效的元数据通知。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

AES-256-GCM 将用户 ID、记录 ID 与加密版本绑定到每条记录，每次写入使用新的 12 字节 nonce。凭证在持久化前加密，所以 `domain/changed` 只携带密文。服务自己的写入队列串行处理数量检查与变更；卸载时拒绝尚未执行的请求，等待已接纳写入结束，关闭存储域并清除主密钥缓冲区。全局 `ctx.credentials` provider 与本功能独立。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [多用户账号](../multiuser/README.zh.md) — 认证与登录撤销。
- [个人凭证界面](../../client/ui-user-credentials/README.zh.md) — 浏览器入口与表单行为。

<a id="model-experience"></a>
## 模型体验

无，因为个人凭证管理不注册模型工具、提示词段落或 Session 事件。

#### KV Cache 影响

无，凭证管理不会改变模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 推理仅支持显式绑定的 pi-ai 路由，不提供通用外部请求代理或凭证共享授权。没有独立认证提示的子代理或自主调用会被拒绝。主密钥轮换需要另行设计迁移，替换密钥文件会使已有密文不可读。名称是用户提供的元数据，不应填写凭证值。保密性依赖 Host 及其私有存储可信。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护上下文</summary>

无。

</details>
