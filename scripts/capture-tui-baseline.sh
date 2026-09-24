#!/usr/bin/env bash
# Capture OMP's production gallery renderers without touching real user config.
# Usage: OMP_BASE=/tmp/tsukuyomi-omp-18.3.0-XXXXXX bash scripts/capture-tui-baseline.sh [output-directory]
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUT=${1:-"$ROOT/docs/tui-baseline/omp-18.3.0"}
BASE=${OMP_BASE:?Set OMP_BASE to the isolated npm --prefix directory}
BASE=$(cd -- "$BASE" && pwd)
BUN="$BASE/node_modules/@oven/bun-linux-x64/bin/bun"
CLI="$BASE/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"
HOME_DIR="$BASE/home"
PROJECT="$BASE/project"
for item in "$BUN" "$CLI"; do
  if [[ ! -f "$item" ]]; then printf 'Missing isolated executable: %s\n' "$item" >&2; exit 1; fi
done
mkdir -p "$HOME_DIR" "$PROJECT" "$OUT"
version=$(cd "$PROJECT" && env -i HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" PATH=/usr/bin:/bin TERM=xterm-256color COLORTERM=truecolor PI_OFFLINE=1 "$BUN" "$CLI" --version)
if [[ "$version" != "omp/18.3.0" ]]; then printf 'Refusing to capture unexpected version: %s\n' "$version" >&2; exit 1; fi

capture() {
  local filename=$1; shift
  (
    cd "$PROJECT"
    env -i HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" XDG_CACHE_HOME="$HOME_DIR/.cache" \
      PATH=/usr/bin:/bin TERM=xterm-256color COLORTERM=truecolor PI_OFFLINE=1 \
      "$BUN" "$CLI" gallery "$@"
  ) > "$OUT/$filename"
  # The edit renderer has a live preview spinner; its phase depends on process
  # scheduling. Canonicalize only that glyph so repeated fixture captures match.
  if [[ "$filename" == edit-*.ansi ]]; then
    ANSI_FILE="$OUT/$filename" node --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs";
      const path = process.env.ANSI_FILE;
      const text = readFileSync(path, "utf8");
      writeFileSync(path, text.replace(/[\u2800-\u28ff] (?=\x1b\[[0-9;]*m\(preview\))/g, "⠿ "));
    '
  fi
}

for width in 80 120 160; do
  capture "composer-${width}.ansi" --surface=composer --width="$width"
  for tool in read bash edit task todo; do
    capture "${tool}-${width}.ansi" --surface=tool --tool="$tool" --width="$width"
  done
done
# ANSI preserves background colors and cell boundaries; text snapshots are
# reviewable in diffs but are not substitutes for the ANSI/color originals.
for file in "$OUT"/*.ansi; do
  ANSI_FILE="$file" PLAIN_FILE="${file%.ansi}.txt" node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const ansi = readFileSync(process.env.ANSI_FILE, "utf8");
    const plain = ansi.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
    writeFileSync(process.env.PLAIN_FILE, plain);
  '
done
(
  cd "$OUT"
  sha256sum -- *.ansi *.txt > SHA256SUMS
)
printf 'Captured %s gallery renderer files from %s into %s\n' "$(find "$OUT" -maxdepth 1 -name '*.ansi' | wc -l)" "$version" "$OUT"
printf 'Renderer CLI sha256: '; sha256sum "$CLI" | cut -d' ' -f1
printf 'Bun sha256: '; sha256sum "$BUN" | cut -d' ' -f1
