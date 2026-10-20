# Mixtile Cluster Box BMC firmware (OpenWrt, MT7620A)

[English](README.md) · [Русский](README.ru.md)

The **Mixtile Cluster Box** holds four **Mixtile Blade 3** compute boards.
Its control board, the **BMC** (baseboard management controller, a
MediaTek MT7620A), is the box's own small computer: it is on whenever the
box has power, whatever the blades do. This repository is an open
OpenWrt firmware for that BMC. It replaces Mixtile's firmware and turns
the BMC into the one place from which the whole box is run:

* **Power and consoles of the blades.** Switch each blade on and off,
  reset it, open its serial console in the browser, and read every boot
  of every blade later: the consoles are recorded to the BMC's storage.
* **The PCIe fabric.** The BMC is the PCIe root complex of the box. Its
  `omi-rc` module brings up **OpenMIOP**, Ethernet between the blades
  over the internal PCIe switch (`omi0`, 7-8 Gbit/s per flow between
  blades; that traffic stays in the switch and never touches the BMC).
* **The cluster's network edge.** The blades reach the LAN and the
  Internet through the BMC (NAT, DNS and NTP for the blades), and
  services of the cluster (Kubernetes API, ingress) are forwarded from
  the BMC's WAN address.
* **Remote access** to the box and the cluster: Tailscale, WireGuard and
  OpenVPN, SSH, and a web UI with a guard that rolls back access changes
  that would lock you out.
* **Watching the box**: which blades are up and for how long (24 h
  history), the fabric, the uplink, the forwarded services, the fan and
  power supply.
* **Its own updates**: the BMC checks GitHub Releases for new firmware,
  shows what changed and installs it from the web UI; the blades keep
  running meanwhile.

![ClusterBox web UI: the cluster page with the box from the front](docs/images/web-ui-cluster.jpg)

*The start page of the web UI (v0.4.0): the cluster at the top, the
box from the front below it (the BMC, the PCIe switch, slots 1-4 from top to
bottom with their state, 24 h availability and CONSOLE, LOGS and POWER),
health and traffic beside it.*

Current release: **v0.4.0** (OpenWrt 25.12.6, Linux 6.12; OpenMIOP Stack
v0.6.0) — [release notes](release-notes/v0.4.0.md),
[CHANGELOG.md](CHANGELOG.md),
[release page](https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt/releases/tag/v0.4.0).
The previous release v0.3.0 is on OpenWrt 23.05.

## Hardware and who this is for

The **Mixtile Cluster Box** is a small chassis for four **Mixtile Blade 3**
boards. Inside it:

* the BMC: MediaTek MT7620A (MIPS 24KEc, 580 MHz, 256 MB RAM) with an
  on-board eMMC, a 1 Gbit/s WAN port, the fans and the USB serial
  adapters of the four blade consoles. It switches the blades on and
  off, resets them and is the PCIe root complex of the box;
* an ASMedia ASM2824 PCIe Gen3 switch: a Gen3 x2 link to each blade slot
  and a Gen1 x1 uplink to the BMC.

The **Mixtile Blade 3** is a compute board with the Rockchip RK3588
(4× Cortex-A76 + 4× Cortex-A55), eMMC and an M.2 NVMe slot. Its PCIe 3.0
x4 controller is split in two: lanes 0-1 go to the Cluster Box switch,
lanes 2-3 to the NVMe. A Blade 3 also works on its own, without a
Cluster Box.

Mixtile ships the box with its own BMC firmware and its own blade
network driver (MIOP). The **OpenMIOP Stack** is an independent open
replacement for people who own a Cluster Box with Blade 3 boards (or a
single Blade 3) and want:

