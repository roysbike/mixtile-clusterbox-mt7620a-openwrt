#!/bin/sh
# build-info.sh OPENMIOP_H VERSION COMMIT: facts about the openmiop
# build for mixtile-release, taken from the source that was compiled.
set -e
proto=$(sed -n 's/^#define OPENMIOP_VERSION[[:space:]]*\([0-9][0-9]*\)u.*/\1/p' "$1")
[ -n "$proto" ] || { echo "no OPENMIOP_VERSION in $1" >&2; exit 1; }
echo "OPENMIOP_PROTOCOL=$proto"
echo "OPENMIOP_VERSION=$2"
echo "OPENMIOP_SOURCE=https://github.com/roysbike/pcie-ep-net/commit/$3"
