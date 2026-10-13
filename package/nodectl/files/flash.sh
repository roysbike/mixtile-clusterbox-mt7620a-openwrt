#!/bin/sh
# Stream an OS image onto a Blade3 node disk over SSH (pci0 link).
# Invoked by "nodectl flash"; parameters arrive in the environment:
#   NODE NODE_IP NODE_USER [SSHPASS] SOURCE TARGET
# Decompression runs on the node: the RK3588 is far faster than the MT7620.

set -u
set -o pipefail 2>/dev/null

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { log "ERROR: $*"; exit 1; }

SSH_KEY=/root/.ssh/id_dropbear

ssh_node() {
	set -- -y -y ${SSH_KEY:+-i "$SSH_KEY"} "$NODE_USER@$NODE_IP" "$@"
	if [ -n "${SSHPASS:-}" ]; then
		sshpass -e dbclient "$@"
	else
		dbclient "$@"
	fi
}
[ -r "$SSH_KEY" ] || SSH_KEY=

case "$TARGET" in
	/dev/*) ;;
	*) fail "target must be a /dev path: $TARGET" ;;
esac
case "$TARGET" in
	*[!A-Za-z0-9/_.-]*) fail "invalid characters in target: $TARGET" ;;
esac

case "$SOURCE" in
	*.gz)              DECOMP="gzip -dc" ;;
	*.xz)              DECOMP="xz -dc" ;;
	*.zst)             DECOMP="zstd -dc" ;;
	*.img|*.raw|*.bin) DECOMP="cat" ;;
	*) fail "unknown image type: $SOURCE (expected .img, .raw, .bin, .gz, .xz or .zst)" ;;
esac

case "$SOURCE" in
	https://*|http://*)
		read_source() { uclient-fetch -q -O - "$SOURCE"; }
		;;
	/*)
		[ -r "$SOURCE" ] || fail "cannot read $SOURCE"
		read_source() { cat "$SOURCE"; }
		;;
	*) fail "source must be an absolute path or an http(s) URL" ;;
esac

log "node $NODE ($NODE_USER@$NODE_IP): checking prerequisites"
ssh_node "test -b $TARGET && command -v ${DECOMP%% *} >/dev/null && command -v dd >/dev/null" \
	|| fail "node unreachable over SSH, $TARGET is not a block device, or '${DECOMP%% *}' is missing on the node"
ssh_node "uname -srm; cat /sys/class/block/${TARGET#/dev/}/size 2>/dev/null | awk '{printf \"target size: %.1f GiB\\n\", \$1*512/1073741824}'"

# The root filesystem is remounted read-only before the disk is overwritten so
# nothing on the node writes to it concurrently; the node is power cycled after.
REMOTE="set -e
echo 1 > /proc/sys/kernel/sysrq
sync
echo s > /proc/sysrq-trigger
echo u > /proc/sysrq-trigger
sleep 2
P=
dd --version >/dev/null 2>&1 && P=status=progress
$DECOMP | dd of=$TARGET bs=4M conv=fsync \$P
sync"

log "writing $SOURCE -> $TARGET"
start=$(date +%s)
src_st=/tmp/nodectl-flash-src.$$
rm -f "$src_st"
( read_source; echo $? > "$src_st" ) | ssh_node "$REMOTE" \
	|| fail "write failed after $(( $(date +%s) - start )) s; the node disk is likely incomplete, re-run flash"
src_rc=$(cat "$src_st" 2>/dev/null || echo 1)
rm -f "$src_st"
[ "$src_rc" = 0 ] || fail "source read failed (rc $src_rc); the node disk is likely incomplete, re-run flash"
log "done in $(( $(date +%s) - start )) s"
