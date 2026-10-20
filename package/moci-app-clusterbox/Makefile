include $(TOPDIR)/rules.mk

PKG_NAME:=moci-app-clusterbox
PKG_VERSION:=1.0.0
PKG_RELEASE:=9
PKG_LICENSE:=GPL-2.0

include $(INCLUDE_DIR)/package.mk

define Package/moci-app-clusterbox
	CATEGORY:=Custom Component
	TITLE:=MoCI add-on: ClusterBox (topology, nodes, access, services, history, Tailscale)
	DEPENDS:=+moci +clusterbox +luci-app-nodectl
	PKGARCH:=all
endef

define Package/moci-app-clusterbox/description
	The CLUSTER section of MoCI and a topology card on its dashboard:
	live map Internet - gateway - BMC - PCIe switch - blades, node power
	and consoles (ubus nodectl), management access with confirmed apply,
	services for the blades, configuration history (diff, download,
	guarded restore) and Tailscale. The web root opens it; LuCI gets a
	menu entry "ClusterBox UI" that leads to it.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/moci-app-clusterbox/install
	$(INSTALL_DIR) $(1)/www/moci/js/addons/cluster
	$(INSTALL_DATA) ./files/manifest.json ./files/addon.js ./files/style.css $(1)/www/moci/js/addons/cluster/
	$(INSTALL_DATA) ./files/cluster.html $(1)/www/
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/90-moci-clusterbox $(1)/etc/uci-defaults/
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/clusterbox $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/luci/moci.js $(1)/www/luci-static/resources/view/clusterbox/
	$(INSTALL_DATA) ./files/luci/moci-app-clusterbox.json $(1)/usr/share/luci/menu.d/
endef

$(eval $(call BuildPackage,moci-app-clusterbox))
