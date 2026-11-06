---
kind: upgrade-guide
description: "Antfarm Web commands require account login, and the sandbox overlay uses their shared multiuser configuration."
---

# Antfarm Web uses account login

English | [中文](guide.zh.md)

## Change

The repository's `start:web`, `dev:web`, `make web`, and `make dev-web` commands load `apps/cli/config/antfarm-web.patch.yml`. They require a provisioned account instead of the single-user launch URL token, and include workspace upload and download. Accounts and files persist under the configured data home; workspaces default to `$DSH_HOME/workspaces`.

`apps/cli/config/examples/harness-sandbox.patch.yml` adds sandbox management to this shared configuration. It no longer installs a second multiuser service. The underlying `dsh web` profile remains unchanged, and existing session files and account passwords are not migrated or reset.

## Migration

1. Stop the Web instance. Keep the same `DSH_HOME` for existing accounts. If no account exists, use the [first account setup](../../../../README.md#run-from-source) to provision one; existing usernames are rejected.
2. Start Antfarm with `pnpm run start:web --no-open`. Remove redundant multiuser, workspace-upload and workspace-artifacts overlays from that command. Set `DSH_MULTIUSER_WORKSPACE_ROOT` explicitly when connecting a Runner with an existing workspace root.
3. To add sandbox management, use `pnpm run start:web --patch apps/cli/config/examples/harness-sandbox.patch.yml --no-open` after following the [deployment guide](../../../user/guide/workspace-sandboxes.md). Direct `pnpm dsh web` invocations must load `--patch apps/cli/config/antfarm-web.patch.yml` before the sandbox overlay.
4. Open the ordinary homepage without a URL token, sign in, and verify that your workspace files are available. Pre-existing workspaces without account ownership remain inaccessible to ordinary users; this change does not transfer their ownership.
