include $(TOPDIR)/rules.mk

PKG_NAME:=mixtile-update
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0

include $(INCLUDE_DIR)/package.mk

define Package/mixtile-update
	CATEGORY:=Custom Component
	TITLE:=Firmware updates for the Mixtile ClusterBox from GitHub Releases
	DEPENDS:=+mixtile-release +uclient-fetch +ca-bundle +jsonfilter +fwtool +usign
	PKGARCH:=all
endef

define Package/mixtile-update/description
	Checks the configured GitHub repository for ClusterBox firmware
	releases (rc or stable channel), downloads and verifies the image
	(board, target, version, OpenMIOP protocol, SHA256SUMS, optional
	usign signature) and installs it with sysupgrade after explicit
	confirmation. CLI: /usr/libexec/mixtile-update.
endef

define Package/mixtile-update/conffiles
/etc/config/mixtile-update
/etc/mixtile-update/keep
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/mixtile-update/install
	$(INSTALL_DIR) $(1)/usr/libexec $(1)/usr/sbin
	$(INSTALL_BIN) ./files/mixtile-update $(1)/usr/libexec/mixtile-update
	$(LN) ../libexec/mixtile-update $(1)/usr/sbin/mixtile-update
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/mixtile-update.config $(1)/etc/config/mixtile-update
	$(INSTALL_DIR) $(1)/etc/mixtile-update/keys
	$(INSTALL_DATA) ./files/keep $(1)/etc/mixtile-update/keep
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/mixtile-update.init $(1)/etc/init.d/mixtile-update
endef

$(eval $(call BuildPackage,mixtile-update))
