#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BINARY="$(readlink -f "$(command -v node)")"
NODE_HOME="${NODE_HOME:-$(cd "$(dirname "$NODE_BINARY")/.." && pwd)}"
IMAGE="${BUILDER_IMAGE:-localhost/tsukuyomi-packager:44}"
NATIVE_IMAGE="${NATIVE_BUILDER_IMAGE:-localhost/tsukuyomi-native-builder:el8}"
OUT="${BUNDLE_OUTPUT:-$ROOT/dist/packages}"
WORK="${BUNDLE_WORK:-$OUT/bundle-work}"
RELEASE="${PACKAGE_RELEASE:-1}"
DIRECT_BUILD="${TSUKUYOMI_DIRECT_BUILD:-0}"

[[ "$(uname -m)" == x86_64 ]] || { echo 'Bundled packages currently support Linux x86_64 only.' >&2; exit 1; }
REQUIRED_COMMANDS=(ar md5sum objdump python3 tar xz)
if [[ "$DIRECT_BUILD" == 1 ]]; then
	REQUIRED_COMMANDS+=(rpmbuild makepkg)
else
	REQUIRED_COMMANDS+=(podman)
fi
for command in "${REQUIRED_COMMANDS[@]}"; do
	command -v "$command" >/dev/null 2>&1 || { echo "$command is required to build bundled packages." >&2; exit 1; }
done
[[ -x "$NODE_HOME/bin/node" ]] || { echo "Node.js was not found under NODE_HOME=$NODE_HOME" >&2; exit 1; }
[[ -f "$NODE_HOME/LICENSE" ]] || { echo "The Node.js license was not found under NODE_HOME=$NODE_HOME" >&2; exit 1; }
PI_HOME="${PI_HOME:-$ROOT/node_modules/@earendil-works/pi-coding-agent}"
if [[ ! -f "$PI_HOME/package.json" ]]; then
	PI_HOME="$NODE_HOME/lib/node_modules/@earendil-works/pi-coding-agent"
fi
[[ -f "$PI_HOME/package.json" ]] || { echo "Pi was not found under $PI_HOME" >&2; exit 1; }
if [[ "$DIRECT_BUILD" != 1 ]]; then
	podman image exists "$IMAGE" || { echo "Missing image $IMAGE; run packaging/build-packages.sh first." >&2; exit 1; }
	podman image exists "$NATIVE_IMAGE" || { echo "Missing image $NATIVE_IMAGE; run packaging/build-packages.sh first." >&2; exit 1; }
fi
[[ ! -e "$WORK" ]] || { echo "Remove previous $WORK before rebuilding" >&2; exit 1; }

VERSION="$($NODE_HOME/bin/node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$ROOT/package.json")"
NODE_VERSION="$($NODE_HOME/bin/node --version)"; NODE_VERSION="${NODE_VERSION#v}"
PI_VERSION="$($NODE_HOME/bin/node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$PI_HOME/package.json")"

mkdir -p "$WORK/stage/usr/lib/tsukuyomi" "$WORK/stage/usr/bin" "$WORK/stage/usr/share/"{licenses,doc}/tsukuyomi
APP="$WORK/stage/usr/lib/tsukuyomi"
cp -a "$ROOT/"{app,bin,src,package.json,LICENSE,README.md} "$APP/"
mkdir -p "$APP/runtime/bin" "$APP/runtime/lib/node_modules/@earendil-works"
cp -a "$NODE_HOME/bin/node" "$APP/runtime/bin/"
cp -a "$NODE_HOME/LICENSE" "$APP/runtime/LICENSE"
cp -a "$NODE_HOME/lib/node_modules/npm" "$APP/runtime/lib/node_modules/"
rm -f "$APP/runtime/lib/node_modules/npm/.npmrc"
cp -a "$PI_HOME" "$APP/runtime/lib/node_modules/@earendil-works/"
ln -s ../lib/node_modules/npm/bin/npm-cli.js "$APP/runtime/bin/npm"
ln -s ../lib/node_modules/npm/bin/npx-cli.js "$APP/runtime/bin/npx"
ln -s ../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js "$APP/runtime/bin/pi"

# Flatten Pi packages so the independent TUI never resolves dependencies from $HOME.
mkdir -p "$APP/node_modules/@earendil-works" "$APP/node_modules/@xterm" "$APP/node_modules/.bin"
ln -s ../../runtime/lib/node_modules/@earendil-works/pi-coding-agent "$APP/node_modules/@earendil-works/pi-coding-agent"
PI_NESTED="$APP/runtime/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works"
for dep in pi-tui pi-agent-core pi-ai pi-client pi-protocol pi-telemetry; do
	[[ -d "$PI_NESTED/$dep" ]] || continue
	ln -s "../../runtime/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/$dep" "$APP/node_modules/@earendil-works/$dep"
done
ln -s ../runtime/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox "$APP/node_modules/typebox"
ln -s ../../runtime/bin/pi "$APP/node_modules/.bin/pi"
ln -s ../../runtime/bin/node "$APP/node_modules/.bin/node"

