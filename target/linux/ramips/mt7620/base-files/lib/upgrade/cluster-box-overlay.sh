# Cluster Box: the overlay is the ext4 extroot on mmcblk0p3, which the
# upgrade (kernel and rootfs at the start of the eMMC) does not touch, so
# without this every file of an older firmware left in the overlay would
# shadow the new one, and whiteouts would hide new files (uci-defaults
# scripts of the same name never run again).
#
# Before the image is written (stage 2, services stopped), remove from the
# overlay what shadows or hides a firmware file, unless it is kept:
# what "sysupgrade -l" lists (conffiles, /etc/sysupgrade.conf,
# /lib/upgrade/keep.d) and the paths in /etc/mixtile-update/keep (a
# trailing / keeps a whole directory). The firmware files are looked up in
# the running /rom: a file the new firmware adds is not in the overlay,
# one it drops is harmless there. Files no firmware ships (packages and
# tools installed later) are kept. uci-defaults scripts run again after
# the upgrade, as on every other OpenWrt device.
#
# cluster_box_prune_overlay [preview]
# CB_UPPER, CB_ROM, CB_KEEP (a ready keep list): for tests.
CB_DEFAULT_KEEP="/etc/mixtile-update/ /etc/rc.d/ /root/.ssh/ /home/ /opt/"
CB_ALWAYS_KEEP="/etc/config/ /etc/passwd /etc/shadow /etc/group /etc/dropbear/"

cluster_box_prune_overlay() {
	local upper=${CB_UPPER:-/overlay/upper} rom=${CB_ROM:-/rom}
	local keep=/tmp/cb-keep.list extra=/tmp/cb-keep.extra rm=/tmp/cb-prune.list f n=0

	[ -d "$upper" ] || return 0
	if [ -n "$CB_KEEP" ]; then
		cp "$CB_KEEP" "$keep"
	else
		sysupgrade -l > "$keep" 2>/dev/null
	fi
	[ -s "$keep" ] || {
		echo "overlay: no list of kept files, not pruned"
		return 0
	}
	{
		# The configuration in any case, whatever the package database says.
		echo "$CB_ALWAYS_KEEP" | tr ' ' '\n'
		if [ -f /etc/mixtile-update/keep ]; then
			grep '^/' /etc/mixtile-update/keep
		else
			echo "$CB_DEFAULT_KEEP" | tr ' ' '\n'
		fi
	} > "$extra"

	( cd "$upper" && find . \( -type f -o -type l -o -type c \) ) | sed 's|^\.||' |
	awk -v keep="$keep" -v extra="$extra" '
		BEGIN {
			while ((getline l < keep) > 0) k[l] = 1
			while ((getline l < extra) > 0) {
				sub(/[ \t]+$/, "", l)
				if (l ~ /\/$/) p[++np] = l; else k[l] = 1
			}
		}
		{
			if ($0 in k) next
			for (i = 1; i <= np; i++) if (index($0, p[i]) == 1) next
			print
		}' |
	while read -r f; do
		[ -e "$rom$f" ] || [ -L "$rom$f" ] && echo "$f"
	done > "$rm"

	if [ "$1" = preview ]; then
		cat "$rm"
		return 0
	fi
	while read -r f; do
		rm -f "$upper$f" && n=$((n + 1))
	done < "$rm"
	find "$upper" -depth -mindepth 1 -type d -empty -exec rmdir {} \; 2>/dev/null
	echo "overlay: $n files of the old firmware removed"
	sync
}
