#!/bin/bash
# verify-firmware.sh RELEASE_DIR [EXPECTED_VERSION] [EXPECTED_COMMIT]
# Unpacks the rootfs of the collected sysupgrade image and checks that the
# ClusterBox pieces are really inside it: firmware identity, openmiop
# helper (MIPS, static) and its autostart, kmod-tun for this kernel,
# nodectl and its LuCI UI, the update backend and its LuCI page, the
# LuCI version display, and that the update source is this repository.
set -euo pipefail

dir=${1:?release dir}
want_version=${2:-}
want_commit=${3:-}
# die: a prerequisite is missing; fail: record and keep checking.
die() { echo "FAIL: $*" >&2; exit 1; }
failed=0
fail() { echo "FAIL: $*" >&2; failed=1; }
ok() { echo "ok: $*"; }

json=$dir/clusterbox-firmware.json
[ -s "$json" ] || die "missing $json"
image=$dir/$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image"])' "$json")
[ -s "$image" ] || die "missing $image"
(cd "$dir" && sha256sum -c --quiet SHA256SUMS) || die "SHA256SUMS"
ok "SHA256SUMS"
[ "$(sha256sum "$image" | cut -d' ' -f1)" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$json")" ] ||
	fail "clusterbox-firmware.json sha256 does not match the image"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The SD-card image is the kernel (uImage) padded to 10 MiB, then the
# squashfs rootfs, then the OpenWrt metadata trailer.
head -c 4 "$image" | od -An -tx1 | grep -q '27 05 19 56' || die "no uImage at offset 0"
dd if="$image" of="$work/rootfs.sqsh" bs=1M skip=10 status=none
[ "$(head -c 4 "$work/rootfs.sqsh")" = hsqs ] || die "no squashfs at 10 MiB"
unsquashfs -q -n -d "$work/root" "$work/rootfs.sqsh" >/dev/null 2>&1 || true
r=$work/root
[ -d "$r/etc" ] || die "could not unpack the rootfs"
ok "rootfs unpacked ($(du -sh "$work/rootfs.sqsh" | cut -f1) squashfs)"

# fwtool is an OpenWrt host tool (staging_dir/host/bin after a build).
command -v fwtool >/dev/null || die "fwtool not in PATH"
fwtool -q -i "$work/meta.json" "$image" || fail "image has no OpenWrt metadata"
python3 - "$work/meta.json" <<'EOF' || fail "image metadata does not list cluster-box-control-V120"
import json, sys
sys.exit(0 if "cluster-box-control-V120" in json.load(open(sys.argv[1])).get("supported_devices", []) else 1)
EOF
ok "OpenWrt metadata lists cluster-box-control-V120 (sysupgrade -T accepts it on this board)"

# Identity
[ -s "$r/etc/mixtile-release" ] || die "/etc/mixtile-release missing"
# shellcheck disable=SC1091
. "$r/etc/mixtile-release"
for k in FIRMWARE_VERSION GIT_COMMIT BUILD_DATE OPENMIOP_PROTOCOL REPOSITORY OPENWRT_VERSION KERNEL_VERSION BOARD TARGET UPDATE_CHANNEL; do
	[ -n "${!k:-}" ] || fail "/etc/mixtile-release: $k empty"
done
[ -z "$want_version" ] || [ "$FIRMWARE_VERSION" = "$want_version" ] || fail "FIRMWARE_VERSION $FIRMWARE_VERSION != $want_version"
[ -z "$want_commit" ] || [ "$GIT_COMMIT" = "$want_commit" ] || fail "GIT_COMMIT $GIT_COMMIT != $want_commit"
[ "$BOARD" = cluster-box-control-V120 ] || fail "BOARD $BOARD"
[ "$TARGET" = ramips/mt7620 ] || fail "TARGET $TARGET"
grep -q "DISTRIB_TARGET='$TARGET'" "$r/etc/openwrt_release" || fail "TARGET differs from /etc/openwrt_release"
[ -d "$r/lib/modules/$KERNEL_VERSION" ] || fail "no /lib/modules/$KERNEL_VERSION"
ok "/etc/mixtile-release: $FIRMWARE_VERSION $GIT_COMMIT, OpenMIOP v$OPENMIOP_PROTOCOL, OpenWrt $OPENWRT_VERSION, kernel $KERNEL_VERSION, channel $UPDATE_CHANNEL"
python3 - "$json" "$FIRMWARE_VERSION" "$GIT_COMMIT" "$OPENMIOP_PROTOCOL" <<'EOF' || fail "clusterbox-firmware.json disagrees with /etc/mixtile-release"
import json, sys
j = json.load(open(sys.argv[1]))
sys.exit(0 if (j["version"], j["commit"], j["openmiop_protocol"]) == tuple(sys.argv[2:5]) else 1)
EOF
ok "clusterbox-firmware.json matches"

