#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${PACKAGE_OUTPUT:-$ROOT/dist/packages}"
PACKAGER_IMAGE="${BUILDER_IMAGE:-localhost/tsukuyomi-packager:44}"
NATIVE_IMAGE="${NATIVE_BUILDER_IMAGE:-localhost/tsukuyomi-native-builder:el8}"
DIRECT_BUILD="${TSUKUYOMI_DIRECT_BUILD:-0}"

REQUIRED_COMMANDS=(node npm ar python3)
if [[ "$DIRECT_BUILD" != 1 ]]; then
	REQUIRED_COMMANDS+=(podman)
fi
for command in "${REQUIRED_COMMANDS[@]}"; do
	command -v "$command" >/dev/null 2>&1 || {
		printf 'Tsukuyomi packaging requires %s.\n' "$command" >&2
		exit 1
	}
done

mkdir -p "$OUTPUT"
printf 'Creating npm package...\n'
(cd "$ROOT" && npm pack --ignore-scripts --pack-destination "$OUTPUT") >/dev/null

if [[ "$DIRECT_BUILD" != 1 ]]; then
	if [[ "${TSUKUYOMI_SKIP_IMAGE_BUILD:-0}" != 1 ]] || ! podman image exists "$PACKAGER_IMAGE"; then
		printf 'Preparing RPM/Arch builder image...\n'
		podman build -t "$PACKAGER_IMAGE" "$ROOT/packaging/bundle"
	fi
	if [[ "${TSUKUYOMI_SKIP_IMAGE_BUILD:-0}" != 1 ]] || ! podman image exists "$NATIVE_IMAGE"; then
		printf 'Preparing glibc 2.28 native-addon builder image...\n'
		podman build -t "$NATIVE_IMAGE" "$ROOT/packaging/native"
	fi
fi

if [[ -e "$OUTPUT/bundle-work" ]]; then
	if [[ "$DIRECT_BUILD" == 1 ]]; then
		rm -rf "$OUTPUT/bundle-work"
	else
		podman unshare rm -rf "$OUTPUT/bundle-work"
	fi
fi
printf 'Creating bundled Linux packages...\n'
BUNDLE_OUTPUT="$OUTPUT" \
BUILDER_IMAGE="$PACKAGER_IMAGE" \
NATIVE_BUILDER_IMAGE="$NATIVE_IMAGE" \
bash "$ROOT/packaging/bundle/build-local.sh"
if [[ "${TSUKUYOMI_KEEP_PACKAGE_WORK:-0}" != 1 ]]; then
	if [[ "$DIRECT_BUILD" == 1 ]]; then
		rm -rf "$OUTPUT/bundle-work"
	else
		podman unshare rm -rf "$OUTPUT/bundle-work"
	fi
fi
