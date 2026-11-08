---
kind: upgrade-guide
description: "Workspace VM modes require shared VFS storage and no longer preserve whole-VM disks."
---

# Workspace VM storage moves to VFS

English | [中文](guide.zh.md)

## Change

Both Workspace VM modes use the same VFS directory and UID/GID binding. Multi-session VM mode keeps its instance across turns; closing, idle reclamation, archival, or deletion releases it without creating a disk snapshot. Workspace files remain in VFS. Tools and configuration installed outside the workspace mount do not survive VM recreation. A reserved identity remains assigned while its workspace files are retained, even with no running VM.

Existing snapshot-backed multi-session VM deployments require an explicit data migration. Legacy cloud records are not VFS allocation records; retaining a snapshot does not make its files available through the VFS provider. Session log generations remain unchanged.

## Migration

1. Back up the workspace registry, private cloud records, SSH keys, VFS identity state, and source files. Retain every original snapshot until its import is verified and durably recorded. Keep legacy and VFS allocation state in separate private directories.
2. Fence new messages, uploads, and commands before migrating a live VM. Stop and settle guest writes, export the source workspace, verify its files, and close the original VM through its owning provider before changing storage. Do not mount an empty VFS directory over the only live copy.
3. Set `vultr.legacyMultiStateRoot` to the original private cloud-state directory. Automatic import accepts only a confirmed closed record and its published complete file cache; live or incomplete records require recovery through the legacy provider. Import into the assigned VFS directory with the correct UID/GID and confirm durable publication. Import never mutates the original record or deletes snapshots. Conflicts, incomplete copies, unknown cloud mutations, or unconfirmed cleanup retain the original state and source.
4. Give `vultr.multi` and `vultr.single` the same `volumeId` and `region`, with distinct private allocation `stateRoot` directories. Configure the shared identity pool using the [Vultr deployment guide](../../../user/guide/workspace-vultr.md#offer-vm-and-docker-modes-together), retain its bindings, and keep `workspace.defaultMode` on Docker. The pool includes retained directories, not only active instances. Supply required tools through the deployment image or repeatable installation after recreation.
5. Verify uploads and downloads while the VM is closed, execution against those same VFS files, and close/reopen without a new snapshot. Confirm the original VFS attachment and VM are absent after closure. Retire a legacy snapshot only after verified import and durable publication, then release the maintenance fence.