# openmiop helper
for f in usr/bin/openmiop-rc usr/bin/omi-peek etc/init.d/openmiop; do
	[ -x "$r/$f" ] || fail "/$f missing or not executable"
done
file -b "$r/usr/bin/openmiop-rc" | grep -q 'ELF 32-bit LSB executable, MIPS, MIPS32 rel2.*statically linked' ||
	fail "openmiop-rc is $(file -b "$r/usr/bin/openmiop-rc")"
readelf -A "$r/usr/bin/openmiop-rc" | grep -q 'FP ABI: Soft float' || fail "openmiop-rc is not soft-float"
ls "$r"/etc/rc.d/S*openmiop >/dev/null 2>&1 || fail "openmiop is not enabled at boot"
grep -q '10.20.0.1/24' "$r/etc/init.d/openmiop" || fail "openmiop init does not set 10.20.0.1/24"
ok "openmiop-rc ($(file -b "$r/usr/bin/openmiop-rc" | cut -d, -f1-3)), omi-peek, init enabled"

tun=$(find "$r/lib/modules/$KERNEL_VERSION" -name tun.ko | head -n1)
[ -n "$tun" ] || fail "tun.ko missing"
strings "$tun" | grep -q "^vermagic=$KERNEL_VERSION " || fail "tun.ko vermagic $(strings "$tun" | grep '^vermagic=')"
file -b "$tun" | grep -q 'MIPS' || fail "tun.ko is not MIPS"
grep -rqs '^tun' "$r/etc/modules.d/" || fail "tun not autoloaded"
[ -z "$(find "$r" -name 'openmiop-ep.ko')" ] || fail "the blade (arm64) module must not be in the image"
# Every kernel module in the image must be MIPS and built for this kernel
# (kmods from this build, plus Mixtile's vendor miop.ko from upstream
# custom-files, which openmiop does not use).
for ko in $(find "$r/lib/modules" -name '*.ko'); do
	file -b "$ko" | grep -q 'MIPS' || fail "${ko#$r} is not MIPS"
	strings "$ko" | grep -q "^vermagic=$KERNEL_VERSION " || fail "${ko#$r}: $(strings "$ko" | grep '^vermagic=')"
done
ok "kmod-tun and all $(find "$r/lib/modules" -name '*.ko' | wc -l) modules: MIPS, vermagic $KERNEL_VERSION; no blade (arm64) module"

# nodectl
for f in bin/nodectl usr/libexec/rpcd/nodectl www/luci-static/resources/view/nodectl/nodes.js \
	www/luci-static/resources/view/nodectl/flash.js usr/share/luci/menu.d/luci-app-nodectl.json etc/config/nodectl; do
	[ -e "$r/$f" ] || fail "/$f missing"
done
file -b "$r/bin/nodectl" | grep -q MIPS || fail "nodectl is not MIPS"
ok "nodectl + luci-app-nodectl"

# updates
for f in usr/libexec/mixtile-update etc/init.d/mixtile-update; do
	[ -x "$r/$f" ] || fail "/$f missing"
done
for f in etc/config/mixtile-update etc/mixtile-update/keep www/luci-static/resources/view/mixtile/update.js \
	www/luci-static/resources/view/status/include/05_mixtile.js \
	usr/share/luci/menu.d/luci-app-mixtile-update.json usr/share/rpcd/acl.d/luci-app-mixtile-update.json; do
	[ -s "$r/$f" ] || fail "/$f missing"
done
[ -e "$r/usr/sbin/ota-update" ] && fail "old ota-update still present"
[ "$REPOSITORY" = "https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt" ] ||
	fail "update source would be $REPOSITORY"
grep -q "option repository ''" "$r/etc/config/mixtile-update" || fail "mixtile-update config overrides the repository"
grep -q 'api.github.com' "$r/etc/config/mixtile-update" || fail "mixtile-update api"
ok "mixtile-update backend, LuCI Firmware Update page, source $REPOSITORY/releases, channel $UPDATE_CHANNEL"

# LuCI version display
grep -q '/etc/mixtile-release' "$r/usr/share/ucode/luci/dispatcher.uc" || fail "dispatcher does not read /etc/mixtile-release"
grep -q 'version.mixtile' "$r/usr/share/ucode/luci/template/sysauth.ut" || fail "login page lacks the version"
grep -q 'version.mixtile' "$r/usr/share/ucode/luci/template/themes/openwrt2020/footer.ut" || fail "footer lacks the version"
grep -q 'version.mixtile' "$r/usr/share/ucode/luci/template/themes/bootstrap/sysauth.ut" || fail "bootstrap login lacks the version"
ok "LuCI login page, footer and overview read /etc/mixtile-release"

[ "$failed" = 0 ] || die "firmware verification failed"
echo "firmware verified: $(basename "$image")"
