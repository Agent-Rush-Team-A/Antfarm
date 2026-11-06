---
description: "Browse and download files retained in a workspace."
kind: "tutorial"
---

# Workspace files and downloads

English | [中文](workspace-artifacts.zh.md)

## Summary

Browse an authorized workspace and download its existing files or task outputs from the Web app. Files remain available after the sandbox closes; the optional Linux provider enforces ownership and download limits.

## Table of Contents

- [Enable the file browser](#1-enable-the-file-browser)
- [Browse the workspace](#2-browse-the-workspace)
- [Download a file](#3-download-a-file)

-----

<a id="1-enable-the-file-browser"></a>
## 1. Enable the file browser

On Linux, build and launch the Web profile with the file overlay:

```sh
pnpm run build
pnpm dsh web --patch apps/cli/config/examples/workspace-artifacts.patch.yml
```

For a multiuser deployment, add this overlay after the account configuration. The [provider reference](../../packages/api/workspace-artifacts/README.md) owns deployment requirements and caps. The [upload guide](workspace-upload.md) enables uploads independently.

<a id="2-browse-the-workspace"></a>
## 2. Browse the workspace

Choose a workspace and open one of its sessions. Select **Workspace files** in the composer toolbar. Open a folder to navigate, use **Parent folder** to go back, and select **Refresh** after a task creates or changes a file. Filenames and paths are relative to this workspace.

The list includes ordinary files and directories. Symlinks and special files are omitted. A truncation notice means the configured scan limit was reached; open a subfolder to narrow the listing.

<a id="3-download-a-file"></a>
## 3. Download a file

Select **Download** beside a file. The app receives the complete content before starting the browser download and preserves the filename. The default file limit is 32 MiB; a larger file needs a smaller version or an administrator-adjusted limit.

Closing the sandbox leaves workspace files available for browsing and downloading. This feature does not start a sandbox or call a model. If a file disappears, refresh the list. Permission failures require refreshing and checking workspace access. Closing the dialog or leaving the workspace cancels unfinished transfers without saving a partial file.

## Dev Note

None.
