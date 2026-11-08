# Deploy workspaces on Vultr File System

English | [中文](VULTR-VFS.zh.md)

In a shared-volume deployment, the Harness mounts Vultr File System (VFS) and serves Web uploads and downloads. The Harness, Runner, and Docker use the same workspace root on one VM. The Runner mounts only the registered workspace directory at `/workspace` in its container. For a separate execution VM, an administrator mounts the whole volume and bind-mounts only the assigned task directory at `/workspace`. Workspace registration and files survive the execution VM.

## Start the Harness

1. Prepare a Linux VM in the volume's region, enable Shared Memory Backing, attach the volume, and copy the Mount Tag from the Vultr console. Mount the volume at `/srv/antfarm/vfs` with `virtiofs`. Before mounting, keep the local mount point empty, owned by root, and set to mode `0755`. Confirm that the Docker daemon can see the same path. [Vultr Linux mount guide](https://docs.vultr.com/products/storage/file-system/mount/linux)
2. Create `workspace/` on the mounted volume and make the Web service account its owner. Set the Web service's `DSH_MULTIUSER_WORKSPACE_ROOT` and the Runner's `DSH_RUNNER_WORKSPACE_ROOT` to `/srv/antfarm/vfs/workspace`. Set `DSH_SANDBOX_RUNNER_SOCKET` in the Web service environment to the Runner's listening path, which defaults to `/run/agentrush-sandbox/runner.sock`. Build the project on Linux and prepare the Runner profile and sandbox image. The Harness creates workspaces owned by the Web account with mode `0700` by default, so `DSH_RUNNER_CONTAINER_UID` must match that account's numeric UID. [Runner setup](SANDBOX-RUNNER.md)
3. Use `srv-antfarm-vfs.mount` for the persistent mount. Set `What` to the Mount Tag and set `Where=/srv/antfarm/vfs`, `Type=virtiofs`, and `Options=nosuid,nodev`. Enable the unit with `local-fs.target`. In both Web and Runner units, declare `BindsTo` and `After` on the mount. Use `Requires` and `After` to make the Runner depend on Docker and Web depend on the Runner.
4. Install the [mount check script](vfs/check-mount.sh), make it executable, and run it as `ExecStartPre` for both services. Pass the mount point, expected source, path within the volume, data directory, and access mode in that order. On the Harness, use `/srv/antfarm/vfs`, the Mount Tag, `/`, and `/srv/antfarm/vfs/workspace` as the first four arguments. The Web service runs a `read-write` probe as its own account. The Runner runs the `traverse` check as its own account, while the container identity handles file reads and writes. A missing mount or a source or filesystem type mismatch prevents startup and leaves the underlying local directory empty.

Add the following settings to the Web systemd unit together with the mount dependencies and `ExecStartPre` above. Adjust the Web account, shared Runner group, repository path, and `pnpm` path for the deployment. Start the Web unit with `systemctl` and use an SSH tunnel to reach the loopback port.

```ini
[Service]
User=antfarm-web
SupplementaryGroups=agentrush-sandbox
WorkingDirectory=/srv/deepseek-harness
Environment=DSH_MULTIUSER_WORKSPACE_ROOT=/srv/antfarm/vfs/workspace
Environment=DSH_SANDBOX_RUNNER_SOCKET=/run/agentrush-sandbox/runner.sock
ExecStart=/usr/local/bin/pnpm run start:web --patch apps/cli/config/examples/harness-sandbox.patch.yml --host 127.0.0.1 --port 3080 --no-open
```

After startup, check the source, filesystem type, and path within the volume with `findmnt`. Look for `VFS preflight accepted` in both service logs. Sign in from a browser, open a workspace, and verify sandbox startup, upload, and download.

```sh
findmnt -rn --mountpoint /srv/antfarm/vfs -o TARGET,SOURCE,FSTYPE,FSROOT
```

<a id="执行-vm-的挂载和权限"></a>

## Execution VM mounts and permissions

