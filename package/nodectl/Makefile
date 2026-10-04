include $(TOPDIR)/rules.mk

PKG_NAME:=nodectl
PKG_VERSION:=2.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0

include $(INCLUDE_DIR)/package.mk

define Package/nodectl
	CATEGORY:=Custom Component
	TITLE:=Mixtile ClusterBox Blade3 node control
	DEPENDS:=+libuci +picocom
endef

define Package/nodectl/description
	Power, reset, graceful shutdown, status, serial/SSH console and
	OS image flashing for the Blade3 nodes of a Mixtile ClusterBox.
endef

define Package/nodectl/conffiles
/etc/config/nodectl
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/* $(PKG_BUILD_DIR)/
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_CPPFLAGS) -Wall \
		-o $(PKG_BUILD_DIR)/nodectl $(PKG_BUILD_DIR)/nodectl.c \
		$(TARGET_LDFLAGS) -luci
endef

define Package/nodectl/install
	$(INSTALL_DIR) $(1)/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/nodectl $(1)/bin/
	$(INSTALL_DIR) $(1)/usr/libexec/nodectl
	$(INSTALL_BIN) ./files/flash.sh $(1)/usr/libexec/nodectl/flash
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/nodectl.config $(1)/etc/config/nodectl
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/blade3-boot.init $(1)/etc/init.d/blade3-boot
	$(INSTALL_BIN) ./files/nodectl-console.init $(1)/etc/init.d/nodectl-console
endef

$(eval $(call BuildPackage,nodectl))
