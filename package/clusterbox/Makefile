include $(TOPDIR)/rules.mk

PKG_NAME:=clusterbox
PKG_VERSION:=1.0
PKG_RELEASE:=9
PKG_LICENSE:=GPL-2.0

include $(INCLUDE_DIR)/package.mk

define Package/clusterbox
	CATEGORY:=Custom Component
	TITLE:=ClusterBox BMC management backend (network layout, access, services, config history)
	DEPENDS:=+rpcd +nodectl +jsonfilter +openssl-util
	PKGARCH:=all
endef

define Package/clusterbox/description
	Network layout of the ClusterBox BMC (wan + openmiop, no LAN bridge),
	management access (LuCI/SSH/console ports and interfaces, port
	forwards to the cluster), services for the blades (DNS, NTP), WAN
	fallback address, persistent log, configuration history with
	rollback, and the cluster topology data; ubus object "clusterbox"
	for the web UI (moci-app-clusterbox).
endef

define Package/clusterbox/conffiles
/etc/config/clusterbox
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/clusterbox/install
	$(CP) ./root/* $(1)/
endef

define Package/clusterbox/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload
exit 0
endef

$(eval $(call BuildPackage,clusterbox))
