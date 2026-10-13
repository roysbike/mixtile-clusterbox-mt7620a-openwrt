<!--
Release notes for one firmware tag: copy to release-notes/vX.Y.Z[-rc.N].md.
CI publishes this file as the GitHub release text, so it is read on the
release page: short sections, the most important first, tables over
prose, commands in code blocks. Keep CHANGELOG.md the full record; here
only what someone updating a Cluster Box needs.
-->

# ClusterBox BMC firmware vX.Y.Z

**In one sentence:** what this release is for.

> [!WARNING]
> Updating reboots the BMC, and the BMC is the PCIe root complex: every
> blade loses omi0 for the length of the reboot. (Keep or adjust.)

## What's new

- **Headline change.** One or two lines: what it does for the user.
- ...

Full list: [CHANGELOG.md](https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt/blob/vX.Y.Z/CHANGELOG.md#xyz).

## Inside

| Component | Version |
| --- | --- |
| OpenWrt / kernel | 23.05, Linux 5.15.150 (ramips/mt7620) |
| OpenMIOP helper (openmiop-rc) | pcie-ep-net `<tag or commit>`, protocol v4 |
| nodectl / LuCI Cluster | `<package version>` |
| Works with blades on | pcie-ep-net `<versions>` |

## Download

| You want to | File |
| --- | --- |
| Update from the previous release | LuCI *System → Firmware Update*, or see *Update* |
| Install on other ClusterBox firmware | `openmiop-…-sysupgrade.bin` + `clusterbox-firmware.json` + `mixtile-update` |
| Check what you downloaded | `SHA256SUMS`, `BUILD-INFO.txt` |

## Update

```sh
mixtile-update check && mixtile-update download && mixtile-update verify && mixtile-update install --yes
```

After the reboot:

```sh
cat /etc/mixtile-release     # FIRMWARE_VERSION is this release
nodectl status --all         # every blade powered, LINK as before
```

## Known issues

- ...

## Tested

- What ran on the lab Cluster Box, and what did not.