# Rebuild node-pty against glibc 2.28 for broad Linux compatibility.
cp -a "$ROOT/node_modules/node-pty" "$ROOT/node_modules/node-addon-api" "$APP/node_modules/"
cp -a "$ROOT/node_modules/@xterm/headless" "$APP/node_modules/@xterm/"
rm -rf "$APP/node_modules/node-pty/build" "$APP/node_modules/node-pty/prebuilds"
if [[ "$DIRECT_BUILD" == 1 ]]; then
	NATIVE_BINARY="${TSUKUYOMI_NATIVE_BINARY:-}"
	[[ -f "$NATIVE_BINARY" ]] || { echo 'TSUKUYOMI_NATIVE_BINARY must point to a rebuilt node-pty pty.node in direct mode.' >&2; exit 1; }
	install -Dm755 "$NATIVE_BINARY" "$APP/node_modules/node-pty/build/Release/pty.node"
else
	podman run --rm \
		-v "$APP:/opt/tsukuyomi:Z" \
		-v "$NODE_HOME:/opt/node:ro,Z" \
		"$NATIVE_IMAGE" sh -euxc '
			cd /opt/tsukuyomi/node_modules/node-pty
			export PATH="/opt/node/bin:$PATH" PYTHON=/usr/bin/python3.9
			/opt/node/bin/node /opt/node/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --nodedir=/opt/node
		'
fi

install -m755 "$ROOT/packaging/bundle/tsukuyomi" "$WORK/stage/usr/bin/tsukuyomi"
install -m644 "$ROOT/LICENSE" "$WORK/stage/usr/share/licenses/tsukuyomi/LICENSE"
install -m644 "$ROOT/README.md" "$WORK/stage/usr/share/doc/tsukuyomi/README.md"
install -m644 "$ROOT/LICENSE" "$WORK/stage/usr/share/doc/tsukuyomi/copyright"

python3 - "$APP" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
required = [
    root / 'node_modules/@earendil-works/pi-tui/dist/index.js',
    root / 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    root / 'runtime/bin/pi', root / 'runtime/bin/node',
    root / 'node_modules/.bin/pi', root / 'app/tui.mjs',
    root / 'app/providers/accounts.mjs',
]
missing = [str(path) for path in required if not path.exists()]
if missing:
    raise SystemExit('Bundled runtime is incomplete:\n' + '\n'.join(missing))
for p in root.rglob('*'):
    if p.is_symlink():
        assert p.exists(), f'Dangling symlink: {p}'
        assert p.resolve().is_relative_to(root), f'External symlink: {p}'
    assert p.name not in ('auth.json', 'accounts.json', 'models-store.json', '.env', '.npmrc'), f'Private file: {p}'
PY

for binary in "$APP/runtime/bin/node" "$APP/node_modules/node-pty/build/Release/pty.node"; do
	max_glibc="$(objdump -T "$binary" | grep -o 'GLIBC_[0-9.]*' | sort -V | tail -1)"
	[[ "$max_glibc" == "GLIBC_2.28" || "$(printf '%s\n' "$max_glibc" 'GLIBC_2.28' | sort -V | tail -1)" == 'GLIBC_2.28' ]] || {
		echo "$binary requires unsupported $max_glibc" >&2; exit 1;
	}
done

(cd "$WORK/stage" && find usr -type f -print0 | sort -z | xargs -0 sha256sum) > "$OUT/payload-SHA256SUMS"
tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$WORK/tsukuyomi-bundle.tar.gz" -C "$WORK/stage" usr
cp "$ROOT/packaging/bundle/"{tsukuyomi.spec,PKGBUILD,debian-control,tsukuyomi.install} "$WORK/"
INSTALLED_SIZE="$(du -sk "$WORK/stage/usr" | cut -f1)"
python3 - "$WORK/tsukuyomi.spec" "$WORK/PKGBUILD" "$WORK/debian-control" \
	"$VERSION" "$RELEASE" "$NODE_VERSION" "$PI_VERSION" "$INSTALLED_SIZE" <<'PY'
import pathlib, sys
values = {'@VERSION@': sys.argv[4], '@RELEASE@': sys.argv[5], '@NODE_VERSION@': sys.argv[6], '@PI_VERSION@': sys.argv[7], '@INSTALLED_SIZE@': sys.argv[8]}
for name in sys.argv[1:4]:
    path = pathlib.Path(name); text = path.read_text()
    for old, new in values.items(): text = text.replace(old, new)
    if '@' in ''.join(part for part in text.splitlines() if part.startswith(('Version:', 'Installed-Size:', 'pkgver=', 'pkgrel=', 'pkgdesc='))):
        raise SystemExit(f'Unresolved package placeholder in {path}')
    path.write_text(text)
PY
SUM="$(sha256sum "$WORK/tsukuyomi-bundle.tar.gz" | cut -d' ' -f1)"
python3 - "$WORK/PKGBUILD" "$SUM" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); p.write_text(p.read_text().replace("sha256sums=('SKIP')", f"sha256sums=('{sys.argv[2]}')"))
PY

