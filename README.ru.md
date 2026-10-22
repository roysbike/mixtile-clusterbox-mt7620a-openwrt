# Прошивка BMC Mixtile Cluster Box (OpenWrt, MT7620A)

[English](README.md) · [Русский](README.ru.md)

**Открытая прошивка OpenWrt для BMC Mixtile Cluster Box.** В Cluster Box
стоят четыре вычислительные платы **Mixtile Blade 3**; его управляющая
плата, **BMC** (MediaTek MT7620A), работает всегда, когда у шасси есть
питание, что бы ни делали блейды. Эта прошивка заменяет прошивку Mixtile
и превращает BMC в единое место управления всем шасси.

**Текущий релиз: [v0.4.0](https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt/releases/tag/v0.4.0)**
(2026-10-20): OpenWrt 25.12.6, Linux 6.12; прошивка BMC для OpenMIOP
Stack v0.6.0 и v0.6.1. Release notes: [v0.4.0](release-notes/v0.4.0.md) ·
[CHANGELOG.md](CHANGELOG.md).

![Веб-интерфейс ClusterBox: страница кластера с шасси спереди](docs/images/web-ui-cluster.jpg)

*Стартовая страница веб-интерфейса (v0.4.0): сверху кластер, под ним
шасси спереди (BMC, PCIe-коммутатор, слоты 1-4 сверху вниз с состоянием,
доступностью за 24 ч и кнопками CONSOLE, LOGS и POWER), рядом здоровье и
трафик.*

## Содержание

