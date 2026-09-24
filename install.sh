#!/usr/bin/env bash
#
# Install the latest Tsukuyomi launcher into ~/.local/bin.
#
# This does not touch the system package (a distro-installed `kaguyapi` under
# /usr/bin may still exist). Because ~/.local/bin normally precedes /usr/bin on
# PATH, the launchers installed here take precedence, so `tsukuyomi` and
# `kaguyapi` both run this source tree.
#
# Usage:
#   ./install.sh            install/refresh the launchers
#   ./install.sh --uninstall remove them

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
TSK="${BIN_DIR}/tsukuyomi"
LEGACY="${BIN_DIR}/kaguyapi"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "${TSK}" "${LEGACY}"
  echo "Removed ${TSK} and ${LEGACY}."
  echo "Your data in ${HOME}/.tsukuyomi was left in place."
  exit 0
fi

mkdir -p "${BIN_DIR}"
chmod +x "${ROOT}/bin/tsukuyomi.mjs" "${ROOT}/bin/kaguyapi.mjs"
ln -sfn "${ROOT}/bin/tsukuyomi.mjs" "${TSK}"
# Keep `kaguyapi` working, but it now forwards to Tsukuyomi (deprecation notice).
ln -sfn "${ROOT}/bin/kaguyapi.mjs" "${LEGACY}"

if ! command -v pi >/dev/null 2>&1; then
  echo "Note: no system \`pi\` on PATH. Tsukuyomi now bundles the PI kernel as a"
  echo "  dependency, so this is fine; it uses its own pinned copy."
fi

VERSION="$(node -e "console.log(require('${ROOT}/package.json').version)")"

echo "Tsukuyomi ${VERSION} installed:"
echo "  command : ${TSK}"
echo "  legacy  : ${LEGACY} (forwards to tsukuyomi)"
echo "  source  : ${ROOT}"
echo "  config  : ${HOME}/.tsukuyomi/agent"
echo
echo "Run:  tsukuyomi"

if ! echo ":${PATH}:" | grep -q ":${BIN_DIR}:"; then
  echo
  echo "Note: ${BIN_DIR} is not on PATH. Add this to your shell rc:"
  echo "  export PATH=\"${BIN_DIR}:\$PATH\""
elif command -v tsukuyomi >/dev/null 2>&1 && [ "$(command -v tsukuyomi)" != "${TSK}" ]; then
  echo
  echo "Note: \`tsukuyomi\` currently resolves to $(command -v tsukuyomi)."
  echo "Ensure ${BIN_DIR} precedes that directory on PATH."
fi
