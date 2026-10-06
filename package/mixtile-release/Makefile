include $(TOPDIR)/rules.mk

PKG_NAME:=mixtile-release
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0
PKG_BUILD_DEPENDS:=openmiop

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/kernel.mk
include $(INCLUDE_DIR)/version.mk

define Package/mixtile-release
	CATEGORY:=Custom Component
	TITLE:=Mixtile ClusterBox firmware identity (/etc/mixtile-release)
	PKGARCH:=all
endef

define Package/mixtile-release/description
	/etc/mixtile-release names the exact firmware build: version (git
	tag), commit, build date, repository, OpenWrt and kernel version,
	board and target, OpenMIOP protocol. Generated at build time.
endef

# A local rebuild after a new commit needs
# "make package/mixtile-release/clean"; CI builds are clean.
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
	./files/gen-release.sh "$(TOPDIR)" \
		"$(STAGING_DIR)/usr/share/openmiop/build-info" \
		"$(VERSION_NUMBER)" "$(LINUX_VERSION)" \
		"$(patsubst DEVICE_%,%,$(call qstrip,$(CONFIG_TARGET_PROFILE)))" \
		"$(BOARD)/$(SUBTARGET)" > $(PKG_BUILD_DIR)/mixtile-release
	cat $(PKG_BUILD_DIR)/mixtile-release
endef

define Package/mixtile-release/install
	$(INSTALL_DIR) $(1)/etc
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/mixtile-release $(1)/etc/mixtile-release
endef

$(eval $(call BuildPackage,mixtile-release))
