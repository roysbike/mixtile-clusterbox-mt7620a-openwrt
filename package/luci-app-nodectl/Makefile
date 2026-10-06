include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-nodectl
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-nodectl
	CATEGORY:=Custom Component
	TITLE:=LuCI interface for Blade3 node control
	DEPENDS:=+nodectl +luci-base +rpcd +rpcd-mod-file +ttyd +prometheus-node-exporter-lua
	PKGARCH:=all
endef

define Package/luci-app-nodectl/description
	Web UI for nodectl: node status, power control, serial and SSH
	consoles in the browser and OS image flashing.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/luci-app-nodectl/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/nodectl
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/nodectl/*.js $(1)/www/luci-static/resources/view/nodectl/
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/nodectl $(1)/usr/libexec/rpcd/
	$(INSTALL_DIR) $(1)/usr/libexec/nodectl
	$(INSTALL_BIN) ./root/usr/libexec/nodectl/term $(1)/usr/libexec/nodectl/
	$(INSTALL_BIN) ./root/usr/libexec/nodectl/textfile $(1)/usr/libexec/nodectl/
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-nodectl.json $(1)/usr/share/rpcd/acl.d/
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-nodectl.json $(1)/usr/share/luci/menu.d/
	$(INSTALL_DIR) $(1)/etc/uci-defaults $(1)/etc/init.d
	$(INSTALL_BIN) ./root/etc/uci-defaults/90-luci-nodectl $(1)/etc/uci-defaults/
	$(INSTALL_BIN) ./root/etc/init.d/nodectl-metrics $(1)/etc/init.d/nodectl-metrics
endef

define Package/luci-app-nodectl/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	( . /etc/uci-defaults/90-luci-nodectl ) && rm -f /etc/uci-defaults/90-luci-nodectl
	/etc/init.d/rpcd reload
	/etc/init.d/ttyd restart
}
exit 0
endef

$(eval $(call BuildPackage,luci-app-nodectl))
