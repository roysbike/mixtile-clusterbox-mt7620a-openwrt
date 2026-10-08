# Changelog

ClusterBox BMC firmware (OpenWrt 23.05 on the Mixtile Cluster Box MT7620A).
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- PCIe fabric outages after a blade reset or power cut: `nodectl reset`
  and `nodectl poweroff` (also `reboot --hard`) first ask openmiop-rc to
  release the blade (`/var/run/openmiop-release.<switch port>`) and wait
  up to 1 s for it. A BAR read in flight when a blade's link drops
  without warning stops the MT7620A root complex until the Cluster Box
  reboots.
- openmiop-rc (pcie-ep-net `claude/fabric-resilience`): no request to a
  blade whose link is not up and stable, judged by Data Link Layer Link
  Active of its switch port; after a leave or a release, the blade is
  probed only once its link dropped and came back. Log lines carry a
  timestamp; link loss dumps link and AER status of the root and switch
  ports.

### Changed

- Releases are about the firmware: the Teleport agent no longer gets its
  own release (built from "latest" Teleport, it showed up as the
  repository's latest release). Each firmware tag builds the agent at
  the version in `scripts/teleport-version` (18.10.0) next to the
  firmware and attaches `teleport-<version>-linux-mipsel.gz` (+ `.sha256`)
  to the firmware release. LuCI *Services → Teleport* finds agents in
  any release by file name, old and new.
- Release notes follow `release-notes/TEMPLATE.md`: what's new, what is
  inside (component versions), download, update, known issues, tests.
- CI: the firmware identity (`/etc/mixtile-release`) is rebuilt on every
  self-hosted build; pull requests build for `v120` only (`main` is gone).
- Teleport: the default `clusterbox` web app uses URI `luci`, which follows
  the HTTP port of uhttpd (`uhttpd.main.listen_http`), so LuCI moved to
  e.g. 8080 is still published. The agent reloads when uhttpd changes.

## [0.1.0-rc.3] - 2026-10-07

BMC firmware only; the OpenMIOP helper is the same as in rc.2
(pcie-ep-net v0.1.0-rc.2, protocol v4). It also works with blades on
pcie-ep-net v0.2 development builds.

### Added

- PCIe link speed and width per blade: `nodectl status` has a LINK column
  (e.g. `Gen3 x2`, or `Gen3 x1/x2!` when a link trained below what both
  ends support) and the JSON status `link_gen`, `link_width`,
  `link_max_gen`, `link_max_width`; LuCI *Cluster* shows it as a green or
  orange badge next to the PCIe state.

### Changed

- LuCI *Cluster*: no "Temp: no sensor" line; Temp appears only when the
  host or the chassis reports a temperature.

### Fixed

- `mixtile-update install` pruned nothing from the overlay (the file list
  went to the wrong command), so after an update old hand-copied files
  kept shadowing the new firmware (seen after rc.1 -> rc.2 on the lab
  BMC). It now removes exactly the overlay files that shadow (or, as
  whiteouts, hide) a firmware file, never `/etc/uci-defaults` whiteouts,
  and leaves files the firmware does not ship (tools and packages
  installed later, e.g. the Teleport agent).

### Known limitations

- An update runs the *installed* `mixtile-update`; rc.2 has the prune bug,
  so from rc.2 copy rc.3's `mixtile-update` to the BMC first (see the
  release notes) or check `mixtile-update prune-preview` after updating.
- A BMC reboot (any update) drops the PCIe fabric for all blades for a few
  minutes; see the release notes.

## [0.1.0-rc.2] - 2026-10-07

Part of OpenMIOP Stack v0.1.0-rc.2 (protocol v4, with pcie-ep-net and
mixtile-talos v0.1.0-rc.2).

### Changed

- Release assets follow the OpenMIOP Stack naming:
  `openmiop-<version>-clusterbox-bmc-openwrt-23.05-mipsel-sysupgrade.bin`,
  plus `clusterbox-firmware.json`, `mixtile-update`, `BUILD-INFO.txt` and
  `SHA256SUMS` only. Packages, the package manifest and buildinfo files are
  CI artifacts, no longer release assets (GitHub also renamed the `~` in
  the `openmiop` package file name, which broke `sha256sum -c`).
