include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-clusterbox
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-clusterbox
	CATEGORY:=Custom Component
	TITLE:=ClusterBox BMC management (network layout, access, services, config history)
	DEPENDS:=+luci-base +rpcd +rpcd-mod-file +nodectl
	PKGARCH:=all
endef

define Package/luci-app-clusterbox/description
	Network layout of the ClusterBox BMC (wan + openmiop, no LAN bridge),
	management access (LuCI/SSH/console ports and interfaces, port
	forwards to the cluster), services for the blades (DNS, NTP), WAN
	fallback address, persistent log, configuration history with
	rollback, and the cluster topology on Status > Overview.
endef

define Package/luci-app-clusterbox/conffiles
/etc/config/clusterbox
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/luci-app-clusterbox/install
	$(INSTALL_DIR) $(1)/www
	$(CP) ./htdocs/* $(1)/www/
	$(CP) ./root/* $(1)/
endef

define Package/luci-app-clusterbox/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	/etc/init.d/rpcd reload
}
exit 0
endef

$(eval $(call BuildPackage,luci-app-clusterbox))
