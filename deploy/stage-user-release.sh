#!/usr/bin/env bash
set -euo pipefail

umask 077

NODE_VERSION=${NODE_VERSION:-v24.18.0}
if [[ ! ${NODE_VERSION} =~ ^v24\.[0-9]+\.[0-9]+$ ]]; then
  printf 'NODE_VERSION must be a pinned Node 24 release such as v24.18.0\n' >&2
  exit 1
fi

case "$(uname -s):$(uname -m)" in
  Linux:x86_64) node_platform=linux-x64 ;;
  Linux:aarch64|Linux:arm64) node_platform=linux-arm64 ;;
  *)
    printf 'unsupported platform: %s %s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

for command in curl sha256sum tar git; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'required command is missing: %s\n' "${command}" >&2
    exit 1
  }
done

source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo_root=$(cd "${source_root}/.." && pwd)
release_id=${BRIDGE_RELEASE_ID:-$(git -C "${repo_root}" rev-parse --verify --short=12 HEAD)}
if [[ ! ${release_id} =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  printf 'BRIDGE_RELEASE_ID contains unsupported characters\n' >&2
  exit 1
fi

data_root=${XDG_DATA_HOME:-${HOME}/.local/share}/codex-tg-bridge
runtime_root=${data_root}/runtime
release_root=${data_root}/releases
runtime_dir=${runtime_root}/node-${NODE_VERSION}
release_dir=${release_root}/${release_id}
node_binary=${runtime_dir}/bin/node
npm_cli=${runtime_dir}/lib/node_modules/npm/bin/npm-cli.js
checksum_marker=${runtime_dir}/.archive-sha256

mkdir -p "${runtime_root}" "${release_root}"
work_dir=$(mktemp -d "${data_root}/.stage.XXXXXX")
cleanup() {
  rm -rf "${work_dir}"
}
trap cleanup EXIT

archive=node-${NODE_VERSION}-${node_platform}.tar.xz
dist_url=https://nodejs.org/dist/${NODE_VERSION}

if [[ ! -x ${node_binary} ]]; then
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    --output "${work_dir}/SHASUMS256.txt" "${dist_url}/SHASUMS256.txt"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    --output "${work_dir}/${archive}" "${dist_url}/${archive}"

  expected_sha=$(awk -v archive="${archive}" '$2 == archive { print $1 }' "${work_dir}/SHASUMS256.txt")
  if [[ ! ${expected_sha} =~ ^[a-f0-9]{64}$ ]]; then
    printf 'official SHASUMS256.txt has no unique checksum for %s\n' "${archive}" >&2
    exit 1
  fi
  actual_sha=$(sha256sum "${work_dir}/${archive}" | awk '{ print $1 }')
  if [[ ${actual_sha} != "${expected_sha}" ]]; then
    printf 'SHA-256 mismatch for %s\n' "${archive}" >&2
    exit 1
  fi

  tar -xJf "${work_dir}/${archive}" -C "${work_dir}"
  staged_runtime=${work_dir}/node-${NODE_VERSION}-${node_platform}
  printf '%s  %s\n' "${actual_sha}" "${archive}" > "${staged_runtime}/.archive-sha256"
  mv "${staged_runtime}" "${runtime_dir}"
else
  if [[ ! -f ${checksum_marker} ]]; then
    printf 'existing runtime has no checksum marker: %s\n' "${runtime_dir}" >&2
    exit 1
  fi
  actual_sha=$(awk 'NR == 1 { print $1 }' "${checksum_marker}")
  if [[ ! ${actual_sha} =~ ^[a-f0-9]{64}$ ]]; then
    printf 'existing runtime checksum marker is invalid\n' >&2
    exit 1
  fi
fi

actual_version=$("${node_binary}" --version)
if [[ ${actual_version} != "${NODE_VERSION}" ]]; then
  printf 'isolated Node version mismatch: expected %s, got %s\n' "${NODE_VERSION}" "${actual_version}" >&2
  exit 1
fi

if [[ -e ${release_dir} ]]; then
  printf 'release path already exists; refusing to overwrite: %s\n' "${release_dir}" >&2
  exit 1
fi

staged_release=${work_dir}/release
mkdir -p "${staged_release}"
tar \
  --exclude='./node_modules' \
  --exclude='./.state' \
  --exclude='./.env' \
  --exclude='./coverage' \
  -C "${source_root}" -cf - . | tar -C "${staged_release}" -xf -

syntax_count=0
while IFS= read -r -d '' source_file; do
  "${node_binary}" --check "${source_file}" >/dev/null
  syntax_count=$((syntax_count + 1))
done < <(find "${staged_release}/src" "${staged_release}/scripts" -type f -name '*.mjs' -print0)

(
  cd "${staged_release}"
  PATH="${runtime_dir}/bin:${PATH}" "${node_binary}" "${npm_cli}" ci
  PATH="${runtime_dir}/bin:${PATH}" "${node_binary}" "${npm_cli}" test
)

mv "${staged_release}" "${release_dir}"

printf 'runtime_binary=%s\n' "${node_binary}"
printf 'runtime_version=%s\n' "${actual_version}"
printf 'archive_sha256=%s\n' "${actual_sha}"
printf 'sha256_verified=true\n'
printf 'release_path=%s\n' "${release_dir}"
printf 'syntax_checks=%s\n' "${syntax_count}"
printf 'tests=passed\n'
printf 'service_changed=false\n'
