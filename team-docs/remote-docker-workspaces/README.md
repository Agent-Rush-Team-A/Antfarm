# Docker workspaces on a dedicated VM

English | [中文](README.zh.md)

Each Antfarm deployment uses one Harness VM A and one Docker execution VM B. Both Docker workspace modes use B through the existing Runner API. A and B share a dedicated Vultr File System volume, and B mounts one registered workspace directory per container. [Runner installation](../SANDBOX-RUNNER.md) · [VFS installation](../VULTR-VFS.md)

## Install the service units

1. Prepare two Linux VMs in the same Vultr region and private network. Build the same Antfarm source on both under `/srv/antfarm/source`. Use the Runner profile and a fixed image digest on B. Use the documented `agentrush-runner` service account on B and an `antfarm-web` account on A.
2. Attach the dedicated Docker VFS volume to A and B. On both hosts create the empty mount point `/srv/antfarm/docker` as root with mode `0755`. Install [srv-antfarm-docker.mount](srv-antfarm-docker.mount) on both, setting `What` to that host's Mount Tag. Create `workspaces` inside the mounted volume with the numeric UID and GID of the Web account. For an existing installation, follow the cutover below before changing the registered root.
3. On B install [antfarm-docker-runner.service](antfarm-docker-runner.service) and configure `/etc/antfarm/docker-runner.env` with the Runner profile environment. Set `DSH_RUNNER_WORKSPACE_ROOT=/srv/antfarm/docker/workspaces`, the matching numeric container UID/GID, a unique `DSH_RUNNER_DEPLOYMENT`, and `ANTFARM_DOCKER_MOUNT_TAG`. Keep the Runner socket at `/run/agentrush-sandbox/runner.sock`.
4. On B create `antfarm-runner-link` with access to the `agentrush-sandbox` group and an A-specific SSH public key. Reserve access to the Docker group for the Runner service. Install [runner-link.sshd.conf](runner-link.sshd.conf) as an sshd drop-in. Validate it with `sshd -t` before reloading. Limit access to B's SSH port on the private network to A and trusted deployment operators.
5. On A install [runner-ssh.conf](runner-ssh.conf) as `/etc/antfarm/runner-ssh.conf`. Set the private address of B and install its verified SSH host key in the specified known-hosts file. Give the Web service account read access to the tunnel identity key. Install [antfarm-runner-tunnel.service](antfarm-runner-tunnel.service) and [antfarm-docker-web.service](antfarm-docker-web.service). Set the following in `/etc/antfarm/docker-web.env` along with the existing private Web profile settings.

   | Setting | Value |
   | --- | --- |
   | `ANTFARM_DOCKER_MOUNT_TAG` | A's VFS Mount Tag |
   | `ANTFARM_WEB_PORT` | Private loopback HTTP port |
   | `DSH_MULTIUSER_WORKSPACE_ROOT` | `/srv/antfarm/docker/workspaces` |
   | `DSH_DOCKER_MODES_CONFIG_JSON` | Set `workspaceRoot` to the shared workspace root, `socketPath` to `/run/antfarm-runner-tunnel/runner.sock` and `drainSocket` to `/run/antfarm-docker-web/drain.sock`. Set a private `stateRoot` and the migration limits `maxFiles` and `maxBytes` |

Install units under `/etc/systemd/system`, then run `systemctl daemon-reload` on both hosts. The mounts start with the respective services. A verifies that the modes configuration uses the checked workspace root and the tunnel socket before starting Web. If the current registered workspace paths differ from the example, set the same runtime path on both hosts and update the mount unit name, service dependencies and preflight paths in the units and `host-control.sh` together. Both Workspace VM modes share their own VM VFS volume and UID/GID pool, separate from the Docker volume. Preserve the shared identity state and each VM mode's distinct private allocation state outside both volumes.

## Start and stop the deployment

Run [pair.py](pair.py) on a Linux admin host outside the pair. Use a private JSON file with `region`, `deployment` matching `DSH_RUNNER_DEPLOYMENT`, and `apiKeyFile` pointing to a private Vultr API key file. Add `harness` and `runner` objects with `id`, `label` and a pinned SSH host alias in `ssh`. The aliases use SSH admin accounts that can run [host-control.sh](host-control.sh) as root. Protect the config, keys and deployed source against modification by workspace processes.

Run `python3 pair.py /path/to/private-pair.json start` or `stop`. Start waits for B's Runner, then checks both A's Web endpoint and the Workspace mode readiness socket. Stop uses A's owner-only drain socket to reject new workspace mode operations and wait for queued and active work to settle. A drain timeout leaves the deployment paused and powered on. Retry `stop` after the pending work settles. A stops Web and flushes its disks after the drain. B confirms that its owned containers are closed, stops the Runner and Docker, and flushes its disks before the VM power-off request. Vultr accounts continue to incur VM charges while instances are stopped. [Vultr stop behavior](https://docs.vultr.com/products/compute/instances/cloud-compute/management/stop-instance)

## Cut over existing workspace files

Stop the existing Web and Docker Runner deployment to prevent new writes. Copy the registered workspace directories to a temporarily mounted Docker VFS volume while retaining names, contents, ownership and modes. For example, copy with `rsync -aH --numeric-ids`, then check the same source and target using `rsync -aHnci --numeric-ids --delete` and confirm the report is empty. Inventory the source first so control state and credentials stay outside the shared volume. Move the old directories to a private backup, mount the new volume at the planned location, then verify read/write as the Web and task identities before opening traffic. Preserve the original registered paths on A and B.

If validation fails before reopening traffic, stop the candidate services and switch back to the backup directory and original Runner endpoint. Once traffic resumes, stop writes and reconcile any newly published files before restoring a backup.
