---
kind: upgrade-guide
description: "Workspace domain version 4 protects archival and changes deletion to await resource cleanup."
---

# Workspace archival and resource cleanup

English | [中文](guide.zh.md)

## Change

Workspace deletion stops its Session activity and waits for sandbox cleanup. It can take as long as VM preservation and destruction; cleanup failure retains the registration. Guest accounts can delete their own registrations. Files and Session logs remain on disk.

Workspace archival is persisted in domain version 4. Current readers accept version 3 records, where missing archival metadata means active. Older binaries cannot open version 4 Workspace data; rollback requires the matching pre-upgrade Workspace storage backup.

## Migration

1. Stop the application and back up its Workspace storage before upgrading. Preserve Session logs, files and cloud state independently.
2. Upgrade Host and Client together. Custom Workspace clients must implement `setArchived(workspaceId, archived)` and accept the optional `archived` row field. Custom mode providers must implement `SandboxExecutionBackend.closeWorkspace` without acquiring a mode lease, because the registry already holds exclusive admission. Callbacks registered by `registerDeletionGuard` also run during archival and must retain files and Session logs.
3. To raise Docker capacity, set Runner `maxInstances` explicitly in its profile; valid values are 1–100 and its default remains 2.
4. Confirm that archiving releases resources while retaining files, restoration starts no resources, and a cleanup failure keeps the registration visible. Confirm older binaries are not started against version 4 Workspace data.
