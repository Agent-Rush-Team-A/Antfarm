---
description: "从 Web 应用将文件上传到所选工作区。"
kind: "tutorial"
---

# 上传到工作区

[English](workspace-upload.md) | 中文

## 1. 启用上传

在 Linux 上构建仓库，使用上传覆盖配置启动 Web profile：

```sh
pnpm run build
pnpm dsh web --patch apps/cli/config/examples/workspace-upload.patch.yml
```

现有多用户部署在账号配置之后添加此覆盖配置。运维人员通过 [Runner 部署](../../team-docs/SANDBOX-RUNNER.md)为沙箱账号配置工作区访问权限。[服务参考](../../packages/api/workspace-upload/README.zh.md)说明大小配置和文件系统要求。

## 2. 选择文件

选择一个工作区并打开其中的会话。在输入栏工具条选择**上传到工作区**，然后选择一个文件。默认单文件上限为 32 MiB。文件以原名保存在工作区根目录。

## 3. 检查结果

成功提示会确认文件名。现有工作区工具和已挂载的沙箱 Bash 可以打开上传文件。如已存在同名文件，先重命名本地文件再上传。过大文件需要缩小后上传。权限失败时，请刷新并检查工作区访问权限。

连接丢失确认时，请先检查工作区再重试。提示文件已上传但清理失败时，请联系部署管理员；文件仍然存在。
