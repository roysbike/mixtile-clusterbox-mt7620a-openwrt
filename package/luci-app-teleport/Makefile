include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-teleport
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-teleport
	CATEGORY:=Custom Component
	TITLE:=Teleport agent for the ClusterBox with LuCI configuration
	DEPENDS:=+luci-base +rpcd +rpcd-mod-file +uclient-fetch +ca-bundle +jsonfilter
	PKGARCH:=all
endef

define Package/luci-app-teleport/description
	Runs a Teleport agent that joins a Teleport cluster over an outbound
	tunnel and publishes SSH, web apps, Kubernetes and databases. The
	agent binary is installed from LuCI into /opt/teleport.
endef

define Package/luci-app-teleport/conffiles
/etc/config/teleport
/etc/teleport/
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/luci-app-teleport/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/teleport
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/teleport/*.js $(1)/www/luci-static/resources/view/teleport/
	$(INSTALL_DIR) $(1)/etc/config $(1)/etc/init.d $(1)/etc/teleport
	$(INSTALL_CONF) ./root/etc/config/teleport $(1)/etc/config/teleport
	$(INSTALL_BIN) ./root/etc/init.d/teleport $(1)/etc/init.d/teleport
	$(INSTALL_DIR) $(1)/usr/libexec/teleport $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) ./root/usr/libexec/teleport/install $(1)/usr/libexec/teleport/
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/teleport $(1)/usr/libexec/rpcd/
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-teleport.json $(1)/usr/share/rpcd/acl.d/
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-teleport.json $(1)/usr/share/luci/menu.d/
endef

define Package/luci-app-teleport/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload
exit 0
endef

$(eval $(call BuildPackage,luci-app-teleport))