# Debian packages are standard ar archives and need no dpkg tooling to create.
DEB_ARCHIVE="$WORK/deb-archive"; DEB_CONTROL="$WORK/deb-control"
mkdir -p "$DEB_ARCHIVE" "$DEB_CONTROL"
cp "$WORK/debian-control" "$DEB_CONTROL/control"
install -m755 "$ROOT/packaging/bundle/postinst" "$DEB_CONTROL/postinst"
(cd "$WORK/stage" && find usr -type f -print0 | sort -z | xargs -0 md5sum) > "$DEB_CONTROL/md5sums"
printf '2.0\n' > "$DEB_ARCHIVE/debian-binary"
tar --sort=name --owner=0 --group=0 --numeric-owner -cJf "$DEB_ARCHIVE/control.tar.xz" -C "$DEB_CONTROL" .
tar --sort=name --owner=0 --group=0 --numeric-owner -cJf "$DEB_ARCHIVE/data.tar.xz" -C "$WORK/stage" .
DEB_FILE="$OUT/tsukuyomi_${VERSION}-${RELEASE}_amd64.deb"; rm -f "$DEB_FILE"
(cd "$DEB_ARCHIVE" && ar crD "$DEB_FILE" debian-binary control.tar.xz data.tar.xz)

if [[ "$DIRECT_BUILD" == 1 ]]; then
	(
		mkdir -p "$WORK/rpm"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
		cp "$WORK/tsukuyomi-bundle.tar.gz" "$WORK/rpm/SOURCES/"
		RPM_ROOT="${RPM_CONFIGDIR:-/usr/lib/rpm}"
		RPM_CONFIGDIR="$RPM_ROOT" rpmbuild \
			--rcfile="$RPM_ROOT/rpmrc" \
			--macros="$RPM_ROOT/macros" \
			--dbpath="$WORK/rpm/db" \
			-bb \
			--define "_rpmconfigdir $RPM_ROOT" \
			--define "_topdir $WORK/rpm" \
			--define "__os_install_post %{nil}" \
			--define "_binary_payload w6.zstdio" "$WORK/tsukuyomi.spec"
		mkdir -p "$WORK/arch"
		cp "$WORK/PKGBUILD" "$WORK/tsukuyomi.install" "$WORK/tsukuyomi-bundle.tar.gz" "$WORK/arch/"
		if [[ -n "${TSUKUYOMI_FAKED:-}" ]]; then
			fakeroot() {
				"${TSUKUYOMI_FAKEROOT_COMMAND:-fakeroot}" \
					--lib "${TSUKUYOMI_FAKEROOT_LIB:?TSUKUYOMI_FAKEROOT_LIB is required with TSUKUYOMI_FAKED}" \
					--faked "$TSUKUYOMI_FAKED" "$@"
			}
			export -f fakeroot
		fi
		(cd "$WORK/arch" && PKGEXT=.pkg.tar.zst MAKEPKG_LIBRARY="${MAKEPKG_LIBRARY:-/usr/share/makepkg}" makepkg --nodeps --force --config "${MAKEPKG_CONF:-/etc/makepkg.conf}")
	) > "$OUT/build.log" 2>&1
else
	podman run --rm -v "$WORK:/build:Z" "$IMAGE" bash -euxc '
		mkdir -p /build/rpm/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
		cp /build/tsukuyomi-bundle.tar.gz /build/rpm/SOURCES/
		rpmbuild -bb --define "_topdir /build/rpm" --define "_binary_payload w6.zstdio" /build/tsukuyomi.spec
		useradd -m builder
		mkdir -p /build/arch
		cp /build/PKGBUILD /build/tsukuyomi.install /build/tsukuyomi-bundle.tar.gz /build/arch/
		chown -R builder:builder /build/arch
		sed -i "s/^PKGEXT=.*/PKGEXT=.pkg.tar.zst/" /etc/makepkg.conf
		su builder -c "cd /build/arch && makepkg --nodeps --force"
	' > "$OUT/build.log" 2>&1
fi

RPM_FILE="$(find "$WORK/rpm/RPMS/x86_64" -maxdepth 1 -name "tsukuyomi-${VERSION}-${RELEASE}*.rpm" -print -quit)"
ARCH_FILE="$(find "$WORK/arch" -maxdepth 1 -name "tsukuyomi-${VERSION}-${RELEASE}-x86_64.pkg.tar.zst" -print -quit)"
[[ -n "$RPM_FILE" && -n "$ARCH_FILE" ]] || { echo 'RPM or Arch package was not produced.' >&2; exit 1; }
cp "$RPM_FILE" "$ARCH_FILE" "$OUT/"
cp "$WORK/tsukuyomi-bundle.tar.gz" "$OUT/"
cp "$WORK/PKGBUILD" "$WORK/tsukuyomi.spec" "$WORK/debian-control" "$OUT/"
RPM_OUT="$OUT/$(basename "$RPM_FILE")"; ARCH_OUT="$OUT/$(basename "$ARCH_FILE")"
(cd "$OUT" && sha256sum "$(basename "$ARCH_OUT")" "$(basename "$RPM_OUT")" "$(basename "$DEB_FILE")" > SHA256SUMS)
printf 'Packages written to %s\n' "$OUT"