- `openmiop` package built from pcie-ep-net `0817d7c` (tag v0.1.0-rc.2);
  the BMC helper source did not change since rc.1.

### Tested

- v0.1.0-rc.1 on the lab BMC (installed through LuCI *Flash Firmware*):
  boots, `/etc/mixtile-release` names the tag and commit, the LuCI login
  page shows `Firmware v0.1.0-rc.1 · commit a328c07 · OpenMIOP v4`,
  `mixtile-update status` works, the OpenMIOP fabric runs with four Talos
  blades; NAT for the blades (10.20.0.0/24 → WAN) and DNAT to the cluster
  (6443, 80, 443) configured on top of it.
- Release check, download and `verify-local` of a release, and rejection
  of a corrupted image, on that BMC.

### Known limitations

- Flashing through LuCI does not clean the overlay: files copied by hand
  on older firmware keep shadowing the new ones (seen on the lab BMC:
  `/usr/bin/openmiop-rc`, `/etc/init.d/openmiop`). `mixtile-update
  install`/`install-local` remove them.
- `mixtile-update install` and the microSD recovery are still not
  hardware-tested (rc.1 → rc.2 is the first OTA update).
- No HTTPS in LuCI yet (no `px5g`); planned.
- `uclient-fetch` uses mbedTLS 2.28 (TLS 1.2): it cannot talk to the
  Talos and Kubernetes APIs, which require TLS 1.3.

## [0.1.0-rc.1] - 2026-10-06

First release candidate of this firmware as part of OpenMIOP Stack
v0.1.0-rc.1 (protocol v4), with pcie-ep-net v0.1.0-rc.1 and mixtile-talos
v0.1.0-rc.1.

### Added

- **OpenMIOP BMC integration** (`openmiop` package): `openmiop-rc` and
  `omi-peek` built from pcie-ep-net `922389d` (tag v0.1.0-rc.1) with the
  OpenWrt toolchain (freestanding MIPS32 soft-float, as upstream builds
  it), `/etc/init.d/openmiop` enabled at boot, `omi0` = 10.20.0.1/24, MTU
  9000. The helper:
  - finds the Blade 3 endpoints (`1d87:4f4d`) behind the ASM2824 switch
    and numbers them by switch slot;
  - restores BAR0, Memory Space + Bus Master and one MPS for all
    endpoints after a blade reloads or reboots;
  - publishes the OpenMIOP v4 peer table into every endpoint BAR;
  - re-enumerates from the PCIe root port `00:00.0` (not from the
    switch) when a blade appears without a BAR address, so the root and
    switch windows are sized for all blades; at most once a minute, after
    quiescing P2P traffic; `/var/run/openmiop-reenumerate` forces one;
  - never reads an endpoint whose link may be dropping (quiet periods,
    config-space liveness check before MMIO);
  - relays BMC gateway frames (TAP `omi0`).
  No BMC kernel module is needed besides `kmod-tun`.
- **Firmware identity** (`mixtile-release` package): `/etc/mixtile-release`
  with `FIRMWARE_VERSION` (git tag), `GIT_COMMIT`, `BUILD_DATE`,
  `REPOSITORY`, `OPENWRT_VERSION`, `KERNEL_VERSION`, `BOARD`, `TARGET`,
  `OPENMIOP_PROTOCOL` / `OPENMIOP_VERSION` / `OPENMIOP_SOURCE` (from the
  compiled openmiop source) and `UPDATE_CHANNEL`, generated by the build
  from the tag and commit being built.
- **LuCI version display**: login page (all installed themes), page
  footer and a "Mixtile ClusterBox" block on Status → Overview show
  firmware version, commit and OpenMIOP protocol from `/etc/mixtile-release`.
