# Прошивка BMC Mixtile ClusterBox (OpenWrt, MT7620A)

[English](README.md) · [Русский](README.ru.md)

Прошивка для управляющего контроллера (BMC) **Mixtile Cluster Box**:
OpenWrt 23.05 (ядро 5.15.150) на MediaTek MT7620A. В ней управление
четырьмя слотами Blade 3 (`nodectl` и LuCI), сторона BMC для **OpenMIOP**
(Ethernet между блейдами по внутренней PCIe-фабрике: модуль ядра `omi-rc`,
программа `openmiop-rc` как запасной вариант), файл с версией прошивки и
обновление из GitHub Releases.

Текущий релиз: **v0.3.0** (OpenMIOP Stack v0.5.0: gateway pull с
zero-copy — трафик из LAN к блейдам примерно в 3 раза быстрее, чем в
v0.1; flow offloading включён по умолчанию) — см.
[release notes](release-notes/v0.3.0.md), [CHANGELOG.md](CHANGELOG.md) и
[страницу релиза](https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt/releases/tag/v0.3.0).

## Оборудование и для кого это

**Mixtile Cluster Box** — компактное шасси на четыре платы **Mixtile
Blade 3**. Внутри:

* управляющий контроллер (BMC): MediaTek MT7620A (MIPS) с OpenWrt. Он
  включает, выключает и перезагружает блейды, даёт доступ к их
  последовательным консолям и служит корневым комплексом PCIe всего шасси;
* PCIe-коммутатор ASMedia ASM2824 (Gen3): линк Gen3 x2 к каждому слоту и
  линк Gen1 x1 к BMC.

**Mixtile Blade 3** — вычислительная плата на Rockchip RK3588
(4× Cortex-A76 + 4× Cortex-A55) с eMMC и слотом M.2 NVMe. Её контроллер
PCIe 3.0 x4 разделён пополам: линии 0-1 идут к коммутатору Cluster Box,
линии 2-3 — к NVMe. Blade 3 работает и сама по себе, без Cluster Box.

Mixtile поставляет шасси со своей прошивкой BMC и своим сетевым
драйвером для блейдов (MIOP). **OpenMIOP Stack** — независимая открытая
замена для владельцев Cluster Box с платами Blade 3 (или отдельной
Blade 3), которым нужно:

| Что нужно | Репозиторий |
| --- | --- |
| Ethernet между блейдами через PCIe-коммутатор (`omi0`, ~5 Гбит/с на поток, ~25 Гбит/с при четырёх отправителях) | [pcie-ep-net](https://github.com/roysbike/pcie-ep-net) |
| Talos Linux (Kubernetes) на Blade 3, в Cluster Box или отдельно | [mixtile-talos](https://github.com/roysbike/mixtile-talos) |
| Свежий OpenWrt на BMC: питание и консоли блейдов, обновление прошивки, сторона OpenMIOP на BMC | [mixtile-clusterbox-mt7620a-openwrt](https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt) (этот репозиторий) |


## Что в прошивке

| Пакет | Что делает |
| --- | --- |
| `kmod-omi-rc` | `omi-rc.ko`, сторона OpenMIOP на BMC в push-режиме (журнал: `dmesg \| grep omi0`) |
| `openmiop` | `/etc/init.d/openmiop`: грузит `omi-rc`, при неудаче запускает `openmiop-rc` |
| `nodectl`, `luci-app-nodectl` | питание, сброс, консоль, прошивка и PXE блейдов; меню LuCI **Cluster** |
| `mixtile-update`, `luci-app-mixtile-update` | поиск, загрузка, проверка SHA-256 и установка обновлений; LuCI **System → Firmware Update** |
| `mixtile-release` | `/etc/mixtile-release`: версия, коммит, дата сборки, протокол OpenMIOP |

### Логи консолей и доступность нод (порт на 25.12)

Последовательная консоль каждого блейда (USB-UART CH343 на BMC,
1,5 Мбод) записывается `nodectl consoled` на eMMC BMC, по файлу на каждую
загрузку блейда: `/overlay/log/nodectl/nodeN/YYYYmmdd-HHMMSS.log` (длинная
загрузка продолжается в частях `.pNNN.log` по `console_archive_part_mb`),
каждая строка с временем BMC. Новый файл начинается при включении или
сбросе через `nodectl`, по баннеру U-Boot или ядра и когда отметки
времени ядра идут назад (блейд перезагрузился сам). Самые старые
загрузки удаляются сверх `console_archive_mb` (512) или
`console_archive_boots` (100) на блейд; настройки в `/etc/config/nodectl`.
Архив лежит вне upper-каталога overlay, обновление прошивки его не трогает.

`availwatch` (пакет `clusterbox`) каждые 20 с проверяет, есть ли у блейда
питание, PCIe-линк и отвечает ли он на проверочный порт, и записывает
каждое изменение в `/overlay/log/clusterbox/availability`.

В веб-интерфейсе (**Cluster → Overview**) в карточке каждой ноды полоса
за 24 часа (online, загрузка, нет PCIe-линка, выключена, нет данных, пока
BMC не работал), доля времени online и сколько нода в текущем состоянии;
то же время показано на карте. **LOGS** открывает лог консоли ноды:
выбор загрузки, чтение с первой строки, слежение за новым выводом, поиск
по всей загрузке, скачивание.

## Установка и обновление

Первая установка со старой прошивки Cluster Box — `mixtile-update
install-local`, см. [First install](README.md#first-install-from-older-clusterbox-firmware).
С v0.1.0-rc.1 и новее:

```sh
mixtile-update check && mixtile-update download && mixtile-update verify && mixtile-update install --yes
```

или LuCI **System → Firmware Update**. Настройки, `/root/.ssh`, `/home` и
`/opt` сохраняются.

> [!WARNING]
> Обновление перезагружает BMC, а BMC — корневой комплекс PCIe: линки всех
> блейдов сбрасываются. Блейды на mixtile-talos v0.3.0 сами
> переподключаются друг к другу за ~12 с и восстанавливают NVMe. После
> обновления проверьте `nodectl status --all`, etcd и DRBD.

## Проверка

```sh
cat /etc/mixtile-release
lsmod | grep omi_rc; dmesg | grep omi0            # "push mode", "node N active" для каждого блейда
nodectl status --all                              # все блейды включены, LINK Gen3 x2
ping -c3 10.20.0.<блейд>
```

Сборка, восстановление через microSD и известные ограничения — в
[README.md](README.md).