* [OpenMIOP Stack](#openmiop-stack)
* [Возможности](#возможности)
* [Оборудование](#оборудование)
* [Где стоит BMC](#где-стоит-bmc)
* [Что в прошивке](#что-в-прошивке)
* [Веб-интерфейс](#веб-интерфейс)
* [Установка](#установка)
* [Обновления](#обновления)
* [Восстановление](#восстановление)
* [Проверка](#проверка)
* [Известные ограничения](#известные-ограничения)
* [Сборка](#сборка)
* [Структура репозитория](#структура-репозитория)

## OpenMIOP Stack

Mixtile поставляет Cluster Box со своей прошивкой BMC и своим сетевым
драйвером для блейдов (MIOP). **OpenMIOP Stack** — независимая открытая
замена из трёх репозиториев, которые выпускаются вместе:

| Репозиторий | Что даёт | Stack v0.6.1 |
| --- | --- | --- |
| [pcie-ep-net](https://github.com/roysbike/pcie-ep-net) | драйвер блейда `openmiop-ep` (`omi0`), модуль BMC `omi-rc`, модули платы Blade 3 | [v0.6.1](https://github.com/roysbike/pcie-ep-net/releases/tag/v0.6.1) |
| [mixtile-talos](https://github.com/roysbike/mixtile-talos) | Talos Linux (Kubernetes) для Blade 3 со встроенным openmiop | [v0.6.1](https://github.com/roysbike/mixtile-talos/releases/tag/v0.6.1) (Talos v1.14.4) |
| **mixtile-clusterbox-mt7620a-openwrt** (этот) | OpenWrt для BMC: питание и консоли блейдов, сторона BMC в openmiop, сетевой край кластера, веб-интерфейс, обновления | [v0.4.0](https://github.com/roysbike/mixtile-clusterbox-mt7620a-openwrt/releases/tag/v0.4.0) (OpenWrt 25.12.6) |

**Версии.** У прошивки свои номера версий. Сторона BMC в openmiop
(`omi-rc` и запасной помощник `openmiop-rc`) собирается в прошивку из
закреплённого коммита pcie-ep-net (`PKG_SOURCE_VERSION` в
`package/omi-rc` и `package/openmiop`). v0.4.0 закрепляет pcie-ep-net
v0.6.0; код BMC в нём такой же, как в v0.6.1, где поменялась только
сторона блейдов. Новая прошивка нужна, только когда меняется `omi-rc` или
помощник.

## Возможности

* **Питание и консоли блейдов.** Включать и выключать каждый блейд,
  сбрасывать его, открывать его последовательную консоль в браузере и
  потом читать каждую загрузку каждого блейда: консоли записываются на
  накопитель BMC.
* **PCIe-фабрика.** BMC — PCIe root complex шасси. Его модуль `omi-rc`
  поднимает **OpenMIOP** — Ethernet между блейдами через внутренний
  PCIe-коммутатор (`omi0`, 7,8-8,0 Гбит/с на поток между блейдами; этот
  трафик остаётся в коммутаторе и не касается BMC).
* **Сетевой край кластера.** Блейды выходят в LAN и интернет через BMC
  (NAT, DHCP, DNS и NTP для блейдов), а сервисы кластера (Kubernetes API,
  ingress) пробрасываются с WAN-адреса BMC.
* **Удалённый доступ** к шасси и кластеру: Tailscale, WireGuard, OpenVPN
  (сервер и исходящие подключения), SSH, агент Teleport и веб-интерфейс
  с защитой, которая откатывает изменения доступа, способные вас
  отрезать.
* **Наблюдение за шасси:** какие блейды работают и сколько (история за
  24 ч), фабрика, uplink, проброшенные сервисы, вентиляторы.
* **Собственные обновления:** BMC проверяет GitHub Releases, показывает,
  что изменилось, и ставит новую прошивку из веб-интерфейса; блейды при
  этом остаются под питанием и продолжают работать.

## Оборудование

* **BMC:** MediaTek MT7620A (MIPS 24KEc, 580 МГц), 256 МБ ОЗУ,
  встроенная eMMC (`mmcblk0`), U-Boot на SPI flash, порт WAN 1 Гбит/с,
  вентиляторы и четыре USB-UART CH343 для консолей блейдов. Имя платы
  `cluster-box-control-V120`, target OpenWrt `ramips/mt7620`. Радио и
  съёмной карты нет.
* **PCIe:** коммутатор ASMedia ASM2824 Gen3 с линком Gen3 x2 к каждому
  слоту и uplink Gen1 x1 к BMC, который является root complex.
* **Блейды:** до четырёх Mixtile Blade 3 (Rockchip RK3588).

## Где стоит BMC

```
        LAN / Интернет
              |
   WAN 1 Гбит/с (DHCP)          удалённый доступ: Tailscale, WireGuard, OpenVPN, Teleport
              |
  +--------------------------------------------------+
  |  BMC  MT7620A, OpenWrt (эта прошивка)            |
  |   веб-интерфейс, SSH, nodectl (питание, консоли) |
  |   NAT, DHCP, DNS, NTP для блейдов, пробросы      |
  |   omi-rc: omi0 10.20.0.1/24, шлюз блейдов        |
  +--------------------------------------------------+
        | PCIe Gen1 x1 (управление + шлюз)
   PCIe-коммутатор ASM2824   (трафик блейд-блейд остаётся здесь)
     |         |         |         |      по Gen3 x2
  слот 1    слот 2    слот 3    слот 4    Blade 3 (RK3588), omi0 10.20.0.x
```

На блейдах работает драйвер endpoint (`openmiop-ep`, ARM64; в эту
прошивку не входит). На BMC работает `omi-rc` (push-режим: блейды сами
записывают своё состояние в память BMC, BMC никогда не читает блейд). Он
находит endpoint'ы (`1d87:4f4d`) за ASM2824, восстанавливает их BAR,
command и MPS, нумерует по слоту, публикует таблицу пиров в BAR каждого
endpoint и подключает сам BMC к `omi0` (10.20.0.1/24) как шлюз блейдов.
`/etc/init.d/openmiop` загружает модуль и запускает помощник в userspace
`openmiop-rc`, только если модуль не загрузился или есть файл
`/etc/openmiop.use-helper` (блейды старше pcie-ep-net v0.3).

## Что в прошивке

| Пакет | Содержимое |
| --- | --- |
| `kmod-omi-rc`, `openmiop` | сторона BMC в OpenMIOP: `omi-rc.ko` (лог: `dmesg \| grep omi0`), `/etc/init.d/openmiop`, запасной помощник `openmiop-rc` и `omi-peek`, из pcie-ep-net |
| `nodectl`, `luci-app-nodectl` | питание блейдов, сброс, последовательные консоли (терминал в браузере), архив консолей, PXE и прошивка; меню LuCI **Cluster** |
| `clusterbox` | настройки BMC (`/etc/config/clusterbox`): доступ к управлению с защитой отката, запасной адрес WAN, DNS и NTP для блейдов, постоянный лог, история конфигурации, журнал доступности узлов, описание кластера, состояние прошивки; бэкенд веб-интерфейса |
| `moci`, `moci-app-clusterbox` | веб-интерфейс (MoCI 0.2.0 с доработками под шасси) со страницами ClusterBox; LuCI остаётся на `/cgi-bin/luci` |
| `mixtile-release` | `/etc/mixtile-release`: версия прошивки (git-тег), коммит, дата сборки, репозиторий, версии OpenWrt и ядра, плата, протокол OpenMIOP, канал обновлений; создаётся сборкой |
| `mixtile-update`, `luci-app-mixtile-update` | проверка, скачивание, проверка подлинности и установка обновлений из GitHub Releases, фоновая проверка |
| `luci-app-teleport` | ставит и запускает агент Teleport (`teleport-<version>-linux-mipsel.gz` из релиза прошивки) |
| Tailscale, WireGuard, OpenVPN | удалённый доступ, со страницами в веб-интерфейсе (NETWORK → TAILSCALE, WIREGUARD, OPENVPN) и в LuCI |

| v0.4.0 | |
| --- | --- |
| OpenWrt / ядро | 25.12.6, Linux 6.12.112 (ramips/mt7620), пакеты через `apk` |
| OpenMIOP | `omi-rc` и `openmiop-rc` из pcie-ep-net v0.6.0 (протокол v4; push-режим, gateway pull, zero-copy) |
| Работает с блейдами на | pcie-ep-net v0.3.0 и новее; gateway pull с v0.4.0, zero-copy с v0.5.0, checksum offload между блейдами с v0.6.0 |
| nodectl | 2.0 с архивом консолей и probe |
| Агент Teleport | 18.10.0 (файл релиза) |

## Веб-интерфейс

Три страницы, каждая настройка в одном месте. По умолчанию:
веб-интерфейс на порту 80, SSH на 22, пользователь `mixtile`
(веб-интерфейс просит сменить заводской пароль); при обновлении
сохраняются уже используемые порты.

| Страница | Вкладки |
| --- | --- |
| **CLUSTER** | стартовая: кластер, шасси спереди, здоровье, трафик |
| **NETWORK** | TOPOLOGY · INTERFACES (с запасным адресом WAN) · FIREWALL (с пробросами портов) · DHCP & DNS (DNS, DHCP и имена блейдов в omi0) · ROUTES · DEVICES · TAILSCALE · WIREGUARD · OPENVPN · DIAGNOSTICS |
| **SYSTEM** | GENERAL (имя, часовой пояс, NTP для блейдов, перезагрузка) · ACCESS (порты и зоны веб/SSH, пароль) · FIRMWARE (обновления с GitHub, ручная загрузка) · BACKUP (с прогрессом и историей конфигурации) · SOFTWARE (apk: установленные, поиск, установка, удаление) · STARTUP · LOGS · SCHEDULED TASKS · SSH KEYS · STORAGE |

**CLUSTER**, стартовая страница:

* Сверху кластер: имя, описание, роль и заметка каждого слота (**EDIT**;
  BMC не видит Kubernetes, поэтому это пишет оператор), общее состояние
  и главные факты (узлы в сети, фабрика, WAN, интернет, Tailscale).
* Шасси спереди: сверху BMC (индикаторы питания, WAN и PCIe-коммутатора,
  обороты вентилятора), коммутатор ASM2824 с uplink, затем слоты 1-4
  сверху вниз. У каждого слота индикаторы питания, PCIe-линка и ответа
  узла на проверочном порту, имя, роль, адрес и линк (Gen3 x2), состояние
  и сколько узел в нём, последние 24 часа полосой и кнопки CONSOLE, LOGS
  и POWER (выключить, перезагрузить, снять питание, включить).
* Рядом: здоровье (узлы, фабрика, интернет, WAN, проброшенные сервисы с
  проверкой каждые 30 с, Tailscale, прошивка, шасси), трафик через BMC за
  5 минут, проброшенные сервисы, загрузка, память и uptime BMC.

Страница опрашивает BMC каждые 5 с, меняет только то, что изменилось, и
останавливается, пока вкладка браузера скрыта.

**NETWORK → TOPOLOGY** рисует сеть шасси такой, какая она сейчас:
интернет и вышестоящий роутер, BMC (адрес WAN, трафик, пробросы, зоны
firewall) и каждую сеть за ним с тем, что в ней есть: `omi0` с четырьмя
блейдами и адресами проброшенных сервисов, Tailscale, сервер OpenVPN и
его клиенты, исходящие OpenVPN и WireGuard.

**NETWORK → OPENVPN:**

* *Сервер*: удалённый доступ к BMC и к сети блейдов 10.20.0.0/24.
  **SET UP THE SERVER** спрашивает адрес, к которому подключаются
  клиенты, порт, протокол и подсеть клиентов; **ADD CLIENT** создаёт
  клиента и скачивает его `.ovpn`; **DELETE** закрывает клиенту доступ.
  Удостоверяющего центра нет: у сервера и каждого клиента свой
  самоподписанный EC-сертификат, каждая сторона закрепляет SHA-256
  отпечаток другой. Ключи лежат в `/etc/openvpn/cb/` и переживают
  обновления. Порт нужно пробросить на BMC на вышестоящем роутере.
* *Подключения к другим VPN-серверам*: загрузите `.ovpn`, BMC подключится
  с ним. Директивы, которые запускают программы (`up`, `script-security`,
  `plugin`, …), отклоняются.

**DHCP в omi0** включён по умолчанию (10.20.0.20-99; блейды, 10.20.0.205
и пул MetalLB 210-219 остаются статическими) и выдаёт BMC как шлюз, DNS
и NTP.

**Логи консолей.** Последовательная консоль каждого блейда (CH343 USB
UART, 1,5 Мбод) записывается `nodectl consoled` на eMMC BMC, файл на
каждую загрузку: `/overlay/log/nodectl/nodeN/YYYYmmdd-HHMMSS.log`, у
каждой строки время BMC. Новый файл начинается при включении или сбросе,
на баннере U-Boot или ядра, или когда время ядра идёт назад. Самые старые
загрузки удаляются сверх `console_archive_mb` (512) или
`console_archive_boots` (100) на блейд (`/etc/config/nodectl`). **LOGS**
в веб-интерфейсе читает, следит, ищет и скачивает их. Обновления прошивки
архив сохраняют.

**Доступность.** `availwatch` каждые 20 с проверяет, есть ли у каждого
блейда питание, PCIe-линк и ответ на проверочном порту, и пишет каждое
изменение в `/overlay/log/clusterbox/availability`.

## Установка

Файлы релиза:

| Файл | Для чего |
| --- | --- |
| `openmiop-<version>-clusterbox-bmc-openwrt-<openwrt>-mipsel-sysupgrade.bin` | прошивка (`<openwrt>` = `25.12.6` с v0.4.0, `23.05` до v0.3.0), sysupgrade пишет её на eMMC BMC |
| `clusterbox-firmware.json` | плата, target, версия, коммит, протокол OpenMIOP, SHA-256 образа (читает `mixtile-update`) |
| `mixtile-update` | инструмент обновления, для первой установки с другой прошивки |
| `teleport-<version>-linux-mipsel.gz` (+ `.sha256`) | агент Teleport для `luci-app-teleport` |
| `SHA256SUMS`, `BUILD-INFO.txt` | контрольные суммы и запись о сборке |

Отдельного factory-образа для этой платы нет.

> [!WARNING]
> Установка перезагружает BMC, а BMC — PCIe root complex: все линки
> блейдов сбрасываются на ~150 с, а с ними весь трафик между блейдами
> (питание блейдов остаётся). С DRBD сначала проверьте, что у каждой
> реплики `out-of-sync:0`
> ([LINBIT/drbd#153](https://github.com/LINBIT/drbd/issues/153)),
> отключите проверку изоляции primary в CloudNativePG и сохраните
> конфигурацию (`sysupgrade -b`, SYSTEM → BACKUP).

**С прошивки Mixtile или OpenWrt 23.05 (v0.3.0 и старше).** OpenWrt 25.12
использует `apk` вместо `opkg` и другую раскладку сети, поэтому это
переустановка с сохранением `/etc/config`:

1. Сохраните конфигурацию и запишите пробросы портов и порты управления.
2. Проверьте образ (`sha256sum -c --ignore-missing SHA256SUMS`) и
   прошейте его через LuCI *System → Backup / Flash Firmware* с
   сохранением настроек. Так лабораторный BMC перешёл на 25.12.
   `sh mixtile-update install-local --yes <image>` по SSH должен работать
   так же и ещё очищает overlay, но с 23.05 его пока не пробовали.
3. После первой загрузки войдите как `mixtile`, проверьте NETWORK →
   FIREWALL (пробросы) и SYSTEM → ACCESS (порты), верните недостающее.

Пакеты, установленные вручную, не сохраняются; поставьте их заново в
SYSTEM → SOFTWARE. На этой плате sysupgrade переписывает только ядро и
rootfs: файлы, изменённые вручную в overlay, продолжают перекрывать новую
прошивку (проверка: `ls /overlay/upper/usr/bin /overlay/upper/etc/init.d`);
`mixtile-update` их удаляет, LuCI — нет.

## Обновления

**Веб-интерфейс.** BMC сам ищет новый релиз (через 5 мин после загрузки,
потом каждые 12 ч; только проверка). Тогда на каждой странице появляется
баннер с release notes; **UPDATE** скачивает, проверяет и ставит
обновление, ждёт BMC и перезагружает страницу. SYSTEM → FIRMWARE
показывает текущую прошивку и последнюю проверку.

**SSH:**

```sh
mixtile-update status
mixtile-update check                 # новейший релиз в канале
mixtile-update download
mixtile-update verify                # плата, target, версия, протокол OpenMIOP, SHA-256
mixtile-update install --yes         # чистит overlay, затем sysupgrade
```

* Источник: GitHub Releases репозитория из `/etc/mixtile-release` (этого);
  поменять: `uci set mixtile-update.main.repository=<owner/repo>`.
* Каналы: `rc` (кандидаты и финальные релизы) и `stable` (только
  финальные): `uci set mixtile-update.main.channel=stable; uci commit mixtile-update`.
* Автоматически ничего не ставится. Откат и переустановка требуют
  `--allow-downgrade`; релиз с другим протоколом OpenMIOP —
  `--allow-protocol-change` (обновите блейды под него). Сборкам для
  разработки (`vX.Y.Z-N-g<sha>`) релизы не предлагаются.
* Релиз принимается, только если `clusterbox-firmware.json` называет эту
  плату и target, `sysupgrade -T` принимает образ, а его SHA-256
  совпадает с `SHA256SUMS` и манифестом. Если в `/etc/mixtile-update/keys/`
  лежит ключ usign, должна сойтись и `SHA256SUMS.sig`; релизы пока не
  подписываются.

| Сохраняется при обновлении | Заменяется |
| --- | --- |
| всё, что показывает `sysupgrade -l` (`/etc/config/*`, пользователи, SSH-ключи хоста), плюс `/etc/mixtile-update/`, `/etc/rc.d/`, `/root/.ssh/`, `/home/`, `/opt/`, архив консолей и логи в `/overlay/log` | ядро и корневая ФС; прочие файлы, изменённые в overlay; пакеты, установленные вручную |

## Восстановление

* Если обновление сорвалось до перезагрузки, ничего не записано и старая
  прошивка продолжает работать.
* U-Boot, его окружение и заводские данные лежат на SPI flash
  (`mtd0`-`mtd2`); ядро, rootfs и overlay — на `mmcblk0`. sysupgrade
  пишет образ с сектора 16 `mmcblk0`; таблица разделов и overlay
  (`mmcblk0p3`) остаются.
* **Если BMC не вернулся,** восстановите заводскую прошивку кнопкой
  сброса: выключите шасси, зажмите кнопку reset BMC, включите питание и
  держите, пока не замигает светодиод, затем отпустите. BMC поднимется с
  заводской прошивкой и настройками Mixtile; оттуда поставьте нужный
  релиз заново. Так сделано на лабораторном шасси 2026-10-14.
  Конфигурация теряется, поэтому сохраняйте её перед каждым обновлением:

  ```sh
  sysupgrade -b /tmp/bmc-config.tar.gz   # потом скопировать с BMC
  uci export > /tmp/bmc-uci.txt          # читаемая копия
  ```

  Пока BMC лежит, блейды тоже теряют LAN.
* Блейды остаются под питанием, пока BMC выключен или перезагружается.
  Блейды на pcie-ep-net v0.3+ переподключаются друг к другу через ~12 с;
  BMC (`omi0` 10.20.0.1, шлюз блейдов) возвращается, когда загрузится
  `omi-rc`, через ~150 с после включения.

**Последовательная консоль BMC.** На управляющей плате есть 3-контактный
разъём UART (TX, RX, GND; 2,54 мм, не распаян — нужно впаять штырьки)
рядом с кнопкой и батарейкой RTC, см.
[UART of Controller Board (PDF)](https://downloads.mixtile.com/blade3/file/UART%20of%20Controller%20Board.pdf)
от Mixtile. Нужен USB-UART адаптер на 3,3 В (TX к RX, RX к TX). Mixtile
указывает 57600 8N1; ядро этой прошивки использует
`console=ttyS0,115200`, так что если после U-Boot пошёл мусор,
переключите терминал на 115200: `picocom -b 57600 /dev/ttyUSB0`
(Ctrl-A Ctrl-B меняет скорость).

## Проверка

```sh
cat /etc/mixtile-release
dmesg | grep omi0                                 # "push mode", "node N active ... gateway pull, zero-copy"
nodectl status --all                              # все блейды включены, LINK Gen3 x2
lspci -d 1d87:4f4d -vv | grep -E 'LnkSta|Region 0'   # читает конфиг blade: не во время перезагрузки blade
ip addr show omi0                                 # 10.20.0.1/24, mtu 9000
ping -c3 10.20.0.<blade>
```

Если `omi-rc` не загружается, `/etc/init.d/openmiop` запускает помощник:
`pgrep -l openmiop-rc; tail /tmp/openmiop-rc.log`.

## Известные ограничения

* **Скорость шлюза:** BMC пересылает трафик между блейдами и LAN своим
  процессором: ~220-245 Мбит/с на OpenWrt 25.12 (на 10-20 % ниже 23.05).
  На трафик между блейдами это не влияет.
* **Перезагрузка BMC сбрасывает фабрику** на ~150 с: все линки блейдов и,
  на Blade 3, M.2 NVMe (mixtile-talos его восстанавливает). См.
  предупреждение в разделе [Установка](#установка).
* **Обновления:** релизы пока не подписываются (контрольные суммы по
  HTTPS с GitHub); нет A/B корневой ФС, поэтому не загрузившаяся прошивка
  требует восстановления заводской.
* **Пакеты:** модули ядра из фидов OpenWrt ставятся, только если
  совпадают с ядром прошивки.
* **Пока не проверено:** `mixtile-update install` с OpenWrt 23.05; сервер
  OpenVPN с реальными клиентами в лабораторной сети.

## Сборка

GitHub Actions (`.github/workflows/clusterbox-firmware.yml`, self-hosted
runner) собирает прошивку для pull request'ов в `v120` и тегов `v*`,
распаковывает образ и проверяет содержимое
(`scripts/clusterbox/verify-firmware.sh`), а для тега публикует релиз с
агентом Teleport. `.github/workflows/main.yml` — исходная ручная сборка
Mixtile. Локально:

```sh
./build.sh feeds_update feeds_install cluster-box-config
make defconfig
MIXTILE_FW_VERSION=$(git describe --tags --always) ./build.sh firmware
./scripts/clusterbox/collect-release.sh release extras
```

Фиды закреплены на коммитах в `feeds.conf.default`. Пакеты OpenMIOP
скачивают pcie-ep-net на коммите из своего `PKG_SOURCE_VERSION`.

## Структура репозитория

Дерево — полный исходный код OpenWrt 25.12 (`target/`, `package/`,
`tools/`, `toolchain/`, `include/`, …; см.
[руководство разработчика OpenWrt](https://openwrt.org/docs/guide-developer/start)).
Что относится именно к Cluster Box:

| Путь | Содержимое |
| --- | --- |
| `package/omi-rc/`, `package/openmiop/` | сторона BMC в OpenMIOP, закреплена на коммите pcie-ep-net |
| `package/nodectl/`, `package/luci-app-nodectl/` | питание блейдов, консоли, архив консолей |
| `package/clusterbox/` | настройки BMC, доступность, бэкенд веб-интерфейса |
| `package/moci/`, `package/moci-app-clusterbox/` | веб-интерфейс |
| `package/mixtile-update/`, `package/luci-app-mixtile-update/`, `package/mixtile-release/` | обновления и идентификация прошивки |
| `package/luci-app-teleport/` | агент Teleport |
| `config/BoardConfig/cluster-box-config`, `build.sh` | конфигурация сборки Cluster Box и точка входа сборки |
| `other-files/` | файлы, которые копируются в образ как есть (`fstab`, `pci.ids`) |
| `scripts/clusterbox/`, `scripts/build-teleport-mipsel.sh` | сборка релиза, проверка образа, сборка агента Teleport |
| `release-notes/` | release notes по версиям ([шаблон](release-notes/TEMPLATE.md)) |

Лицензия: GPL-2.0, как у OpenWrt ([COPYING](COPYING), [LICENSES/](LICENSES/)).
