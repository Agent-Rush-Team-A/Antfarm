---
description: "Deploy VFS-backed Workspace VM modes and operate the legacy snapshot provider."
kind: "user-guide"
---

# Vultr workspace VMs

English | [中文](workspace-vultr.zh.md)

## Prepare the deployment

The Harness runs model transport, account authorization, execution coordination and Session storage. The [Workspace mode deployment](#offer-vm-and-docker-modes-together) uses shared VFS storage without whole-VM snapshots. The standalone `/vultr` setup below retains snapshot behavior for existing deployments and legacy data export. Each active Workspace receives one independent Vultr VM. Sessions in the same Workspace share that VM. The VM runs a non-root `workspace-exec` account and a standalone SSH helper, without Docker or a full Harness installation.

Prepare a Vultr management key in a private file owned by the Harness user, a private SSH client key, and a private durable state directory. Keep both credential files and the state directory outside every registered project. The management key stays on Harness. Do not use a Cloud Inference-only key for instance management. The state directory must have mode 0700; credential files must not grant group or other access. One Harness owns that directory through a kernel lock, which releases on exit or crash.

Build the deployment's [standalone helper archive](../../../packages/ssh/ssh-helper-runtime/README.md) after building package artifacts. Keep its archive digest and the executable digest from `manifest.json`. The provider verifies the archive before allocating a VM, installs it outside the VM workspace, and checks the executable digest during the helper handshake. Host keys are generated per Workspace and pinned through a private OpenSSH configuration; startup never accepts an unknown host key.

```sh
pnpm run build:artifacts
pnpm exec tsx scripts/build-exe-for-ssh-helper.ts --skip-build --output /srv/antfarm/helpers
```

Create a deployment JSON file with these explicit settings. Use an OS image supported by the helper; `2284` is the Ubuntu 24.04 image used by the validation deployment. Choose the region and plan from your account's current Vultr catalog.

```json
{
  "apiKeyFile": "/srv/antfarm/secrets/vultr.key",
  "stateRoot": "/srv/antfarm/cloud-workspaces",
  "deploymentId": "antfarm-production",
  "region": "nrt",
  "plan": "vc2-1c-2gb",
  "osId": 2284,
  "sshKeyFile": "/srv/antfarm/secrets/workspace-ssh",
  "helperArchive": "/srv/antfarm/helpers/helper.tar.gz",
  "helperArchiveHash": "replace-with-archive-sha256",
  "helperHash": "replace-with-executable-sha256",
  "maxInstances": 2
}
```

Set `DSH_MULTIUSER_WORKSPACE_ROOT` to the canonical registered project root. Export the deployment JSON as `DSH_VULTR_CONFIG_JSON`; it contains credential paths, not the key values. Start Antfarm with the [Vultr overlay](../../../apps/cli/config/examples/harness-vultr.patch.yml). Do not combine it with the fixed SSH or Docker overlays.

```sh
export DSH_MULTIUSER_WORKSPACE_ROOT=/srv/antfarm/workspaces
export DSH_VULTR_CONFIG_JSON="$(cat /srv/antfarm/vultr-config.json)"
pnpm run start:web --patch apps/cli/config/examples/harness-vultr.patch.yml --no-open
```

## Use workspace files and execution

Opening a Workspace sandbox or sending an authenticated message creates or reuses its VM. Readiness requires cloud power state, SSH access, installed helper integrity and the remote directory check. Concurrent opens share one allocation. Bash and native read/write/edit use the same remote directory as web uploads, listings and downloads. Remote failure never changes execution to Harness-local tools.

Existing registered files are imported once on the first open. Interrupted initial imports resume only when existing remote files have matching contents; conflicts stop preparation. After preparation, the VM is the authoritative execution directory. The registered Harness project path remains account and Session metadata, not an execution fallback.

The backend uses the existing `workspaceSandbox/open`, `status` and `close` methods. Browser results retain the usual state and include `progress` for cloud phases: creating, connecting, restoring, saving files, stopping, saving a snapshot, deleting or failed. Progress contains no cloud identities, host addresses or credential paths. Opening and saving may take minutes; a successful API allocation is not helper readiness.

## Close and restore

Closing revokes old request generations, stops managed commands and prevents new remote writes. The helper confirms accepted writes have settled before a bounded read-only file copy is taken. The provider closes the helper, flushes guest disks, confirms the VM is stopped, then creates a disk snapshot. It records a completed snapshot and the copy before deleting the source VM. Save failure keeps the source disk and exposes the failed phase; it does not delete the only data source.

While closed, file listing and download use the completed private copy without allocating a VM. The copy is read-only and is not an execution directory. Uploading or starting a new task restores a VM from the snapshot. Restore reapplies cloud-init to preserve the pinned SSH host key, verifies the current allocation's readiness marker, checks the helper and renews the execution generation. Disk files and installed environments resume; old task processes must be started again.

## Recover and operate

Retain the cloud state directory together with the deployment SSH key. It records instance, snapshot, copy and execution identities. Harness restart first reconciles that metadata with cloud inventory; it does not blindly recreate instances. Interrupted or ambiguous creation is resolved by its original label or snapshot description. An unknown mutation is not automatically replayed. Missing disks or mismatched ownership block further execution and require operator inspection.

The default capacity is two instances. Polling, request and operation deadlines, maximum copied bytes and entry counts are deployment settings documented in the [package reference](../../../packages/sandbox/harness-sandbox/README.md). Exceeding copy limits fails preservation and retains the VM. Keep the last complete snapshot until a newer complete save is recorded; completed saves remove superseded snapshots. Snapshot storage is billable even while no VM runs.

The Vultr overlay enables Web sandbox controls and the shared idle plugin with a 30-minute idle threshold and 10-second sweep interval. Retained cloud preparation, file transfers and cleanup prevent idle closure. Upload restoration re-enters idle tracking and requires a fresh running observation before the timer starts. The conditional close calls this backend’s preservation path; no second timer is added. The panel displays common sandbox states and cloud failure guidance; detailed phases remain available through the management API. Use isolated credentials and disposable workspaces for cloud acceptance; the opt-in Loader test removes only its tagged resources and preserves unrelated account resources.

<a id="offer-vm-and-docker-modes-together"></a>

## Offer VM and Docker modes together

Use the [Workspace mode overlay](../../../apps/cli/config/examples/harness-docker-modes.patch.yml) to offer both Docker modes and both VM modes. Start with the [Docker mode settings](workspace-sandboxes.md) and add a `vultr` object to `DSH_DOCKER_MODES_CONFIG_JSON`.

- `vultr.multi` and `vultr.single` each use the allocation and helper settings above, with separate private `stateRoot` directories and `deploymentId` values. Both require the same `volumeId` and `region`, plus `vfsScriptsRoot` for the deployment-owned directory containing `check-mount.sh` and `run-workspace-helper.sh`. Keep the guest root at `/workspace`; do not reuse the legacy snapshot state directory as a VFS allocation directory.
- `vultr.vfs` uses the Harness-side `mountPoint`, its `mountTag` as a string, the direct child `workspaceRoot` on that mount, a private `stateRoot` for shared task identity bindings, and the reserved numeric `taskIds`. Both VM modes use this pool and retain the same UID/GID when switching between them.
- Run Web as a non-root user with all reserved IDs in its supplementary groups. Identities remain assigned while workspace files are retained, even if their VM is closed or their Workspace is archived. A deployment with 128 reserved IDs has at most 128 such bindings; VM capacity and available host memory impose separate limits. Follow the [VFS deployment instructions](../../../team-docs/VULTR-VFS.md#执行-vm-的挂载和权限).
- Optional `vultr.legacyMultiStateRoot` identifies the old snapshot provider's private state for importing a confirmed closed multi-session VM's complete file cache. It does not close live legacy VMs or delete snapshots. A Workspace with no legacy VM record initializes its VFS directory from registered files. Keep the original state and snapshots for operator inspection after verified import.

```sh
export DSH_MULTIUSER_WORKSPACE_ROOT=/srv/antfarm/workspaces
export DSH_DOCKER_MODES_CONFIG_JSON="$(cat /srv/antfarm/workspace-modes.json)"
pnpm run start:web --patch apps/cli/config/examples/harness-docker-modes.patch.yml --no-open
```

The overlay starts new Workspaces in multi-session Docker mode. Keep a Docker mode as `workspace.defaultMode` and select the VM mode before creating the first Session. Antfarm calls the VM environment **Sandbox Pro (VM)**; DeepSeek Harness labels it **VM**. The switch prepares the VFS directory and moves any files already uploaded to the Workspace. In both VM modes, Web upload, listing and download use the verified VFS directory while the execution VM is closed. Listing and download remain available on a verified VFS directory during `cleanup_required`.

In single-session VM mode, the first valid task opens the VM and the last task releases it. A later message in the same Session starts a fresh VM with the files in VFS. Multi-session VM mode retains the VM across turns and Sessions in the Workspace. Manual closure, idle closure, Workspace archival, or deletion fences the helper, waits for task processes and writes to settle, synchronizes and unmounts the guest, then confirms VFS detachment and VM deletion. No new whole-VM snapshot is created. Files stay in VFS; installed tools and configuration outside `/workspace` are lost on VM recreation. Use a deployment image or repeatable installation to provide those tools.

Before moving snapshot-backed Workspaces to these modes, follow the [VM VFS upgrade guide](../../upgrade-guide/v0.2.2-alpha.3/vm-vfs-storage/guide.md). Retain the original records and snapshots until the workspace files have been verified and durably imported into VFS.
