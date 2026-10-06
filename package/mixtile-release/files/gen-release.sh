#!/bin/sh
# gen-release.sh TOPDIR OPENMIOP_BUILD_INFO OPENWRT_VERSION KERNEL_VERSION BOARD TARGET
# Writes /etc/mixtile-release to stdout. Firmware version, commit, date
# and repository come from CI (MIXTILE_* variables, set from the tag and
# commit being built) or, for local builds, from git.
set -e
top=$1 omi=$2
git_() { git -c safe.directory='*' -C "$top" "$@" 2>/dev/null; }

version=${MIXTILE_FW_VERSION:-$(git_ describe --tags --match 'v[0-9]*' --always --dirty)}
commit=${MIXTILE_GIT_COMMIT:-$(git_ rev-parse HEAD)}
date=${MIXTILE_BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
repo=${MIXTILE_REPOSITORY:-$(git_ remote get-url origin | sed 's|^git@github.com:|https://github.com/|; s|\.git$||')}
[ -n "$version" ] && [ -n "$commit" ] || { echo "cannot determine firmware version/commit" >&2; exit 1; }
[ -s "$omi" ] || { echo "missing $omi (openmiop build info)" >&2; exit 1; }
. "$omi"
# Final releases (vX.Y.Z) follow the stable channel, everything else
# (release candidates, untagged builds) the rc channel.
if echo "$version" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
	channel=stable
else
	channel=rc
fi

cat <<EOT
FIRMWARE_NAME="Mixtile ClusterBox"
FIRMWARE_VERSION="$version"
GIT_COMMIT="$commit"
GIT_COMMIT_SHORT="$(echo "$commit" | cut -c1-7)"
BUILD_DATE="$date"
OPENMIOP_PROTOCOL="$OPENMIOP_PROTOCOL"
OPENMIOP_VERSION="$(echo "$OPENMIOP_VERSION" | tr "~" -)"
OPENMIOP_SOURCE="$OPENMIOP_SOURCE"
REPOSITORY="$repo"
OPENWRT_VERSION="$3"
KERNEL_VERSION="$4"
BOARD="$5"
TARGET="$6"
UPDATE_CHANNEL="$channel"
EOT
