---
description: "使用 Antfarm 默认模型目录和当前账号的个人凭证。"
kind: "user-guide"
---

# 个人模型凭证

[English](personal-models.md) | 中文

## 选择模型

完成[首次账号初始化](../../../README.zh.md#run-from-source)后，通过 `pnpm run start:web` 或 `pnpm run dev:web` 启动 Antfarm。登录、打开对话，并选择 Vultr 下的模型。[默认部署配置](../../../apps/cli/config/antfarm-web.patch.yml)提供模型目录；保存密钥之前和删除密钥之后，模型都保持可见。目录显示只确认模型已经配置，不代表可以访问外部服务。

## 保存个人凭证

打开侧边栏的**我的凭证**。名称准确填写 `Vultr API Key`，粘贴具备 Vultr Cloud Inference 访问权限的密钥并保存，然后选择 Vultr 模型发送一条简短消息。调用地址为 `https://api.vultrinference.com/v1`，只使用发起对话的账号保存的凭证。缺少凭证时会提示配置，不能借用部署全局密钥或另一账号的密钥。

每个账号只保留一个同名凭证。通过**替换凭证值**更新密钥，通过**删除**移除凭证。调用时遇到多个同名凭证会被拒绝，请删除重复记录后重试。**检查保存状态**只确认后端能解密凭证，不检查外部服务权限。密钥被拒绝时，请更新凭证或检查推理权限；限流和服务故障请稍后重试，持续失败请联系管理员。能管理云实例不代表具备模型推理权限。

## 保留部署数据

空部署首次启动时，Antfarm 在 `$DSH_HOME/secrets/user-credentials.key` 创建私有的 32 字节加密主密钥，重启时复用。请将该文件与 `$DSH_HOME/storages/user_credentials.json` 和账号数据一起备份。密钥和存储必须位于工作区挂载目录之外。已有密文但密钥丢失、密钥文件不安全或密文无法解密时，凭证服务拒绝启动，需要恢复原密钥。

如果使用外部管理的密钥，在启动前将 `DSH_USER_CREDENTIALS_KEY_FILE` 设为其绝对路径。该文件必须已经存在，见[密钥初始化](../../../packages/api/user-credentials/README.zh.md#use-this-package)。不要独立于加密存储替换主密钥；目前不支持密钥轮换。

## 配置模型目录

首批个人模型服务支持 Vultr。显式模型目录位于 [antfarm-web.patch.yml](../../../apps/cli/config/antfarm-web.patch.yml)，来源为 [Vultr 公共模型目录](https://api.vultrinference.com/v1/models)。保存凭证不会自动发现服务商或同步模型。预置目录提供文本输入，每个模型的单次输出上限为 8192 token。

管理员可通过后置补丁替换 `llm-pi-ai` 的服务配置。保留 `credentialScope: request`；更改服务、地址或凭证名称时，同时更新[个人凭证绑定](../../../packages/api/user-credentials/README.zh.md#api-behavior)。实际地址与绑定不同会拒绝调用。部署更新前，应根据服务商当前目录核对模型 ID 和能力。
