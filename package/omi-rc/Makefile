include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/kernel.mk

# Cluster Box side of openmiop as a kernel module (pcie-ep-net
# drivers/omi-rc): fabric, peer tables and omi0 in push mode, so the
# BMC never reads a blade's BAR. Replaces the userspace openmiop-rc;
# not autoloaded: the openmiop init loads it (helper as fallback).
PKG_NAME:=omi-rc
PKG_VERSION:=0.3.0~rc.1
PKG_RELEASE:=1
PKG_SOURCE_VERSION:=544f1385b1c8c713d6fdbace3347353af6e65ced
PKG_SOURCE:=pcie-ep-net-$(PKG_SOURCE_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/roysbike/pcie-ep-net/tar.gz/$(PKG_SOURCE_VERSION)?
PKG_HASH:=ac0c90d8dc3bc739faaf2ccdf4abf8c910b9813894be7360e6fdb9c176fb5d94
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
