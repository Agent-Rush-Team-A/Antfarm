---
kind: upgrade-guide
description: Workspace mode records require a fresh workspace domain and expose permanent Session locking.
---

# Workspace modes

English | [中文](guide.zh.md)

## Change

The workspace domain advances from version 2 to version 3 and requires mode, revision, first-Session identity, and recoverable operation fields. Earlier workspace domains cannot be opened by this deployment; Session log generations remain unchanged. Workspace Remote projections now require `modeConfig`, and Client Workspace services require `getMode` and `setMode`. Workspace mode selection becomes permanently locked by the first ordinary Session. Single modes refuse a second Session, forks, and archive requests.

## Migration

1. Use a fresh application data directory for this deployment; retain the old directory separately if its data is needed. Do not overwrite an existing workspace domain or its Session logs.
2. Set the workspace registry's `defaultMode` in the profile overlay when the deployment needs a value other than `multi-vm`.
3. Runtime providers import `WorkspaceModeRuntime` and `IWorkspaceModes` from `@deepseek-ai/dsh-workspace/types` and register through `ctx.workspaceRegistry.modes.registerRuntime` before changing modes.
4. Update external Workspace mocks and wire consumers to include `WorkspaceView.modeConfig`; implement `IWorkspaces.getMode` and `IWorkspaces.setMode`, preserving `WorkspaceModeCommandError.rpcError` for failures.
5. Verify that a newly registered Workspace reports revision 0 and an unlocked mode configuration.
6. In the Web interface, choose the Workspace mode before selecting **Start session**. A fresh Workspace no longer creates its first Session during startup or immediately after directory registration; existing Workspace locks remain permanent.