| You want | Repository |
| --- | --- |
| Ethernet between the blades over the PCIe switch (`omi0`, 7-8 Gbit/s per flow, ~25 Gbit/s with four senders) | [pcie-ep-net](https://github.com/roysbike/pcie-ep-net) |
| Talos Linux (Kubernetes) on Blade 3, in a Cluster Box or on its own | [mixtile-talos](https://github.com/roysbike/mixtile-talos) |
| Current OpenWrt on the BMC: blade power and consoles, the PCIe fabric, the cluster's network edge, remote access, firmware updates | [mixtile-clusterbox-mt7620a-openwrt](https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt) (this repository) |

## Where the BMC sits

```
        LAN / Internet
              |
   WAN 1 Gbit/s (DHCP)          remote access: Tailscale, WireGuard, OpenVPN
              |
  +--------------------------------------------------+
  |  BMC  MT7620A, OpenWrt (this firmware)           |
  |   web UI, SSH, nodectl (power, consoles, logs)   |
  |   NAT, DNS, NTP for the blades, port forwards    |
  |   omi-rc: omi0 10.20.0.1/24, the blades' gateway |
  +--------------------------------------------------+
        | PCIe Gen1 x1 (control + gateway)
   ASM2824 PCIe switch   (blade-to-blade traffic stays here)
     |         |         |         |      Gen3 x2 each
  slot 1    slot 2    slot 3    slot 4    Blade 3 (RK3588), omi0 10.20.0.x
```

| OpenMIOP Stack v0.6.0 | |
| --- | --- |
| Protocol | OpenMIOP v4 between blades (per-connection doorbell, multiqueue, checksum offload), push mode, gateway pull and zero-copy to the BMC |
| Blade driver, BMC module | [pcie-ep-net v0.6.0](https://github.com/roysbike/pcie-ep-net/releases/tag/v0.6.0) (`omi-rc` as in v0.5.2) |
| Blade OS | [mixtile-talos v0.6.0](https://github.com/roysbike/mixtile-talos/releases/tag/v0.6.0) |
| ClusterBox BMC | [mixtile-clusterbox-mt7620a-openwrt v0.4.0](https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt/releases/tag/v0.4.0) (this repository) |

The blades run the endpoint driver (`openmiop-ep.ko`, ARM64; not part of this
firmware). The BMC runs the `omi-rc` kernel module (push mode: the blades
write their state into BMC memory, the BMC never reads a blade), or the older
userspace helper `openmiop-rc` as a fallback. Both find the endpoints
(`1d87:4f4d`) behind the ASM2824, restore their BAR, command and MPS
settings, number them by switch slot, publish the peer table into every
endpoint BAR, re-enumerate from the PCIe root port `00:00.0` when a blade
appears without a BAR address, and put the BMC itself on `omi0`
(10.20.0.1/24) as the blades' gateway. The `openmiop` init loads the module
and starts the helper only if the module does not load, or when
`/etc/openmiop.use-helper` exists (blades older than pcie-ep-net v0.3).

## What is in the firmware

| Package | Content |
| --- | --- |
| `kmod-omi-rc`, `openmiop` | the BMC side of OpenMIOP: `omi-rc.ko` (log: `dmesg | grep omi0`), `/etc/init.d/openmiop`, the fallback helper `openmiop-rc` and `omi-peek`, from pcie-ep-net |
| `nodectl`, `luci-app-nodectl` | blade power, reset, serial consoles (browser terminal), console archive, PXE and flashing; LuCI **Cluster** menu |
| `clusterbox` | the BMC settings (`/etc/config/clusterbox`): management access with roll-back guard, WAN fallback address, DNS and NTP for the blades, persistent log, configuration history, node availability log, cluster description, firmware status; the rpcd backend of the web UI |
| `moci`, `moci-app-clusterbox` | the web UI (MoCI, patched for the box) with the ClusterBox pages and sections, see [The web UI](#the-web-ui); LuCI stays at `/cgi-bin/luci` |
| `mixtile-release` | `/etc/mixtile-release`: firmware version (git tag), commit, build date, repository, OpenWrt and kernel version, board, OpenMIOP protocol, update channel — generated by the build |
| `mixtile-update`, `luci-app-mixtile-update` | update check, download, verification and install from GitHub Releases, background check (`/etc/config/mixtile-update`) |
| Tailscale, WireGuard, OpenVPN | remote access (`tailscale`, `kmod-wireguard`/`wireguard-tools`, `openvpn-mbedtls` + `openssl-util` for the server keys), pages in the web UI (NETWORK → TAILSCALE, WIREGUARD and OPENVPN) and in LuCI |

### The web UI

Three pages, each setting in one place (the login page shows the
firmware version with a link to its release on GitHub):

| Page | Tabs |
| --- | --- |
| **CLUSTER** | the start page: the cluster, the box from the front, health, traffic |
| **NETWORK** | TOPOLOGY · INTERFACES (with the WAN fallback address) · FIREWALL (with the port forwards) · DHCP & DNS (with DNS, DHCP and names for the blades on omi0) · ROUTES · DEVICES · TAILSCALE · WIREGUARD · OPENVPN · DIAGNOSTICS |
| **SYSTEM** | GENERAL (name, time zone, NTP server for the blades, reboot) · ACCESS (web/SSH ports and zones, password) · FIRMWARE (updates from GitHub and a manual upload) · BACKUP (with progress, and the configuration history) · SOFTWARE (apk: installed, search, install, remove) · STARTUP (enabled at boot, start/stop) · LOGS (with log storage) · SCHEDULED TASKS · SSH KEYS · STORAGE |

DHCP on omi0 is on by default (10.20.0.20-99; the blades, 10.20.0.205
and the MetalLB pool 210-219 are static) and hands out the BMC as
gateway, DNS and NTP server. The BMC has no radio, so there is no
Wi-Fi page.

**CLUSTER**, the start page:

* On top, the cluster: its name and description and the role and note
  of every slot (**EDIT**, stored in `/etc/config/clusterbox`; the BMC
  does not see Kubernetes, so the operator writes them), an overall
  state and the key facts (nodes online, fabric, WAN, Internet,
  Tailscale).
* The box from the front, as it is built: the BMC on top (power, WAN and
  PCIe switch LEDs, fan duty), the ASM2824 switch with its uplink, then
  slots 1-4 from top to bottom. Every slot shows LEDs for power, PCIe
  link and the node answering on its check port, the name, role, address
  and link (Gen3 x2), the state and how long the node has been in it,
  the last 24 hours as a bar (online, booting, no PCIe link, off, no data
  while the BMC was down) with the online share, and CONSOLE, LOGS and
  POWER (shut down, reboot, cut power, power on).
* Beside it: health (nodes, fabric, Internet, WAN, the forwarded
  services: answering or not, checked every 30 s with `nodectl probe`,
  Tailscale, firmware, chassis), the traffic through the BMC over the
  last 5 minutes (blade-to-blade traffic does not pass the BMC), the
  forwarded services and the BMC's load, memory, uptime and firmware.

The page asks the BMC once every 5 s (`clusterbox topology`), changes
only the values that changed and stops while the browser tab is hidden.
**LOGS** opens the console log of a node: pick a boot, read it from the
first line, follow new output, search the whole boot, download it.

**Firmware updates in the web UI.** The BMC looks for a new release
itself (`mixtile-update watch`: 5 min after boot, then every 12 h; only a
check, nothing is downloaded): a banner then offers it on every page,
with the release notes, and **UPDATE** downloads, verifies (SHA-256,
board, signature when keys are set up) and installs it, waits for the BMC
and reloads the page. **SYSTEM → FIRMWARE** shows the running firmware
(version, OpenWrt, kernel, commit, partitions) and the last check.
Settings: `auto_check`, `check_interval` in `/etc/config/mixtile-update`.
Development builds (`vX.Y.Z-N-g<sha>`) are never offered a release.

After a firmware update the browser loads the new web files by itself:
`/www/moci/version.txt`, a hash of them written at boot, is read past the
cache and goes into every URL (uhttpd sends no Cache-Control).

The LuCI login page, the page footer and Status → Overview show
`Mixtile ClusterBox · Firmware <version> · commit <sha> · OpenMIOP v<n>`, read
from `/etc/mixtile-release`.

### Network: topology and VPN

**NETWORK → TOPOLOGY** draws the box's network as it is now, every 5 s:
the Internet and the upstream router, the BMC (WAN address and link,
traffic, port forwards, firewall zones), and each network behind it with
what is on it: `omi0` (the PCIe fabric) with the four blades and the
forwarded service addresses, Tailscale, the OpenVPN server with its
clients, outgoing OpenVPN connections and WireGuard interfaces.

**NETWORK → OPENVPN**:

* *Server* — remote access to the BMC (web UI, SSH) and to the blades'
  network 10.20.0.0/24 from a laptop or phone. **SET UP THE SERVER** asks
  for the address clients connect to, port, protocol and the client
  subnet; **ADD CLIENT** makes a client and downloads its `.ovpn` (it can
  be downloaded again later), **DELETE** locks that client out. There is
  no certificate authority to look after: the server and every client
  have their own self-signed EC certificate and each side pins the
  other's SHA-256 fingerprint (`peer-fingerprint`). The keys stay on the
  BMC in `/etc/openvpn/cb/` and are kept across firmware updates. The
  BMC's WAN address is usually private: forward the port to it on the
  upstream router.
* *Connections to other VPN servers* — upload an `.ovpn` file from
  another side (an office, a cloud network); the BMC connects out with
  it. Directives that run programs (`up`, `script-security`, `plugin`, …)
  are refused. Connections set up in LuCI (**VPN → OpenVPN**) are listed
  too.

WireGuard has its own tab (**NETWORK → WIREGUARD**, MoCI's page), Tailscale
is under **NETWORK → TAILSCALE**.

### Console logs and availability

Each blade's serial console (CH343 USB UART on the BMC, 1.5 Mbaud) is
recorded by `nodectl consoled` to the BMC's eMMC, one file per boot of
the blade: `/overlay/log/nodectl/nodeN/YYYYmmdd-HHMMSS.log` (long boots
continue in `.pNNN.log` parts of `console_archive_part_mb`), every line
prefixed with the BMC time. A new file starts on a power on or reset from
`nodectl`, on a U-Boot or kernel boot banner, or when the kernel
timestamps go back (the blade rebooted by itself). The oldest boots are
deleted above `console_archive_mb` (512) or `console_archive_boots` (100)
per blade; settings in `/etc/config/nodectl`. The archive lives outside
the overlay's upper directory, so firmware updates keep it.

`availwatch` (part of `clusterbox`) checks every 20 s whether each blade
is powered, has its PCIe link and answers on its check port, and logs
every change to `/overlay/log/clusterbox/availability`.

## Install

Release assets:

| File | Purpose |
| --- | --- |
| `openmiop-<version>-clusterbox-bmc-openwrt-<openwrt>-mipsel-sysupgrade.bin` | the firmware (`<openwrt>` = `23.05` up to v0.3.0, `25.12.6` from v0.4.0), written by sysupgrade to the BMC's on-board storage (`mmcblk0`) |
| `clusterbox-firmware.json` | board, target, version, commit, OpenMIOP protocol, image SHA-256 (read by `mixtile-update`) |
| `mixtile-update` | update tool, for the first install from older firmware |
| `SHA256SUMS`, `BUILD-INFO.txt` | checksums and build record |

This target has no separate factory image. Packages (`*.ipk` on 23.05,
`*.apk` on 25.12), the package manifest and buildinfo files are CI
artifacts only.

### First install (from older ClusterBox firmware)

On this board sysupgrade rewrites only kernel and rootfs; the ext4 overlay
(`mmcblk0p3`) survives, so files changed on the old firmware would keep
shadowing the new ones. `mixtile-update install-local` removes them first
and keeps configuration (`sysupgrade -l`), `/etc/rc.d`, `/root/.ssh`,
`/home`, `/opt`:

```sh
V=v0.3.0
I=openmiop-${V#v}-clusterbox-bmc-openwrt-23.05-mipsel-sysupgrade.bin
B=https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt/releases/download/$V
for f in $I clusterbox-firmware.json SHA256SUMS mixtile-update; do curl -fLO "$B/$f"; done
sha256sum -c SHA256SUMS
scp -O $I clusterbox-firmware.json SHA256SUMS mixtile-update root@<bmc>:/tmp/
ssh root@<bmc> "sh /tmp/mixtile-update verify-local /tmp/$I"
ssh root@<bmc> "sh /tmp/mixtile-update prune-preview"     # overlay files that will be dropped
ssh root@<bmc> "sh /tmp/mixtile-update install-local --yes /tmp/$I"
```

(Run the `ssh` commands as root, or with `sudo` as an admin user.) The BMC
reboots; blades keep power. Packages installed later with `opkg` are not
kept — note them with `opkg list-installed` first.

Flashing through LuCI *Backup / Flash Firmware* instead also works, but it
does not clean the overlay: files copied by hand on the old firmware (for
example an older `/usr/bin/openmiop-rc`) keep shadowing the new firmware.
Check with `ls /overlay/upper/usr/bin /overlay/upper/etc/init.d`; a later
`mixtile-update install` removes them.

### Updates from the BMC (from v0.1.0-rc.1 on)

LuCI: **System → Firmware Update** → *Check for updates* → *Download &
verify* → *Install update* (asks for confirmation). Or over SSH:

```sh
mixtile-update status
mixtile-update check                 # newest release on the channel
mixtile-update download
mixtile-update verify                # board, target, version, OpenMIOP protocol, SHA-256
mixtile-update install --yes         # prunes the overlay as above, then sysupgrade -n
```

* Source: the GitHub Releases of the repository named in
  `/etc/mixtile-release` (`REPOSITORY`), i.e. this repository; override with
  `uci set mixtile-update.main.repository=<owner/repo>`.
* Channels: `rc` (default for release candidates such as v0.1.0-rc.2;
  includes final releases) and `stable` (final releases only):
  `uci set mixtile-update.main.channel=stable; uci commit mixtile-update`.
* Nothing is installed automatically. Downgrades and reinstalls need
  `--allow-downgrade`; a release with a different OpenMIOP protocol needs
  `--allow-protocol-change` (upgrade the blades to match).
* A release is only accepted if `clusterbox-firmware.json` names this board
  (`cluster-box-control-V120`) and target (`ramips/mt7620`), the image's
  OpenWrt metadata lists the board, `sysupgrade -T` accepts it and its
  SHA-256 matches both `SHA256SUMS` and the manifest.
* Signatures: if `/etc/mixtile-update/keys/` contains a usign public key (or
  `require_signature` is 1), `SHA256SUMS.sig` must verify. Releases are not
  signed yet (rc releases: checksum only, over HTTPS from GitHub); signing
  is required before a stable v1.0.
* After the reboot, `mixtile-update status` reports whether the running
  firmware is the version and commit that was installed (`last_install`).

### Preserved and replaced on update

| Kept | Replaced |
| --- | --- |
| everything `sysupgrade -l` lists: `/etc/config/*`, users (`/etc/passwd`, `/etc/shadow`, `/etc/group`), SSH host keys, `/etc/sysupgrade.conf` entries, `/lib/upgrade/keep.d` | kernel and root filesystem (all programs, LuCI, packages of the image) |
| `/etc/mixtile-update/keep`: `/etc/mixtile-update/`, `/etc/rc.d/` (enabled services), `/root/.ssh/` (nodectl's key to the blades), `/home/`, `/opt/` (PXE images, Teleport) | other files changed in the overlay, packages installed with `opkg` |

### Recovery

* If the update fails before the reboot, nothing has been written and the
  old firmware keeps running (overlay files that were removed fall back to
  the old firmware's own copies).
* The BMC has no removable card. U-Boot, its environment and the
  factory data sit on the SPI flash (`mtd0`-`mtd2`); kernel, rootfs and
  overlay are on the on-board `mmcblk0` behind the MT7620A SD
  controller. sysupgrade writes the image at sector 16 of `mmcblk0`
  (kernel, then the squashfs rootfs at 10 MiB); partition table and
  overlay (`mmcblk0p3`) stay as they are.
* If the BMC does not come back after a write, restore the factory
  firmware with the reset button: power the box off, hold the BMC's
  reset button, power on and keep holding it until the LED starts
  blinking, then release it. The BMC comes up with Mixtile's factory
  firmware and factory settings; install the wanted ClusterBox release
  again from there (LuCI *Flash Firmware*, see First install). Done on
  the lab unit on 2026-10-14 after a firmware that did not boot. The
  configuration is lost, so back it up before every update:

  ```sh
  sysupgrade -b /tmp/bmc-config.tar.gz   # then copy it off the BMC
  uci export > /tmp/bmc-uci.txt          # readable copy
  ```

  While the BMC is down, the blades lose their LAN as well (their
  Ethernet goes through the BMC's switch). After the restore, set the
  configuration up again (or restore the backup): e.g. the `omi0`
  firewall zone, NAT rules and the NTP server the blades use.
* Blades keep power while the BMC is down or rebooting; their OS keeps
  running. Every blade link resets; blades on pcie-ep-net v0.3 reconnect
  to each other after ~12 s by themselves, and the BMC (`omi0`
  10.20.0.1, the blades' gateway) is back when `omi-rc` loads (~45 s
  after power-on).
* Tested on hardware: v0.1.0-rc.1 installed on the lab BMC (through LuCI
  *Flash Firmware*) boots, `/etc/mixtile-release` and the LuCI login page
  show the build, the OpenMIOP fabric runs with four blades; check,
  download and verification of a release ran on that BMC. Not yet tested:
  `mixtile-update install` (the rc.1 → rc.2 update is the first).

### Serial console (BMC UART)

The controller board has a 3-pin UART header for the MT7620A, next to a
push button and the RTC battery, at the edge of the board. The pin header
(2.54 mm) is not fitted: solder one in to use it. Pinout, left to right
as in Mixtile's photo ([UART of Controller Board, PDF](https://downloads.mixtile.com/blade3/file/UART%20of%20Controller%20Board.pdf)):

| Pin | Connect to (USB-UART adapter, e.g. FT232) |
| --- | --- |
| TX | RX |
| RX | TX |
| GND | GND |

Use a 3.3 V adapter. Mixtile gives the baud rate as **57600** (8N1).
This firmware's kernel command line sets `console=ttyS0,115200`: if the
output turns to garbage after the boot loader, switch the terminal to
115200. Not yet used on the lab unit; it is the way to see why a
firmware does not boot.

```sh
picocom -b 57600 /dev/ttyUSB0      # Ctrl-A Ctrl-B to change the speed
```

## Verify OpenMIOP on the BMC

```sh
cat /etc/mixtile-release
lsmod | grep omi_rc; dmesg | grep omi0            # "push mode", "node N active" per blade
cat /proc/loadavg                                 # ~0 on an idle BMC (v0.1.1 and later)
lspci -d 1d87:4f4d -vv | grep -E 'LnkSta|Region 0'
ip addr show omi0                                 # 10.20.0.1/24, mtu 9000
ping -c3 10.20.0.<blade>
nodectl status --all                              # every blade powered, LINK Gen3 x2
```

If `omi-rc` cannot load, `/etc/init.d/openmiop` starts the helper
instead: `pgrep -l openmiop-rc; tail /tmp/openmiop-rc.log`.

## Build

GitHub Actions (`.github/workflows/clusterbox-firmware.yml`) builds the
firmware for pull requests to `main` and for `v*` tags, unpacks the produced
image and checks its contents (`scripts/clusterbox/verify-firmware.sh`), and
for tags publishes the release. Locally:

```sh
./build.sh feeds_update feeds_install cluster-box-config
make defconfig
MIXTILE_FW_VERSION=$(git describe --tags --always) ./build.sh firmware
./scripts/clusterbox/collect-release.sh release extras
```

Feeds are pinned to commits in `feeds.conf.default`.

## Known limitations (v0.4.0)

* OpenMIOP: the BMC gateway is limited by the MT7620A CPU (~220-245
  Mbit/s each way on Linux 6.12, 10-20 % below 23.05). A BMC reboot
  resets every blade link for ~150 s: on Blade 3 also the M.2 NVMe
  (mixtile-talos recovers it), DRBD 9.3.4 can force-demote a Primary if a
  Secondary holds stale out-of-sync bits
  ([LINBIT/drbd#153](https://github.com/LINBIT/drbd/issues/153), check
  `out-of-sync:` 0 first), and CloudNativePG's primary isolation check
  fails a primary over unless it is turned off for the reboot. Full list:
  [pcie-ep-net](https://github.com/roysbike/pcie-ep-net#known-limitations).
* Packages: kernel modules from the OpenWrt feeds only install when they
  match the firmware's kernel.
* Updates: releases not signed; no A/B rootfs (a firmware that does not
  boot needs the factory restore with the reset button, see Recovery).

---

# Upstream OpenWrt README

![OpenWrt logo](include/logo.png)

OpenWrt Project is a Linux operating system targeting embedded devices. Instead
of trying to create a single, static firmware, OpenWrt provides a fully
writable filesystem with package management. This frees you from the
application selection and configuration provided by the vendor and allows you
to customize the device through the use of packages to suit any application.
For developers, OpenWrt is the framework to build an application without having
to build a complete firmware around it; for users this means the ability for
full customization, to use the device in ways never envisioned.

Sunshine!

## Download

Built firmware images are available for many architectures and come with a
package selection to be used as WiFi home router. To quickly find a factory
image usable to migrate from a vendor stock firmware to OpenWrt, try the
*Firmware Selector*.

* [OpenWrt Firmware Selector](https://firmware-selector.openwrt.org/)

If your device is supported, please follow the **Info** link to see install
instructions or consult the support resources listed below.

## 

An advanced user may require additional or specific package. (Toolchain, SDK, ...) For everything else than simple firmware download, try the wiki download page:

* [OpenWrt Wiki Download](https://openwrt.org/downloads)

## Development

To build your own firmware you need a GNU/Linux, BSD or MacOSX system (case
sensitive filesystem required). Cygwin is unsupported because of the lack of a
case sensitive file system.

### Requirements

You need the following tools to compile OpenWrt, the package names vary between
distributions. A complete list with distribution specific packages is found in
the [Build System Setup](https://openwrt.org/docs/guide-developer/build-system/install-buildsystem)
documentation.

```
binutils bzip2 diff find flex gawk gcc-6+ getopt grep install libc-dev libz-dev
make4.1+ perl python3.6+ rsync subversion unzip which
```

### Quickstart

1. Run `./scripts/feeds update -a` to obtain all the latest package definitions
   defined in feeds.conf / feeds.conf.default

2. Run `./scripts/feeds install -a` to install symlinks for all obtained
   packages into package/feeds/

3. Run `make menuconfig` to select your preferred configuration for the
   toolchain, target system & firmware packages.

4. Run `make` to build your firmware. This will download all sources, build the
   cross-compile toolchain and then cross-compile the GNU/Linux kernel & all chosen
   applications for your target system.

### Related Repositories

The main repository uses multiple sub-repositories to manage packages of
different categories. All packages are installed via the OpenWrt package
manager called `opkg`. If you're looking to develop the web interface or port
packages to OpenWrt, please find the fitting repository below.

* [LuCI Web Interface](https://github.com/openwrt/luci): Modern and modular
  interface to control the device via a web browser.

* [OpenWrt Packages](https://github.com/openwrt/packages): Community repository
  of ported packages.

* [OpenWrt Routing](https://github.com/openwrt/routing): Packages specifically
  focused on (mesh) routing.

* [OpenWrt Video](https://github.com/openwrt/video): Packages specifically
  focused on display servers and clients (Xorg and Wayland).

## Support Information

For a list of supported devices see the [OpenWrt Hardware Database](https://openwrt.org/supported_devices)

### Documentation

* [Quick Start Guide](https://openwrt.org/docs/guide-quick-start/start)
* [User Guide](https://openwrt.org/docs/guide-user/start)
* [Developer Documentation](https://openwrt.org/docs/guide-developer/start)
* [Technical Reference](https://openwrt.org/docs/techref/start)

### Support Community

* [Forum](https://forum.openwrt.org): For usage, projects, discussions and hardware advise.
* [Support Chat](https://webchat.oftc.net/#openwrt): Channel `#openwrt` on **oftc.net**.

### Developer Community

* [Bug Reports](https://bugs.openwrt.org): Report bugs in OpenWrt
* [Dev Mailing List](https://lists.openwrt.org/mailman/listinfo/openwrt-devel): Send patches
* [Dev Chat](https://webchat.oftc.net/#openwrt-devel): Channel `#openwrt-devel` on **oftc.net**.

## License

OpenWrt is licensed under GPL-2.0