- **Firmware update checker** (`mixtile-update`, `luci-app-mixtile-update`):
  - GitHub Releases of this repository as the update source (from
    `REPOSITORY` in `/etc/mixtile-release`; configurable);
  - channels `rc` (default for release candidates) and `stable`;
  - `status`, `check`, `download`, `verify`, `install --yes`,
    `verify-local`, `install-local --yes` (first install from older
    firmware), usable over SSH and from LuCI System → Firmware Update;
  - checks board, target, version (no downgrade/reinstall without
    `--allow-downgrade`), OpenMIOP protocol (`--allow-protocol-change`),
    SHA-256 against `SHA256SUMS` and the release manifest, the image's
    OpenWrt metadata and `sysupgrade -T`; never installs without explicit
    confirmation;
  - optional usign signature check of `SHA256SUMS` (keys in
    `/etc/mixtile-update/keys/`), ready for signed releases;
  - before installing, removes overlay files that would shadow the new
    firmware and keeps configuration, `/etc/rc.d`, `/root/.ssh`, `/home`,
    `/opt` (`/etc/mixtile-update/keep`); after the reboot it records
    whether the running firmware matches what was installed.
- **CI release pipeline**: pull requests to `main` and `v*` tags build the
  firmware, unpack the produced image and check its contents
  (`scripts/clusterbox/verify-firmware.sh`); tags publish the release
  (image, `clusterbox-firmware.json`, packages, manifests, `BUILD-INFO.txt`,
  `SHA256SUMS`).
- nodectl v2 and the LuCI **Cluster** UI (from `feature/nodectl-ui`): node
  status, power/reset/graceful shutdown, serial and SSH consoles in the
  browser, OS image flashing, Rescue/PXE, fan control, metrics, LuCI
  account ACLs; optional Teleport agent package (not in the default image).

### Changed

- The Backup/Flash page's online-update section now points to System →
  Firmware Update; the date-based `/usr/sbin/ota-update` (Mixtile upstream
  source) is removed.
- OpenWrt feeds pinned to commits (`feeds.conf.default`).
- Upstream OpenWrt CI workflows that do not apply to this firmware
  (formalities, kernel/package/toolchain matrices, labelers, Coverity,
  containers) and the date-tagged release workflow are removed; one
  workflow builds, verifies and releases the ClusterBox firmware.

### Fixed

- BMC helper re-enumeration started at the switch instead of the root
  port, which left the root window too small (32 MiB) for a fourth blade.
- Helper safety against MT7620A completion-timeout wedges (quiet periods
  after a blade leaves, no MMIO without a live config space).

### Tested

- OpenMIOP on the BMC: the same helper source (CI build, byte-identical
  across pcie-ep-net CI runs) ran on this Cluster Box with four Blade 3
  endpoints (two Debian, two Talos): five-member ping/jumbo matrix, P2P
  TCP 6.5-8.3 Gbit/s between blades, SHA-256 transfers identical,
  root-port re-enumeration forced, after a blade was removed and after a
  blade was added.
- `mixtile-update` on the running BMC (OpenWrt 23.05, BusyBox):
  `status`, `check` (rc and stable channels against this repository),
  version ordering, `prune-preview` against the real overlay.
- Firmware image contents: checked in CI on the image that is released.

### Known limitations

- Not hardware-tested in this release: booting this firmware build on the
  BMC, `mixtile-update install`/`install-local` (sysupgrade on the
  microSD) and the microSD recovery procedure. The OpenMIOP helper and
  nodectl it contains were tested as separately installed binaries.
- No A/B rootfs: a failed write needs recovery by rewriting the microSD
  card. Releases are not signed yet (SHA-256 over HTTPS only); signing is
  required before a stable v1.0.
- OpenMIOP: root-port re-enumeration pauses all fabric traffic ~1-2 s
  when a blade appears without a BAR address; a blade that disappears
  without the leave handshake can race a BMC read and wedge the fabric
  until the BMC reboots. The BMC gateway is management-grade (~12 Mbit/s).
- Packages installed with `opkg` after flashing are removed by an update.
- The vendor `miop.ko` (Mixtile MIOP for `4586:b6f2` endpoints) stays in
  the image as a prebuilt upstream binary; it is not built here and is
  not used by OpenMIOP.

[0.1.0-rc.3]: https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt/releases/tag/v0.1.0-rc.3
[0.1.0-rc.2]: https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt/releases/tag/v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt/releases/tag/v0.1.0-rc.1
