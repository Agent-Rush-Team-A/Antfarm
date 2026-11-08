#!/usr/bin/env bash
set -euo pipefail

stop_unit() {
  systemctl stop "$1"
  test "$(systemctl show --property=Result --value "$1")" = success
}

runner_workspaces() {
  docker ps -a --filter 'label=org.agentrush.sandbox.project=agentrush' \
    --filter "label=org.agentrush.sandbox.deployment=$deployment" \
    --format '{{.Label "org.agentrush.sandbox.workspace"}}'
}

case "${1:-}" in
  harness-check)
    python3 - <<'PY'
import json
import os

root = "/srv/antfarm/docker/workspaces"
settings = json.loads(os.environ["DSH_DOCKER_MODES_CONFIG_JSON"])
if settings.get("socketPath") != "/run/antfarm-runner-tunnel/runner.sock":
    raise SystemExit("Docker modes must use the dedicated Runner tunnel")
if settings.get("drainSocket") != "/run/antfarm-docker-web/drain.sock":
    raise SystemExit("Docker modes must use the dedicated shutdown socket")
if settings.get("workspaceRoot") != root or os.environ.get("DSH_MULTIUSER_WORKSPACE_ROOT") != root:
    raise SystemExit("Docker modes and the registry must use the verified VFS workspace root")
PY
    ;;
  runner-start)
    systemctl start antfarm-docker-runner.service
    ;;
  harness-start)
    systemctl start antfarm-docker-web.service
    curl --fail --silent --show-error --output /dev/null --max-time 3 \
      --unix-socket /run/antfarm-docker-web/drain.sock http://localhost/ready
    ;;
  harness-stop)
    if systemctl is-active --quiet antfarm-docker-web.service; then
      curl --fail --silent --show-error --output /dev/null --max-time 120 \
        --unix-socket /run/antfarm-docker-web/drain.sock --request POST http://localhost/drain
    fi
    stop_unit antfarm-docker-web.service
    stop_unit antfarm-runner-tunnel.service
    sync
    ;;
  runner-stop)
    deployment=$2
    [[ "$deployment" =~ ^[a-zA-Z0-9_-]+$ ]]
    test "$(sed -n 's/^DSH_RUNNER_DEPLOYMENT=//p' /etc/antfarm/docker-runner.env)" = "$deployment"
    systemctl start docker.service
    workspaces=$(runner_workspaces)
    if [[ -n "$workspaces" ]]; then
      while IFS= read -r workspace; do
        [[ "$workspace" =~ ^[a-zA-Z0-9_-]{1,128}$ ]]
        curl --fail --silent --show-error --output /dev/null --max-time 20 \
          --unix-socket /run/agentrush-sandbox/runner.sock --request DELETE \
          "http://localhost/v1/workspaces/$workspace/sandbox"
      done <<< "$workspaces"
    fi
    workspaces=$(runner_workspaces)
    test -z "$workspaces"
    stop_unit antfarm-docker-runner.service
    # Vultr halt can cut power before Docker's container deletion reaches disk.
    systemctl stop docker.service docker.socket
    sync
    ;;
  *)
    printf 'Unknown Antfarm deployment action\n' >&2
    exit 2
    ;;
esac
