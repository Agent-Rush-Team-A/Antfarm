---
description: "浏览并下载工作区保留的文件。"
kind: "tutorial"
---

# 工作区文件与下载

[English](workspace-artifacts.md) | 中文

## 概要

在网页中浏览已授权的工作区，并下载已有文件或任务产物。沙箱关闭后仍可访问文件；可选的 Linux 服务会检查工作区归属和下载上限。

## 目录

- [启用文件浏览器](#1-enable-the-file-browser)
- [浏览工作区](#2-browse-the-workspace)
- [下载文件](#3-download-a-file)

-----

<a id="1-enable-the-file-browser"></a>
## 1. 启用文件浏览

在 Linux 上构建并使用文件补丁启动 Web 配置：

```sh
pnpm run build
pnpm dsh web --patch apps/cli/config/examples/workspace-artifacts.patch.yml
```

在多用户部署中，把此补丁放在账号配置之后。[插件参考](../../packages/api/workspace-artifacts/README.zh.md)说明部署要求和上限。[上传指南](workspace-upload.zh.md)单独启用上传功能。

<a id="2-browse-the-workspace"></a>
## 2. 浏览工作区

选择工作区并打开其中一个会话。点击输入栏的**工作区文件**。打开文件夹以浏览子目录，使用**上一级**返回，任务创建或修改文件后点击**刷新**。文件名和路径均相对于此工作区。

列表包含普通文件与目录，省略符号链接和特殊文件。截断提示表示扫描达到配置上限；可进入子目录缩小列表范围。

<a id="3-download-a-file"></a>
## 3. 下载文件

点击文件旁的**下载**。应用先接收完整内容，再发起浏览器下载，并保留文件名。默认单文件上限为 32 MiB；较大的文件需要提供较小版本，或由管理员调整上限。

关闭沙箱后，工作区文件仍可浏览和下载。此功能不启动沙箱，也不调用模型。文件消失时请刷新列表；权限失败时请刷新并检查工作区访问权限。关闭弹窗或离开工作区会取消未完成的传输，不保存不完整的文件。

## 开发备注

无。
