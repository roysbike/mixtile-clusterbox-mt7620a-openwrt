include $(TOPDIR)/rules.mk

# MoCI, a standalone web UI for OpenWrt on ubus (MIT), used as the main
# web UI of the ClusterBox BMC; LuCI stays at /cgi-bin/luci. Installed from
# the sources of the pinned tag (no minification step), without the
# upstream add-on feed (key, opkg feed) and the lighttpd parts.
PKG_NAME:=moci
PKG_VERSION:=0.2.0
PKG_RELEASE:=2

PKG_SOURCE_VERSION:=93e01c2cbccff1545716efb4335903d13359b865
PKG_SOURCE:=moci-$(PKG_SOURCE_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/HudsonGraeme/moci/tar.gz/$(PKG_SOURCE_VERSION)?
PKG_HASH:=ec69b91e2f27529c58c74fbd444f05c7d4380aba464ae3459d28cdc594531272
PKG_BUILD_DIR:=$(BUILD_DIR)/MoCI-$(PKG_SOURCE_VERSION)

PKG_MAINTAINER:=HudsonGraeme
PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

define Package/moci
	CATEGORY:=Custom Component
	TITLE:=MoCI - Modern Configuration Interface for OpenWrt
	DEPENDS:=+rpcd +rpcd-mod-file +jsonfilter
	PKGARCH:=all
endef

define Package/moci/description
	Standalone web interface for OpenWrt (vanilla JavaScript SPA on the
	ubus API), at /moci/. Upstream https://github.com/HudsonGraeme/MoCI.
endef

define Package/moci/conffiles
/etc/config/moci
endef

define Build/Compile
endef

define Package/moci/install
	$(INSTALL_DIR) $(1)/www/moci/icons $(1)/www/moci/js/modules $(1)/www/moci/js/addons
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/moci/index.html $(PKG_BUILD_DIR)/moci/app.css \
		$(PKG_BUILD_DIR)/moci/manifest.json $(1)/www/moci/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/moci/icons/icon-192.png $(PKG_BUILD_DIR)/moci/icons/icon-512.png \
		$(1)/www/moci/icons/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/moci/js/core.js $(1)/www/moci/js/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/moci/js/modules/*.js $(1)/www/moci/js/modules/
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd $(1)/usr/share/rpcd/acl.d $(1)/etc/config
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/files/moci-pkg-call $(1)/usr/libexec/moci-pkg-call
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/files/rpcd-moci $(1)/usr/libexec/rpcd/moci
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/rpcd-acl.json $(1)/usr/share/rpcd/acl.d/moci.json
	$(INSTALL_CONF) ./files/moci.config $(1)/etc/config/moci
endef

define Package/moci/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload
exit 0
endef

$(eval $(call BuildPackage,moci))
