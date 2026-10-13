include $(TOPDIR)/rules.mk

PKG_NAME:=custom-files
PKG_VERSION:=1.1
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-or-later

include $(INCLUDE_DIR)/package.mk

define Package/custom-files
  CATEGORY:=Custom file
  TITLE:=Cluster Box board files (fan control)
  PKGARCH:=all
endef

define Package/custom-files/description
  fan-boot: sets the duty cycle of the two Cluster Box fans (pwm-gpio,
  /sys/class/pwm/pwmchip0 and pwmchip1) from nodectl.global.fan_duty.
endef

define Build/Compile
endef

define Package/custom-files/install
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/fan-boot $(1)/etc/init.d/fan-boot
endef

$(eval $(call BuildPackage,custom-files))