- Read the registered absolute directory from the Harness. Confirm that it is a real, direct child of `/srv/antfarm/vfs/workspace`. Strip the mount root `/srv/antfarm/vfs` to get the path within the volume, such as `/workspace/ws-…`. Antfarm generates the workspace ID and directory name separately.
- Set mode `0711` on the volume root and the workspace parent directory. Before the first upload or task, assign a dedicated numeric UID and GID to the workspace's task account. Keep the Web account as the registered directory owner, set its group to the task GID, and set mode `2770`. Add the Web service account to that group. If Web is already running, restart it after changing group membership so the new supplementary groups take effect.
- Uploaded files use the registered directory's GID at upload time. To migrate an existing workspace, pause its uploads and tasks, then change the group of existing uploads needed by the execution VM to the new shared GID. Preserve file ownership and permissions. Confirm that the task account can read the files before resuming tasks.
- Enable Shared Memory Backing on an execution VM in the same region, then attach the volume. Mount the whole volume and bind-mount only the registered directory at `/workspace`. Record the volume ID and instance ID. Run task processes under the assigned UID and GID, clear supplementary groups and capabilities, and set `no_new_privs`. Before starting a task, verify the mount point, filesystem type, source, and path within the volume as the task identity. Run the `read-write` probe under that identity. The expected source of the bind mount looks like `<Mount Tag>[/workspace/ws-…]`. A failed check blocks execution. [Mount check script](vfs/check-mount.sh)
- Before the task finishes, make any outputs intended for the Web UI readable by the workspace group, for example with mode `0640`. The file owner must make this change. Files created with mode `0600` may prevent Web listing or download.
- The native mount relies on a restricted task identity to isolate workspaces. Execution VM administrators and initialization code need to be trusted. To enforce subdirectory and client IP restrictions at the storage layer, configure Storage Gateway separately. [Vultr Storage Gateway](https://docs.vultr.com/products/storage/storage-gateway/provisioning)

Single-session VMs use separate roots for registered directories and VFS workspaces. `SingleVmWorkspaces` maps the registered directory name to its directory on the volume. The Web account's supplementary groups include all reserved task groups. The Web account owns the workspace parent directory on the volume, which uses mode `0711`. The provider stores UID and GID assignments in its private `stateRoot` outside the mount. Preserve that state with the workspace registry when migrating the Harness. On transition to single-session VM mode, the staging directory uses mode `2770` and staged files grant read and write access to the corresponding task group. Existing executables retain execute permissions.

After verifying the whole-volume and bind mounts with the [mount check script](vfs/check-mount.sh) and confirming that the task account can read and write files, run the [restricted helper launcher](vfs/run-workspace-helper.sh) from a trusted installation directory. Pass the assigned task UID and GID, the verified `/workspace` path, and the installed helper's absolute path in that order. The launcher starts the helper as the task identity. Bash child processes inherit that identity and its restrictions. The text tools publish new files with mode `0660` and preserve permissions on replacement. File owners remain responsible for publishing private files created by Bash.

The single-session allocation provider reads the volume UUID from the deployment configuration and loads both scripts from `vfsScriptsRoot`. Keep that directory, management keys, helper archives, and allocation records outside all workspace mounts. The execution VM image must provide OpenSSH, `sudo`, util-linux `setpriv` and `flock`, procps `pgrep` and `pkill`, and `virtiofs` support. The management connection handles mounting and installation. It also prepares a local helper cache in the task account's home directory that only that account can write to.

The Harness holds the SSH private key for the execution VM. When it connects as `workspace-exec` with this key, SSH forces the fixed helper command. This login allows only client-initiated local forwarding. OpenSSH also requires local TCP forwarding permission to open the helper's Unix socket. Disable forwarding for other accounts. [OpenSSH forwarding permissions](https://github.com/openssh/openssh-portable/blob/V_9_6_P1/session.c#L313-L335)

## Reclaim an execution VM

The task lifecycle reclaims a single-session VM after queued input, commands, and writes have settled. On the old VM, the administrator prevents the helper from restarting, terminates any remaining processes owned by its dedicated task UID, and confirms they have exited. The administrator then syncs the filesystem and unmounts `/workspace` followed by the volume root. If the SSH readiness check or helper installation fails before any mount command is sent, the provider can proceed directly to cloud cleanup. The provider detaches the volume using the volume and instance IDs, confirms that the attachment is gone, then deletes the instance and confirms that both the instance and its attachment are gone. The next VM uses the same volume and registered directory. [Manage Vultr volume attachments](https://docs.vultr.com/products/storage/file-system/management/attach-instances)

At startup, the Harness reconciles retained records one at a time. Later tasks can also trigger reconciliation. If an instance creation request receives no response, the Harness looks up the instance by its original unique label. If an attachment, deletion, or write outcome remains uncertain, the Harness retains the recorded phase and capacity reservation and reports `cleanup_required`. During reconciliation, it operates only on instances and attachments that match the original labels and resource IDs.

Before reusing a volume, verify its attachment and Mount Tag in the Vultr console.
