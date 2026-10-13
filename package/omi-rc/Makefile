include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/kernel.mk

# Cluster Box side of openmiop as a kernel module (pcie-ep-net
# drivers/omi-rc): fabric, peer tables and omi0 in push mode, so the
# BMC never reads a blade's BAR. Replaces the userspace openmiop-rc;
# not autoloaded: the openmiop init loads it (helper as fallback).
PKG_NAME:=omi-rc
PKG_VERSION:=0.5.0
PKG_RELEASE:=2
PKG_SOURCE_VERSION:=ebc58822ab0332d2ba33cec2a5be2f3ba02d24d6
PKG_SOURCE:=pcie-ep-net-$(PKG_SOURCE_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/roysbike/pcie-ep-net/tar.gz/$(PKG_SOURCE_VERSION)?
PKG_HASH:=cb82ad4463909299516d9c5c41eb5308201111ecc15a5629865dc9a1581ba08c
PKG_BUILD_DIR:=$(KERNEL_BUILD_DIR)/pcie-ep-net-$(PKG_SOURCE_VERSION)
PKG_LICENSE:=GPL-2.0-or-later
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

define KernelPackage/omi-rc
  SUBMENU:=Network Devices
  TITLE:=openmiop root complex for the Cluster Box (push mode)
  URL:=https://github.com/roysbike/pcie-ep-net
  DEPENDS:=@TARGET_ramips_mt7620 @PCI_SUPPORT
  FILES:=$(PKG_BUILD_DIR)/drivers/omi-rc/omi-rc.ko
endef

define KernelPackage/omi-rc/description
  Kernel side of OpenMIOP on the Cluster Box BMC: watches the links of
  the ASM2824 downstream ports, restores the Blade 3 endpoints, makes
  them push-mode offers, publishes the peer table and provides omi0.
  It never reads a blade's BAR. Needs openmiop-ep with push mode on
  the blades; do not run it together with openmiop-rc.
endef

define Build/Compile
	$(KERNEL_MAKE) M="$(PKG_BUILD_DIR)/drivers/omi-rc" modules
endef

$(eval $(call KernelPackage,omi-rc))
