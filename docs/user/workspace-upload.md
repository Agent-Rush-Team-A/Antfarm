---
description: "Upload a file into the selected workspace from the Web app."
kind: "tutorial"
---

# Upload to a workspace

English | [中文](workspace-upload.zh.md)

## 1. Enable uploads

On Linux, build the repository and launch the Web profile with the upload overlay:

```sh
pnpm run build
pnpm dsh web --patch apps/cli/config/examples/workspace-upload.patch.yml
```

An existing multiuser deployment adds this overlay after its account configuration. Operators provision workspace access for the sandbox account through [Runner deployment](../../team-docs/SANDBOX-RUNNER.md). The [provider reference](../../packages/api/workspace-upload/README.md) owns size configuration and filesystem requirements.

## 2. Choose a file

Choose a workspace and open a session in it. Select **Upload to workspace** in the composer toolbar, then choose one file. The default per-file limit is 32 MiB. Files are saved in the workspace root under their original names.

## 3. Check the result

A success notice confirms the filename. Existing workspace tools and mounted sandbox Bash can open the uploaded file. If a name already exists, rename your local file before uploading it. Oversized files need a smaller version. Permission failures require refreshing and checking workspace access.

When a connection loses the confirmation, check the workspace before retrying. If the notice says the file was uploaded but cleanup failed, contact the deployment administrator; the file remains present.
