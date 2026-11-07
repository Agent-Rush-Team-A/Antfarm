#!/bin/bash
set -euo pipefail

reject() { printf 'VFS helper refused: %s\n' "$1" >&2; exit 1; }

[[ $# = 3 && $(id -u) = 0 ]] || reject 'expected a privileged launch with task ID, workspace and helper'
task_id=$1
workspace=$2
helper=$3

[[ "$task_id" =~ ^[1-9][0-9]{0,9}$ && "$task_id" -lt 4294967295 ]] || reject 'invalid numeric task identity'
[[ "$workspace" = /* && "$(realpath -e -- "$workspace")" = "$workspace" && -d "$workspace" ]] ||
  reject 'workspace is not a canonical directory'
[[ "$(stat -c '%g:%a' -- "$workspace")" = "$task_id:2770" ]] || reject 'workspace group or permissions differ'
[[ "$helper" = /* && -f "$helper" && -x "$helper" && "$(realpath -e -- "$helper")" = "$helper" ]] ||
  reject 'installed helper is unavailable'
read -r owner mode < <(stat -c '%u %a' -- "$helper")
[[ "$owner" = 0 ]] && (( (8#$mode & 022) == 0 )) || reject 'installed helper must be protected by root'

cd -- "$workspace"
umask 0007
exec /usr/bin/setpriv --reuid "$task_id" --regid "$task_id" --clear-groups --no-new-privs \
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
  /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/workspace-exec \
  DSH_SSH_VFS_WORKSPACE=1 NODE_OPTIONS=--disable-sigusr1 "$helper"
