---
kind: upgrade-guide
description: "Antfarm Web 命令要求账号登录，沙箱 overlay 使用这些命令的共享多用户配置。"
---

# Antfarm Web 使用账号登录

[English](guide.md) | 中文

## 变更

仓库的 `start:web`、`dev:web`、`make web` 和 `make dev-web` 命令加载 `apps/cli/config/antfarm-web.patch.yml`。这些命令使用已初始化的账号登录，取代单用户启动 URL token，并包含工作区上传和下载。账号和文件保存在配置的数据目录中；工作区默认位于 `$DSH_HOME/workspaces`。

`apps/cli/config/examples/harness-sandbox.patch.yml` 在共享配置之上增加沙箱管理，不再安装第二个多用户服务。底层 `dsh web` profile 保持原有行为，已有会话文件和账号密码不会迁移或重置。

## 迁移

1. 停止 Web 实例。已有账号继续使用同一 `DSH_HOME`。尚无账号时，按照[首次账号初始化](../../../../README.zh.md#run-from-source)创建账号；已有用户名会被拒绝。
2. 使用 `pnpm run start:web --no-open` 启动 Antfarm，从命令中移除重复的 multiuser、workspace-upload 和 workspace-artifacts overlay。接入使用既有工作区根目录的 Runner 时，显式设置 `DSH_MULTIUSER_WORKSPACE_ROOT`。
3. 增加沙箱管理时，先按照[部署指南](../../../user/guide/workspace-sandboxes.zh.md)配置，再使用 `pnpm run start:web --patch apps/cli/config/examples/harness-sandbox.patch.yml --no-open`。直接调用 `pnpm dsh web` 时，必须在沙箱 overlay 之前加载 `--patch apps/cli/config/antfarm-web.patch.yml`。
4. 打开不带 URL token 的普通首页，登录并确认工作区文件可用。没有账号归属的既有工作区仍对普通用户不可见；本次变更不会转移其所有权。
