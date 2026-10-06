include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-mixtile-update
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-mixtile-update
	CATEGORY:=Custom Component
	TITLE:=LuCI pages for ClusterBox firmware identity and updates
	DEPENDS:=+mixtile-update +luci-base +rpcd +rpcd-mod-file
	PKGARCH:=all
endef

define Package/luci-app-mixtile-update/description
	System > Firmware Update (check, download and verify, install with
	confirmation; all checks in /usr/libexec/mixtile-update) and the
	firmware identity block on Status > Overview.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/luci-app-mixtile-update/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/mixtile
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/mixtile/update.js $(1)/www/luci-static/resources/view/mixtile/
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/status/include
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/status/include/05_mixtile.js $(1)/www/luci-static/resources/view/status/include/
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-mixtile-update.json $(1)/usr/share/luci/menu.d/
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-mixtile-update.json $(1)/usr/share/rpcd/acl.d/
endef

define Package/luci-app-mixtile-update/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	/etc/init.d/rpcd reload
}
exit 0
endef

$(eval $(call BuildPackage,luci-app-mixtile-update))
