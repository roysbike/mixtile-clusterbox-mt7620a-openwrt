# Changelog

ClusterBox BMC firmware (OpenWrt on the Mixtile Cluster Box MT7620A; 25.12 from
v0.4.0, 23.05 before).
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- LuCI: menu entry **ClusterBox UI** (next to Logout) that opens the main
  web UI (MoCI, `/moci/`); MoCI has its own session and may ask to log in.
- `devmem` (busybox) for reading SoC registers on the console, e.g. the
  MT7620A GPIO mode, data and direction registers while finding out what
  drives the OCuLink lane-0 mux. Only reads are meant: a write to the
  wrong register can stop the PCIe root complex and with it the fabric.

### Fixed
- nodectl no longer reads the blades' PCIe config space. `status` read
  each endpoint's Link Capabilities and `list` ran `lspci`; a blade link
  that dropped during such a read (blade reboot, crash) left it in flight
  and the MT7620A completion timeout wedged the root complex: every blade
  lost the BMC until a BMC reboot (seen 2026-10-22 on a `talosctl reboot`,
  with `nodectl status` polled; `nodectl-metrics` runs it every minute).
  `status` now reads only the switch port and takes the blade's link
  capabilities from the new options `ep_max_gen`/`ep_max_width` (default
  Gen3 x2); `list` prints the IDs the kernel cached at enumeration.
- `/etc/config/nodectl`: the console archive options were listed twice.

## [0.4.0] - 2026-10-20

The firmware on OpenWrt 25.12.6 (Linux 6.12.112) with a new web UI, the
BMC part of OpenMIOP Stack v0.6.0. Runs on the lab Cluster Box since
2026-10-19 (development builds, every one flashed and checked with four
blades).

### Changed

- Base: OpenWrt 25.12.6 (25.12.5 in rc.1, which did not boot: the old SD
  driver failed CMD48; the upstream `mtk-sd` driver works). Boots through
  the lzma loader; the upgrade prunes the eMMC overlay of the old firmware.
