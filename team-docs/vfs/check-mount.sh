#!/usr/bin/env bash
set -euo pipefail

mount_point=$1
expected_source=$2
expected_root=$3
data_dir=$4
access=$5
expected="$expected_source virtiofs $expected_root"

reject() {
  printf 'VFS preflight rejected %s (uid=%s gid=%s): %s\n' "$mount_point" "$(id -u)" "$(id -g)" "$*" >&2
  exit 1
}

actual=$(findmnt -rn --mountpoint "$mount_point" -o SOURCE,FSTYPE,FSROOT) || reject 'exact mount point missing'
[[ "$actual" == "$expected" ]] || reject "expected [$expected], got [$actual]"
[[ "$(realpath -e -- "$data_dir")" == "$data_dir" && -d "$data_dir" && -x "$data_dir" ]] ||
  reject "cannot traverse $data_dir"
actual=$(findmnt -rn --target "$data_dir" -o TARGET,SOURCE,FSTYPE,FSROOT) || reject "cannot resolve mount for $data_dir"
[[ "$actual" == "$mount_point $expected" ]] || reject "unexpected mount for $data_dir: [$actual]"

if [[ "$access" == read-write ]]; then
  probe=$(mktemp -d -- "$data_dir/.antfarm-vfs-check.XXXXXXXX") || reject "cannot create probe in $data_dir"
  trap 'rm -f -- "$probe/value"; rmdir -- "$probe"' EXIT
  printf '%s\n' 'antfarm-vfs' > "$probe/value" || reject 'cannot write probe'
  [[ "$(cat -- "$probe/value")" == antfarm-vfs ]] || reject 'cannot read probe'
elif [[ "$access" != traverse ]]; then
  reject "invalid access check: $access"
fi

printf 'VFS preflight accepted %s source=%s fsroot=%s uid=%s gid=%s access=%s\n' \
  "$mount_point" "$expected_source" "$expected_root" "$(id -u)" "$(id -g)" "$access"
