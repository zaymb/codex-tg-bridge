#!/bin/sh
set -eu

socket_path=${1:?socket path is required}
socket_group=${2:?socket group is required}
case "$socket_path" in
  */*) socket_directory=${socket_path%/*} ;;
  *) socket_directory=. ;;
esac
wait_attempts=${SOCKET_WAIT_ATTEMPTS:-100}
wait_interval=${SOCKET_WAIT_INTERVAL:-0.1}
attempt=0

while [ ! -S "$socket_path" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$wait_attempts" ]; then
    printf 'timed out waiting for Unix socket %s\n' "$socket_path" >&2
    exit 1
  fi
  sleep "$wait_interval"
done

chgrp "$socket_group" "$socket_directory" "$socket_path"
chmod 0750 "$socket_directory"
chmod 0660 "$socket_path"