- `omi-rc`/`openmiop` from pcie-ep-net
  [v0.6.0](https://github.com/roysbike/pcie-ep-net/releases/tag/v0.6.0)
  (`omi-rc` as in v0.5.2: it enables memory and bus mastering on the
  ASM2824 ports, which Linux 6.12 leaves off; without it no blade
  connects).
- Network layout: `wan` (1G jack) and `openmiop` (omi0), no LAN bridge.
- Login `mixtile` (asked to change the factory password at the first
  login), root without a password (SSH keys only).
- The BMC gateway is 10-20 % slower than on 23.05 (Linux 6.12 network
  stack on the MIPS core).

### Added

- Web UI (MoCI, patched for the box), three pages, every setting in one
  place:
  - CLUSTER: the cluster (name, description, role of every slot), the
    box from the front (BMC, PCIe switch, slots 1-4 with LEDs, state,
    24 h availability, CONSOLE, LOGS, POWER), health, traffic.
  - NETWORK: TOPOLOGY (live diagram of the box's networks), INTERFACES
    (+ WAN fallback address), FIREWALL, DHCP & DNS (+ DNS/DHCP/names for
    the blades), ROUTES, DEVICES, TAILSCALE, WIREGUARD, OPENVPN,
    DIAGNOSTICS.
  - SYSTEM: GENERAL (+ NTP for the blades, reboot), ACCESS (ports, zones,
    password; changes roll back unless confirmed), FIRMWARE (updates
    from GitHub with release notes, manual upload in 32 KiB chunks),
    BACKUP (progress, configuration history), SOFTWARE (apk), STARTUP
    (enabled at boot), LOGS, SCHEDULED TASKS, SSH KEYS, STORAGE.
  - Login page with the firmware version and a link to its release;
    web files versioned, so the browser picks up a new firmware.
- Console archive on the eMMC: every boot of every blade in its own
  file, LOGS viewer (read from boot, follow, search, download).
- Node availability log (`availwatch`) and 24 h bars.
- Background release check (`mixtile-update watch`, every 12 h) with an
  update banner.
- OpenVPN server for remote access (self-signed certificates pinned by
  fingerprint, one .ovpn per client) and outgoing OpenVPN connections
  from uploaded .ovpn files; WireGuard; Tailscale.
- DHCP on omi0 by default (10.20.0.20-99, gateway, DNS and NTP the BMC).
- `nodectl probe` (TCP check for the forwarded services).
- Documentation: the BMC's serial console (3-pin UART header TX/RX/GND,
  57600 8N1 per Mixtile, kernel console 115200), with Mixtile's pinout
  PDF; README EN/RU.

### Fixed

- Documentation: the BMC has no microSD card. Kernel, rootfs and overlay
  are on the on-board `mmcblk0` (U-Boot, its environment and factory data
  on SPI flash). The "rewrite the microSD on a PC" recovery in the README
  and the v0.1.0-rc release notes was wrong and is removed. README
  Recovery: a BMC that does not boot is brought back with the factory
  restore (hold reset while powering on until the LED blinks), then the
  release is installed again; back up the configuration before every
  update.
- Documentation: known v0.3.0 issue, `/home/mixtile` belongs to root
  (`mixtile` cannot create `~/.ssh`).
- MoCI firmware upload (uhttpd takes at most 64 KiB per /ubus request),
  network activity graph (units, VLAN double count), STARTUP (enabled
  state from procd's rc), SOFTWARE (apk on 25.12).

## [0.4.0-rc.1] - 2026-10-14

The firmware moves from OpenWrt 23.05.2 (Linux 5.15.150) to OpenWrt
25.12.5 (Linux 6.12.94). OpenMIOP unchanged (Stack v0.5.0, `omi-rc` with
gateway pull and zero-copy).

### Changed

- Base: OpenWrt 25.12.5, Linux 6.12, package manager apk instead of opkg.
- Fans on the upstream `pwm-gpio` driver (one PWM chip per fan, same
  sysfs paths for fan-boot and nodectl); the vendor gpio-pwms kernel patch
  is gone (its tachometer reading was broken and unused).
- Blade console driver ch343 updated to WCH V2.2.
- `omi-rc`/`openmiop` from pcie-ep-net
  [v0.5.1](https://github.com/roysbike/pcie-ep-net/releases/tag/v0.5.1)
  (`omi-rc` builds with Linux 6.1+; same at run time as v0.5.0).
- Firmware version shown by LuCI from `/etc/openwrt_release`
  (`OpenWrt 25.12.5 ClusterBox vX.Y.Z`).
- SD image built for this board only (kernel padded to 10 MiB, squashfs
  after it), with size checks; same layout on the card as before.
- sudo rule for the `sudo` group in `/etc/sudoers.d/mixtile`.

### Removed

- Wi-Fi stack (the box has no radio; hostapd and wpa_supplicant ran for
  nothing), PPP/PPPoE, OpenVPN and its firewall zone, DDNS, lrzsz, pv,
  memtool, f2fs tools, the initramfs image, Mixtile's vendor `miop.ko`
  (replaced by `omi-rc`) and the LuCI 23.05 overrides (login page, flash
  and password pages).

### Fixed

- Files in the squashfs belong to root again (the 23.05 image carried the
  build user's uid 1001/gid 121 in `/rom`).

## [0.3.0] - 2026-10-14

The BMC part of OpenMIOP Stack v0.5.0.

### Added

- `kmod-omi-rc` and `openmiop` 0.5.0 from pcie-ep-net v0.5.0 (`6fbcff1`):
  gateway zero-copy. Blades with the v0.5 driver read unicast frames
  from the BMC's stack straight from its buffers; `omi-rc` no longer
  copies them. LAN -> blade 196-198 -> 275-281 Mbit/s. Parameter `zc`
  (default on); older blades keep the copy path.
- CI image check: `omi-rc` has zero-copy (parameter `zc`).

### Tested

- The same `omi-rc` code loaded by hand on firmware v0.2.0 with a v0.5
  blade (.108) and v0.4.0 blades alongside: SHA-256 3/3, 16 stress rounds
  clean, `omi-rc` reload during a download recovered, no memory leak over
  2.16 million zero-copy frames.

## [0.2.0] - 2026-10-13

Stable BMC part of OpenMIOP Stack v0.4.0. Same content as 0.2.0-rc.2
except the package pin: `kmod-omi-rc` and `openmiop` 0.4.0 from
pcie-ep-net v0.4.0 (`c607b86`, code identical to 0.4.0-rc.2). Sums up
0.2.0-rc.1 and 0.2.0-rc.2.

### Added

- Gateway pull (`omi-rc` from pcie-ep-net v0.4.0): blades with the v0.4
  driver read LAN/internet -> blade frames from BMC memory with their
  eDMA; LAN -> blade 92 -> 193-198 Mbit/s.
- Firewall software flow offloading on by default
  (`/etc/uci-defaults/90-openmiop-flow-offload`).

### Fixed

- `omi-rc` writes the credit when it resyncs a blade's gateway ring
  (0.2.0-rc.2).

### Tested

- v0.2.0-rc.2 (same `omi-rc` code) flashed on the lab Cluster Box
  2026-10-13 ~17:13Z: all four blades active with gateway pull 47 s after
  power-on, NVMe live, `rx_fifo_errors` 0, flow offloading on. That BMC
  reboot force-demoted a DRBD Primary on a blade (DRBD 9.3.4,
  LINBIT/drbd#153), recovered by a database failover.

## [0.2.0-rc.2] - 2026-10-13

The BMC part of OpenMIOP Stack v0.4.0-rc.2.

### Fixed

- `kmod-omi-rc` and `openmiop` from pcie-ep-net v0.4.0-rc.2 (`11c8e53`).
  When `omi-rc` resyncs a blade's gateway ring it now writes the new
  credit to the blade at once (a blade on v0.4.0-rc.1 could wait for it
  forever with a full ring and lose the gateway), logs a warning and
  counts `rx_fifo_errors` on omi0. The main fix of that bug, false peer
  stalls under load, is on the blades: mixtile-talos v0.4.0-rc.2.
- CI image check: `omi-rc` is v0.4.0-rc.2 or later.

### Tested

On the lab Cluster Box (firmware v0.2.0-rc.1 with this `omi-rc` code
loaded by hand), .108 on the v0.4.0-rc.2 blade driver: 21 stress rounds
(3 parallel 300 MB blade -> LAN uploads plus a 300 MB download, BMC CPU
99 %), the last 15 during P2P load at 8.7 Gbit/s: gateway up throughout,
0 stalls, `rx_fifo_errors` 0.

## [0.2.0-rc.1] - 2026-10-13

The BMC part of OpenMIOP Stack v0.4.0-rc.1: a faster gateway from the
LAN and internet to the blades.

### Added

- `kmod-omi-rc` and `openmiop` from pcie-ep-net v0.4.0-rc.1 (`35884c8`):
  gateway pull. Blades with the v0.4 driver read LAN/internet -> blade
  frames from BMC memory with their eDMA; the BMC writes only the slot
  header over PCIe. Blades on v0.3.x keep the old path.
- Firewall software flow offloading on by default
  (`/etc/uci-defaults/90-openmiop-flow-offload`, only if
  `flow_offloading` is not set yet).
- CI image check: `omi-rc` has gateway pull, the offloading default is
  in the image.

### Tested

On the lab Cluster Box (firmware v0.1.1, the v0.4.0-rc.1 `omi-rc` code
loaded by hand, flow offloading switched on by hand), .108 on a
mixtile-talos test image with the v0.4 driver, compared at the same
time with .133 on v0.3.0:

- LAN -> blade through the BMC: 141-145 Mbit/s (v0.3.0 blade: 92-95);
  internet -> blade 152-155 Mbit/s (97-106); BMC -> blade without NAT
  204 Mbit/s (130); 444 158 frames pulled, 0 errors;
- flow offloading: blade -> LAN 207-210 -> 247-251 Mbit/s, BMC CPU
  95 -> 85 %.

## [0.1.1] - 2026-10-12

Patch release: the BMC part of OpenMIOP Stack v0.3.1. Only `omi-rc`
changes; mixtile-talos v0.3.0 stays current on the blades.

### Fixed

- `kmod-omi-rc` from pcie-ep-net v0.3.1 (`bd2cfba`): the `omi-rc`
  control thread no longer keeps the BMC load average at 1.00 (it slept
  in D state between passes).

### Changed

- `openmiop` and `kmod-omi-rc` from pcie-ep-net v0.3.1. The helper is
  unchanged from 0.3.0.

### Tested

- The v0.3.1 `omi-rc` (same code, built by this firmware's CI) loaded by
  hand on the lab BMC on v0.1.0-rc.6: `[omi-rc]` in `IW` instead of `DW`,
  load average 1.08 -> 0.27 within 2 min, all four blades active 1.7 s
  after `insmod`, `nodectl reset` of a blade: released, active again
  10.9 s after, node Ready in 57 s.

## [0.1.0] - 2026-10-12

First stable ClusterBox firmware: the BMC side of OpenMIOP Stack v0.3.0
(push mode with `omi-rc`). Same image contents as 0.1.0-rc.6 apart from
the version.

### Changed

- `openmiop` and `kmod-omi-rc` from pcie-ep-net v0.3.0 (`a4bc7ef`), same
  code as v0.3.0-rc.2.

### Tested

- rc.6 on the lab Cluster Box (2026-10-12, four Blade 3 on mixtile-talos
  v0.3.0-rc.1): `omi-rc` loaded by the init at 45.1 s, all blades
  active at 46.7 s, helper not running; blade DNS through the BMC back
  the same second; NVMe live on every blade, etcd 3/3, DRBD clean.
  `nodectl reset` of a blade: released, link down 32 ms later, active
  again 14.5 s after the reset. iperf3 between blades 25.0 Gbit/s with
  four senders at once.

## [0.1.0-rc.6] - 2026-10-12

`omi-rc` from pcie-ep-net v0.3.0-rc.2: the blades are active right after
the BMC boots, not ~5 minutes later.

### Fixed

- After a BMC boot `omi-rc` (loaded by the init at ~45 s) activated the
  blades only at ~300 s of uptime: 32-bit jiffies starts 300 s before
  its wrap and two of the module's deadlines were 0. Blade-to-blade
  traffic was fine, but the blades' default route, DNS and NTP through
  the BMC timed out meanwhile. Seen after flashing rc.5 on 2026-10-12.

### Changed

- `openmiop` and `kmod-omi-rc` from pcie-ep-net v0.3.0-rc.2 (`75e0313`);
  the helper and the init script are unchanged.

## [0.1.0-rc.5] - 2026-10-11

The BMC never reads a blade: OpenMIOP from pcie-ep-net v0.3.0-rc.1, with
the Cluster Box side as a kernel module (`omi-rc`, push mode) loaded at
boot. Blades must run pcie-ep-net v0.3 (mixtile-talos v0.3.0-rc.1)
first.

### Added

- `kmod-omi-rc` (pcie-ep-net `drivers/omi-rc`), in the image: the
  Cluster Box side of OpenMIOP in the kernel, in push mode. The blades
  write their state into BMC memory and the BMC only writes into them,
  so a blade that crashes or loses power can no longer stop the MT7620A
  root complex with a read in flight. Provides `omi0` (10.20.0.1, same
  MAC as the helper). Not autoloaded by itself: the `openmiop` init
  script loads it.

### Changed

- OpenMIOP from pcie-ep-net v0.3.0-rc.1 (`openmiop` and `kmod-omi-rc`).
  The `openmiop` init script starts `omi-rc` and falls back to the
  userspace helper `openmiop-rc` if the module does not load;
  `touch /etc/openmiop.use-helper` keeps the helper (blades without
  push mode). The helper itself is unchanged from v0.2.0-rc.2.
- nodectl 2.0-3: `nodectl reset`/`poweroff` release a blade through
  `/sys/module/omi_rc/parameters/release` when the module is loaded
  (the helper's release file otherwise).
- `verify-firmware.sh` checks `omi-rc.ko` and that the init loads it.

## [0.1.0-rc.4] - 2026-10-08

A blade that reboots, is reset or loses power through `nodectl` no
longer takes the PCIe fabric down. OpenMIOP helper from pcie-ep-net
v0.2.0-rc.2 (protocol v4).

### Fixed

- PCIe fabric outages after a blade reset or power cut: `nodectl reset`
  and `nodectl poweroff` (also `reboot --hard`) first ask openmiop-rc to
  release the blade (`/var/run/openmiop-release.<switch port>`) and wait
  up to 1 s for it. A BAR read in flight when a blade's link drops
  without warning stops the MT7620A root complex until the Cluster Box
  reboots.
- openmiop-rc (pcie-ep-net v0.2.0-rc.2): no request to a
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
- `mixtile-update install` and recovery of a BMC that does not boot are
  still not hardware-tested (rc.1 → rc.2 is the first OTA update).
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
  BMC, `mixtile-update install`/`install-local` (sysupgrade to the
  on-board `mmcblk0`) and recovery of a BMC that does not boot. The OpenMIOP helper and
  nodectl it contains were tested as separately installed binaries.
- No A/B rootfs: a failed write needs the firmware rewritten outside
  the BMC's OpenWrt (factory restore with the reset button). Releases are not signed yet (SHA-256 over HTTPS only); signing is
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
