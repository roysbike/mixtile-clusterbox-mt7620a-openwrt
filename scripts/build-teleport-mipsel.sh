#!/bin/sh
# Cross-build the Teleport agent binary for the ClusterBox (MT7620A, MIPS 24KEc,
# no FPU, musl): GOARCH=mipsle GOMIPS=softfloat, CGO with a static musl toolchain.
#
#   CC=mipsel-linux-muslsf-gcc scripts/build-teleport-mipsel.sh 18.11.1 out/
#
# Output: out/teleport-<version>-linux-mipsel.gz and its .sha256.
set -eu

VERSION=${1:?usage: $0 VERSION [OUTDIR]}
VERSION=${VERSION#v}
OUT=$(mkdir -p "${2:-.}" && cd "${2:-.}" && pwd)
WORK=${WORK:-$(mktemp -d)}
CC=${CC:-mipsel-linux-muslsf-gcc}
CXX=${CXX:-mipsel-linux-muslsf-g++}
READELF=${READELF:-${CC%gcc}readelf}
STRIP=${STRIP:-${CC%gcc}strip}

src="$WORK/teleport"
[ -d "$src" ] || git clone -q --depth 1 --branch "v$VERSION" \
	https://github.com/gravitational/teleport.git "$src"
cd "$src"

# Use exactly the Go release Teleport pins: some dependencies (strcase) panic
# at start-up when built with a Go whose Unicode tables are newer.
gover=$(awk '$1 == "toolchain" { sub(/^go/, "", $2); print $2 }' go.mod)
[ -n "$gover" ] || gover=$(awk '$1 == "go" { print $2 }' go.mod)
export GOOS=linux GOARCH=mipsle GOMIPS=softfloat CGO_ENABLED=1 CC CXX
export GOFLAGS=-mod=mod GOTOOLCHAIN=${GOTOOLCHAIN:-go$gover}
go version

# pkcs11 (HSM support of the auth service) declares a 2 GiB array type, which
# does not fit the 32-bit MIPS address space.
go mod download github.com/miekg/pkcs11
pk=$(go list -m -f '{{.Dir}}' github.com/miekg/pkcs11)
rm -rf "$WORK/pkcs11" && cp -R "$pk" "$WORK/pkcs11" && chmod -R u+w "$WORK/pkcs11"
sed -i.orig 's/(1 << 31) - 1/(1 << 30) - 1/' "$WORK/pkcs11/types.go"
go mod edit -replace "github.com/miekg/pkcs11=$WORK/pkcs11"

# gnu_get_libc_version() only exists in glibc; it is used for inventory metadata.
f=lib/inventory/metadata/metadata_linux.go
if grep -q 'gnu/libc-version.h' "$f"; then
	sed -i.orig -e '/#include <gnu\/libc-version.h>/d' -e '/^import "C"$/d' \
		-e 's/return C.GoString(C.gnu_get_libc_version())/return ""/' "$f"
fi

go build -trimpath -o "$WORK/teleport.bin" \
	-ldflags "-s -w -linkmode external -extldflags -static \
		-X github.com/gravitational/teleport.Gitref=v$VERSION-mipsel" \
	./tool/teleport
"$STRIP" "$WORK/teleport.bin"

# MIPS jal/j only reach targets inside the same 256 MiB region: all code must
# sit below 0x10000000, otherwise calls across the boundary jump to garbage.
"$READELF" -S -W "$WORK/teleport.bin" | sed -n 's/^ *\[ *[0-9]*\] //p' |
while read -r name _ addr _ size _ flags _; do
	case "$flags" in *X*) ;; *) continue ;; esac
	start=$((0x$addr)) end=$((0x$addr + 0x$size))
	printf '%s: %#x-%#x\n' "$name" "$start" "$end"
	: "${region:=$((start >> 28))}"
	if [ $((start >> 28)) -ne "$region" ] || [ $(((end - 1) >> 28)) -ne "$region" ]; then
		echo "$name is outside the 256 MiB region of the other code" >&2
		exit 1
	fi
done

name="teleport-$VERSION-linux-mipsel"
gzip -9 -c "$WORK/teleport.bin" > "$OUT/$name.gz"
(cd "$OUT" && sha256sum "$name.gz" > "$name.gz.sha256")
ls -la "$OUT/$name.gz"
