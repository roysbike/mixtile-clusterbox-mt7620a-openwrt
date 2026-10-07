#!/bin/bash
# collect-release.sh OUTDIR [EXTRASDIR]
# After "./build.sh firmware": gather what a release publishes into OUTDIR
# — the SD-card sysupgrade image, clusterbox-firmware.json (read by
# mixtile-update), the mixtile-update script (first install),
# BUILD-INFO.txt and SHA256SUMS — and the build leftovers (packages,
# manifest, buildinfo) into EXTRASDIR (CI artifact only, not released).
set -euo pipefail

out=${1:?outdir}
extras=${2:-$out-extras}
top=$(cd "$(dirname "$0")/../.." && pwd)
tdir=$top/bin/targets/ramips/mt7620
pdir=$top/bin/packages/mipsel_24kc/base
src=$tdir/openwrt-ramips-mt7620-cluster-box-control-V120-squashfs-sysupgrade-sd.bin
[ -s "$src" ] || { echo "missing $src" >&2; exit 1; }

# Identity of what was built, from the image's own /etc/mixtile-release.
rel=$(mktemp -d)
trap 'rm -rf "$rel"' EXIT
dd if="$src" of="$rel/rootfs.sqsh" bs=1M skip=10 status=none
unsquashfs -q -n -d "$rel/root" "$rel/rootfs.sqsh" etc/mixtile-release >/dev/null
# shellcheck disable=SC1091
. "$rel/root/etc/mixtile-release"

mkdir -p "$out" "$extras"
# openmiop-<version>-<platform>-<os>-<arch>-<kind>.bin, like the other
# OpenMIOP Stack releases.
owrt=${OPENWRT_VERSION%%-*}
image=openmiop-${FIRMWARE_VERSION#v}-clusterbox-bmc-openwrt-${owrt}-mipsel-sysupgrade.bin
cp "$src" "$out/$image"
# The update backend, for a first install from firmware that lacks it.
install -m 0755 "$top/package/mixtile-update/files/mixtile-update" "$out/mixtile-update"

for p in openmiop mixtile-release mixtile-update luci-app-mixtile-update nodectl luci-app-nodectl; do
	f=$(ls "$pdir"/${p}_*.ipk 2>/dev/null | head -n1)
	[ -n "$f" ] || { echo "missing package $p" >&2; exit 1; }
	cp "$f" "$extras/"
done
cp "$tdir"/*.manifest "$extras/firmware.manifest"
for f in config.buildinfo feeds.buildinfo version.buildinfo; do
	[ -f "$tdir/$f" ] && cp "$tdir/$f" "$extras/"
done

sha=$(sha256sum "$out/$image" | cut -d' ' -f1)
size=$(stat -c %s "$out/$image")
cat > "$out/clusterbox-firmware.json" <<EOJ
{
	"name": "$FIRMWARE_NAME",
	"version": "$FIRMWARE_VERSION",
	"commit": "$GIT_COMMIT",
	"build_date": "$BUILD_DATE",
	"board": "$BOARD",
	"target": "$TARGET",
	"openwrt_version": "$OPENWRT_VERSION",
	"kernel_version": "$KERNEL_VERSION",
	"openmiop_protocol": "$OPENMIOP_PROTOCOL",
	"openmiop_version": "$OPENMIOP_VERSION",
	"image": "$image",
	"size": $size,
	"sha256": "$sha"
}
EOJ

{
	echo "repository: $REPOSITORY"
	echo "firmware-version: $FIRMWARE_VERSION"
	echo "commit: $GIT_COMMIT"
	echo "build-date: $BUILD_DATE"
	echo "ci-run: ${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-local}"
	echo "board: $BOARD"
	echo "target: $TARGET"
	echo "openwrt: $OPENWRT_VERSION"
	echo "kernel: $KERNEL_VERSION"
	echo "openmiop: $OPENMIOP_VERSION ($OPENMIOP_SOURCE)"
	echo "openmiop-protocol: $OPENMIOP_PROTOCOL"
	echo "image: $image"
	echo "feeds:"
	sed 's/^/  /' "$tdir/feeds.buildinfo" 2>/dev/null || true
} > "$out/BUILD-INFO.txt"

(cd "$out" && sha256sum -- "$image" clusterbox-firmware.json mixtile-update BUILD-INFO.txt > SHA256SUMS)
(cd "$extras" && sha256sum -- * > SHA256SUMS)
cat "$out/BUILD-INFO.txt" "$out/SHA256SUMS"
ls -la "$out" "$extras"
