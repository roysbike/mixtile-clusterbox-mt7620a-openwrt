include $(TOPDIR)/rules.mk

# Cluster Box side of openmiop (Ethernet over the PCIe fabric), built
# from a pinned pcie-ep-net commit: the init script, which loads the
# omi-rc module (kmod-omi-rc) and falls back to the userspace helper
# (sysfs PCI config/resource files and a TAP device, needs kmod-tun).
PKG_NAME:=openmiop
PKG_VERSION:=0.3.0
PKG_RELEASE:=1
PKG_SOURCE_VERSION:=a4bc7ef7833ed8500787526d20f6bbc16e69016f
PKG_SOURCE:=pcie-ep-net-$(PKG_SOURCE_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/roysbike/pcie-ep-net/tar.gz/$(PKG_SOURCE_VERSION)?
PKG_HASH:=25e8511ed94c8da7ddef05fb4243b552f11e0ba4e6d9257a619573c83a2b5530
PKG_BUILD_DIR:=$(BUILD_DIR)/pcie-ep-net-$(PKG_SOURCE_VERSION)
PKG_LICENSE:=GPL-2.0-or-later
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

# Ship the binaries as built (about 12 KiB each): sstrip drops the
# .MIPS.abiflags section that shows they are soft-float.
RSTRIP:=:
STRIP:=:

define Package/openmiop
	CATEGORY:=Custom Component
	TITLE:=openmiop root-complex helper for the Cluster Box PCIe fabric
	URL:=https://github.com/roysbike/pcie-ep-net
	DEPENDS:=@TARGET_ramips_mt7620 +kmod-tun
endef

define Package/openmiop/description
	openmiop-rc finds the Blade 3 endpoints behind the ASM2824 switch,
	restores their BAR/command/MPS settings, numbers them by slot,
	publishes the peer table (OpenMIOP protocol v4), re-enumerates from
	the PCIe root port when a blade has no BAR address, and bridges the
	BMC onto omi0 (10.20.0.1/24). Includes omi-peek for diagnostics.
endef

# The upstream Makefile builds freestanding MIPS32 soft-float binaries
# (no libc); only the compiler comes from the OpenWrt toolchain.
define Build/Compile
	$(MAKE) -C $(PKG_BUILD_DIR)/userspace CC="$(TARGET_CC_NOCACHE)"
endef

# Protocol version and source commit for mixtile-release.
define Build/InstallDev
	$(INSTALL_DIR) $(1)/usr/share/openmiop
	./files/build-info.sh $(PKG_BUILD_DIR)/drivers/openmiop/openmiop.h \
		$(PKG_VERSION) $(PKG_SOURCE_VERSION) > $(1)/usr/share/openmiop/build-info
endef

define Package/openmiop/install
	$(INSTALL_DIR) $(1)/usr/bin $(1)/etc/init.d
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/userspace/openmiop-rc $(1)/usr/bin/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/userspace/omi-peek $(1)/usr/bin/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/scripts/openmiop.init $(1)/etc/init.d/openmiop
endef

$(eval $(call BuildPackage,openmiop))
