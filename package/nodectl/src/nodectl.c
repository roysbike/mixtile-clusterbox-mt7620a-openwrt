/*
 * nodectl - power, console, status and flashing control for Mixtile Blade3
 * nodes in a Mixtile ClusterBox (MT7620A controller).
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <syslog.h>
#include <time.h>
#include <unistd.h>
#include <uci.h>

#define NODES 4
#define GPIO_LABEL "pca9555"
#define GPIO_FALLBACK_BASE 496
#define RUN_DIR "/var/run/nodectl"
#define LOG_DIR "/var/log/nodectl"
#define LOCK_DIR "/var/lock"
#define FLASH_HELPER "/usr/libexec/nodectl/flash"
#define CONSOLE_BAUD "1500000"
#define SSH_KEY "/root/.ssh/id_dropbear"

/* Pin offsets on the PCA9555 expander, indexed by node (slot 1..4). */
static const int EN_OFF[NODES]       = { 3, 2, 0, 1 };
static const int POWER_OFF[NODES]    = { 12, 13, 15, 14 };
static const int RESET_OFF[NODES]    = { 8, 9, 11, 10 };
static const int PRZ_OFF[NODES]      = { 7, 6, 4, 5 };
static const int TTY_USB[NODES]      = { 1, 2, 3, 0 };
static const int PCI_BUS[NODES]      = { 6, 5, 3, 4 };

enum { EXIT_OK = 0, EXIT_FAIL = 1, EXIT_USAGE = 2, EXIT_BUSY = 3 };

struct opts {
	unsigned mask;
	int json;
	int hard;
	int force;
	int bg;
	int no_reboot;
	int yes;
	int timeout;
	const char *source;
	const char *target;
	char **rest;
	int nrest;
};

static int gpio_base = -1;
static struct uci_context *uci;
static struct uci_package *uci_pkg;

static void die_usage(void);

static void msleep(int ms)
{
	struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
	while (nanosleep(&ts, &ts) && errno == EINTR)
		;
}

static void logmsg(int prio, const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vsyslog(prio, fmt, ap);
	va_end(ap);

	va_start(ap, fmt);
	vfprintf(prio <= LOG_WARNING ? stderr : stdout, fmt, ap);
	va_end(ap);
	fputc('\n', prio <= LOG_WARNING ? stderr : stdout);
}

/* ---------- configuration ---------- */

static void cfg_load(void)
{
	uci = uci_alloc_context();
	if (uci && uci_load(uci, "nodectl", &uci_pkg) != UCI_OK)
		uci_pkg = NULL;
}

static const char *cfg_get(const char *section, const char *option, const char *def)
{
	struct uci_section *s;
	struct uci_option *o;

	if (!uci_pkg)
		return def;
	s = uci_lookup_section(uci, uci_pkg, section);
	if (!s)
		return def;
	o = uci_lookup_option(uci, s, option);
	if (!o || o->type != UCI_TYPE_STRING || !o->v.string[0])
		return def;
	return o->v.string;
}

static int cfg_int(const char *section, const char *option, int def)
{
	const char *v = cfg_get(section, option, NULL);
	char *end;
	long n;

	if (!v)
		return def;
	n = strtol(v, &end, 10);
	return (*end || n < 0) ? def : (int)n;
}

static const char *node_cfg(int node, const char *option, const char *def)
{
	char sec[16];

	snprintf(sec, sizeof(sec), "node%d", node);
	return cfg_get(sec, option, def);
}

/* ---------- GPIO (sysfs) ---------- */

static int read_file(const char *path, char *buf, size_t len)
{
	FILE *fp = fopen(path, "r");

	if (!fp)
		return -1;
	if (!fgets(buf, len, fp)) {
		fclose(fp);
		return -1;
	}
	fclose(fp);
	buf[strcspn(buf, "\n")] = 0;
	return 0;
}

static int write_file(const char *path, const char *val)
{
	FILE *fp = fopen(path, "w");
	int ret;

	if (!fp)
		return -1;
	ret = fputs(val, fp) < 0 ? -1 : 0;
	if (fclose(fp))
		ret = -1;
	return ret;
}

static int find_gpio_base(void)
{
	DIR *d = opendir("/sys/class/gpio");
	struct dirent *de;
	char path[300], buf[64];
	int base = -1;

	if (!d)
		return GPIO_FALLBACK_BASE;
	while ((de = readdir(d))) {
		if (strncmp(de->d_name, "gpiochip", 8))
			continue;
		snprintf(path, sizeof(path), "/sys/class/gpio/%s/label", de->d_name);
		if (read_file(path, buf, sizeof(buf)) || strcmp(buf, GPIO_LABEL))
			continue;
		snprintf(path, sizeof(path), "/sys/class/gpio/%s/base", de->d_name);
		if (!read_file(path, buf, sizeof(buf)))
			base = atoi(buf);
		break;
	}
	closedir(d);
	return base >= 0 ? base : GPIO_FALLBACK_BASE;
}

static int gpio_prepare(int off, const char *idle_dir)
{
	char path[64], num[16], dir[16];
	int gpio = gpio_base + off;
	int i;

	snprintf(path, sizeof(path), "/sys/class/gpio/gpio%d/direction", gpio);
	if (access(path, F_OK)) {
		snprintf(num, sizeof(num), "%d", gpio);
		if (write_file("/sys/class/gpio/export", num))
			return -1;
		for (i = 0; i < 20 && access(path, W_OK); i++)
			msleep(10);
	}
	if (read_file(path, dir, sizeof(dir)))
		return -1;
	if (!strcmp(idle_dir, "in"))
		return strcmp(dir, "in") ? write_file(path, "in") : 0;
	/* Never reconfigure an output: it would drop power on running nodes. */
	return strcmp(dir, "in") ? 0 : write_file(path, idle_dir);
}

static int gpio_get(int off)
{
	char path[64], buf[8];

	snprintf(path, sizeof(path), "/sys/class/gpio/gpio%d/value", gpio_base + off);
	if (read_file(path, buf, sizeof(buf)))
		return -1;
	return buf[0] == '1';
}

static int gpio_set(int off, int val)
{
	char path[64];

	snprintf(path, sizeof(path), "/sys/class/gpio/gpio%d/value", gpio_base + off);
	return write_file(path, val ? "1" : "0");
}

static int gpio_init(void)
{
	int i, err = 0;

	gpio_base = find_gpio_base();
	for (i = 0; i < NODES; i++) {
		err |= gpio_prepare(EN_OFF[i], "low");
		err |= gpio_prepare(POWER_OFF[i], "high");
		err |= gpio_prepare(RESET_OFF[i], "high");
		err |= gpio_prepare(PRZ_OFF[i], "in");
	}
	if (err)
		logmsg(LOG_ERR, "failed to initialise GPIOs (base %d)", gpio_base);
	return err ? -1 : 0;
}

/* ---------- node state ---------- */

static int node_power(int n)
{
	return gpio_get(EN_OFF[n - 1]);
}

static int node_pcie(int n)
{
	char path[64];

	snprintf(path, sizeof(path), "/sys/bus/pci/devices/0000:%02x:00.0", PCI_BUS[n - 1]);
	return access(path, F_OK) == 0;
}

static void node_tty(int n, char *buf, size_t len)
{
	snprintf(buf, len, "/dev/ttyCH343USB%d", TTY_USB[n - 1]);
}

static int ping_start(const char *ip)
{
	pid_t pid;
	int fd;

	if (!ip)
		return -1;
	pid = fork();
	if (pid == 0) {
		fd = open("/dev/null", O_WRONLY);
		if (fd >= 0) {
			dup2(fd, 1);
			dup2(fd, 2);
		}
		execlp("ping", "ping", "-c", "1", "-W", "1", ip, (char *)NULL);
		_exit(127);
	}
	return pid;
}

static int ping_wait(pid_t pid)
{
	int st;

	if (pid <= 0)
		return -1;
	if (waitpid(pid, &st, 0) < 0)
		return -1;
	return WIFEXITED(st) && WEXITSTATUS(st) == 0;
}

static int node_ping(int n)
{
	return ping_wait(ping_start(node_cfg(n, "ipaddr", NULL)));
}

/* ---------- per-node locking and operation state ---------- */

static int lock_fd[NODES + 1] = { -1, -1, -1, -1, -1 };

static int node_lock(int n, const char *op)
{
	char path[64];
	FILE *fp;

	snprintf(path, sizeof(path), LOCK_DIR "/nodectl.node%d", n);
	lock_fd[n] = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
	if (lock_fd[n] < 0 || flock(lock_fd[n], LOCK_EX | LOCK_NB)) {
		logmsg(LOG_WARNING, "node %d is busy", n);
		return -1;
	}
	mkdir(RUN_DIR, 0755);
	snprintf(path, sizeof(path), RUN_DIR "/node%d.op", n);
	if ((fp = fopen(path, "w"))) {
		fprintf(fp, "%s %ld\n", op, (long)time(NULL));
		fclose(fp);
	}
	return 0;
}

static void node_unlock(int n)
{
	char path[64];

	snprintf(path, sizeof(path), RUN_DIR "/node%d.op", n);
	unlink(path);
	if (lock_fd[n] >= 0) {
		close(lock_fd[n]);
		lock_fd[n] = -1;
	}
}

/* Returns the running operation name, or NULL when the node is idle. */
static const char *node_busy(int n, char *buf, size_t len)
{
	char path[64];
	int fd, busy;

	snprintf(path, sizeof(path), LOCK_DIR "/nodectl.node%d", n);
	fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		return NULL;
	busy = flock(fd, LOCK_EX | LOCK_NB) != 0;
	close(fd);
	if (!busy)
		return NULL;
	snprintf(path, sizeof(path), RUN_DIR "/node%d.op", n);
	if (read_file(path, buf, len))
		snprintf(buf, len, "busy");
	buf[strcspn(buf, " ")] = 0;
	return buf;
}

/* ---------- primitive actions ---------- */

static int press(int off, int ms)
{
	if (gpio_set(off, 0))
		return -1;
	msleep(ms);
	return gpio_set(off, 1);
}

static int do_poweron(int n, struct opts *o)
{
	(void)o;
	if (node_power(n) == 1) {
		logmsg(LOG_INFO, "node %d: already powered", n);
		return 0;
	}
	if (gpio_set(POWER_OFF[n - 1], 1) || gpio_set(RESET_OFF[n - 1], 1) ||
	    gpio_set(EN_OFF[n - 1], 1)) {
		logmsg(LOG_ERR, "node %d: failed to enable power", n);
		return -1;
	}
	logmsg(LOG_NOTICE, "node %d: power on", n);
	return 0;
}

static int do_poweroff(int n, struct opts *o)
{
	(void)o;
	if (gpio_set(EN_OFF[n - 1], 0)) {
		logmsg(LOG_ERR, "node %d: failed to cut power", n);
		return -1;
	}
	logmsg(LOG_NOTICE, "node %d: power off", n);
	return 0;
}

static int do_reset(int n, struct opts *o)
{
	(void)o;
	if (node_power(n) != 1) {
		logmsg(LOG_WARNING, "node %d: not powered", n);
		return -1;
	}
	if (press(RESET_OFF[n - 1], cfg_int("global", "reset_ms", 200))) {
		logmsg(LOG_ERR, "node %d: reset failed", n);
		return -1;
	}
	logmsg(LOG_NOTICE, "node %d: reset pulse sent", n);
	return 0;
}

/*
 * Press the power button and wait for the OS to go down. With an IP address
 * configured the node is considered down after several failed pings plus a
 * grace period for the final sync; otherwise the full timeout is awaited.
 */
static int do_shutdown(int n, struct opts *o)
{
	int timeout = o->timeout > 0 ? o->timeout : cfg_int("global", "shutdown_timeout", 90);
	int grace = cfg_int("global", "shutdown_grace", 10);
	int ms = o->force ? cfg_int("global", "force_press_ms", 8000)
			  : cfg_int("global", "press_ms", 500);
	int has_ip = node_cfg(n, "ipaddr", NULL) != NULL;
	int t, misses = 0;

	if (node_power(n) != 1) {
		logmsg(LOG_INFO, "node %d: already off", n);
		return 0;
	}
	logmsg(LOG_NOTICE, "node %d: pressing power button for %d ms", n, ms);
	if (press(POWER_OFF[n - 1], ms)) {
		logmsg(LOG_ERR, "node %d: power button press failed", n);
		return -1;
	}

	for (t = 0; t < timeout; t++) {
		if (has_ip) {
			misses = node_ping(n) == 1 ? 0 : misses + 1;
			if (misses >= 3) {
				logmsg(LOG_INFO, "node %d: network down, waiting %d s grace", n, grace);
				sleep(grace);
				break;
			}
		}
		sleep(1);
	}
	if (t >= timeout)
		logmsg(LOG_WARNING, "node %d: shutdown timeout (%d s) reached", n, timeout);

	if (o->no_reboot && !o->hard)
		return 0;
	return do_poweroff(n, o);
}

static int do_reboot(int n, struct opts *o)
{
	struct opts so = *o;

	so.no_reboot = 0;
	if (o->hard || node_power(n) != 1) {
		if (do_poweroff(n, &so))
			return -1;
	} else if (do_shutdown(n, &so)) {
		return -1;
	}
	sleep(2);
	return do_poweron(n, &so);
}

/* ---------- multi-node execution ---------- */

typedef int (*node_fn)(int, struct opts *);

static int run_one(int n, const char *op, node_fn fn, struct opts *o)
{
	int ret;

	if (node_lock(n, op))
		return EXIT_BUSY;
	ret = fn(n, o) ? EXIT_FAIL : EXIT_OK;
	node_unlock(n);
	return ret;
}

static int run_nodes(const char *op, node_fn fn, struct opts *o, int parallel, int stagger_ms)
{
	pid_t pids[NODES + 1] = { 0 };
	int n, st, ret = EXIT_OK, r;

	for (n = 1; n <= NODES; n++) {
		if (!(o->mask & (1u << n)))
			continue;
		if (!parallel) {
			r = run_one(n, op, fn, o);
			if (r)
				ret = r;
			if (stagger_ms)
				msleep(stagger_ms);
			continue;
		}
		pids[n] = fork();
		if (pids[n] == 0)
			_exit(run_one(n, op, fn, o));
	}
	if (parallel) {
		for (n = 1; n <= NODES; n++) {
			if (pids[n] <= 0)
				continue;
			if (waitpid(pids[n], &st, 0) < 0 || !WIFEXITED(st))
				ret = EXIT_FAIL;
			else if (WEXITSTATUS(st))
				ret = WEXITSTATUS(st);
		}
	}
	return ret;
}

static int single_node(struct opts *o)
{
	int n;

	for (n = 1; n <= NODES; n++)
		if (o->mask == (1u << n))
			return n;
	fprintf(stderr, "exactly one node must be selected with -n N\n");
	exit(EXIT_USAGE);
}

/* Detach so long operations survive the caller (used by the web UI). */
static void background(const char *op, struct opts *o)
{
	char path[64];
	pid_t pid;
	int fd, n = 0;

	if (!o->bg)
		return;
	for (n = 1; n <= NODES; n++)
		if (o->mask & (1u << n))
			break;
	mkdir(LOG_DIR, 0755);
	if (o->mask == (1u << n))
		snprintf(path, sizeof(path), LOG_DIR "/node%d.log", n);
	else
		snprintf(path, sizeof(path), LOG_DIR "/all.log");

	pid = fork();
	if (pid < 0)
		exit(EXIT_FAIL);
	if (pid > 0) {
		printf("{\"started\":\"%s\",\"pid\":%d,\"log\":\"%s\"}\n", op, pid, path);
		exit(EXIT_OK);
	}
	setsid();
	fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
	if (fd >= 0) {
		dup2(fd, 1);
		dup2(fd, 2);
		close(fd);
	}
	fd = open("/dev/null", O_RDONLY);
	if (fd >= 0) {
		dup2(fd, 0);
		close(fd);
	}
}

/* ---------- commands ---------- */

static void json_str(const char *key, const char *val, int comma)
{
	const char *p;

	printf("\"%s\":", key);
	if (!val) {
		printf("null");
	} else {
		putchar('"');
		for (p = val; *p; p++) {
			if (*p == '"' || *p == '\\')
				putchar('\\');
			if ((unsigned char)*p >= 0x20)
				putchar(*p);
		}
		putchar('"');
	}
	if (comma)
		putchar(',');
}

static const char *bool_json(int v)
{
	return v < 0 ? "null" : v ? "true" : "false";
}

static int cmd_status(struct opts *o)
{
	pid_t pids[NODES + 1];
	int n, first = 1, power, pcie, prz, ping;
	char tty[32], opbuf[32], name[16];
	const char *busy, *ip;

	for (n = 1; n <= NODES; n++)
		pids[n] = (o->mask & (1u << n)) && node_power(n) == 1 ?
			ping_start(node_cfg(n, "ipaddr", NULL)) : -1;

	if (o->json)
		printf("{\"nodes\":[");
	else
		printf("%-4s %-10s %-6s %-5s %-4s %-16s %-6s %s\n",
		       "NODE", "NAME", "POWER", "PCIE", "PRZ", "IP", "PING", "STATE");

	for (n = 1; n <= NODES; n++) {
		if (!(o->mask & (1u << n)))
			continue;
		snprintf(name, sizeof(name), "blade%d", n);
		power = node_power(n);
		pcie = node_pcie(n);
		prz = gpio_get(PRZ_OFF[n - 1]);
		ip = node_cfg(n, "ipaddr", NULL);
		ping = ping_wait(pids[n]);
		busy = node_busy(n, opbuf, sizeof(opbuf));
		node_tty(n, tty, sizeof(tty));

		if (o->json) {
			printf("%s{\"id\":%d,", first ? "" : ",", n);
			json_str("name", node_cfg(n, "name", name), 1);
			printf("\"power\":%s,\"pcie\":%s,\"prz\":%d,", bool_json(power),
			       bool_json(pcie), prz);
			json_str("ipaddr", ip, 1);
			printf("\"ping\":%s,", ip ? bool_json(ping > 0) : "null");
			json_str("busy", busy, 1);
			json_str("tty", tty, 0);
			printf(",\"tty_present\":%s,\"autostart\":%s}",
			       bool_json(access(tty, F_OK) == 0),
			       bool_json(atoi(node_cfg(n, "autostart", "1"))));
		} else {
			printf("%-4d %-10s %-6s %-5s %-4d %-16s %-6s %s\n", n,
			       node_cfg(n, "name", name), power == 1 ? "on" : "off",
			       pcie ? "yes" : "no", prz, ip ? ip : "-",
			       !ip ? "-" : ping > 0 ? "ok" : "fail",
			       busy ? busy : power != 1 ? "off" :
			       ping > 0 ? "online" : pcie ? "booting" : "no-link");
		}
		first = 0;
	}
	if (o->json)
		printf("],\"gpio_base\":%d}\n", gpio_base);
	return EXIT_OK;
}

static int cmd_list(void)
{
	char cmd[] = "lspci | grep -E '^0[3-6]:'";
	int ret;

	puts("If no device is found, run 'nodectl rescan' and then 'nodectl list'.");
	ret = system(cmd);
	return ret == 0 ? EXIT_OK : EXIT_FAIL;
}

static int cmd_rescan(void)
{
	if (write_file("/sys/bus/pci/rescan", "1")) {
		logmsg(LOG_ERR, "PCI rescan failed: %s", strerror(errno));
		return EXIT_FAIL;
	}
	return EXIT_OK;
}

static int cmd_console(struct opts *o)
{
	int n = single_node(o);
	char tty[32];

	node_tty(n, tty, sizeof(tty));
	if (access(tty, F_OK)) {
		logmsg(LOG_ERR, "node %d: %s not present", n, tty);
		return EXIT_FAIL;
	}
	execlp("picocom", "picocom", "-q", "-b", CONSOLE_BAUD, tty, (char *)NULL);
	logmsg(LOG_ERR, "picocom: %s", strerror(errno));
	return EXIT_FAIL;
}

static int cmd_ssh(struct opts *o)
{
	int n = single_node(o);
	const char *ip = node_cfg(n, "ipaddr", NULL);
	const char *user = node_cfg(n, "ssh_user", cfg_get("global", "ssh_user", "root"));
	const char *pass = node_cfg(n, "ssh_password", NULL);
	char dest[96];
	char *argv[32];
	int i, a = 0;

	if (!ip) {
		logmsg(LOG_ERR, "node %d: no ipaddr configured (uci set nodectl.node%d.ipaddr=...)", n, n);
		return EXIT_FAIL;
	}
	snprintf(dest, sizeof(dest), "%s@%s", user, ip);
	if (pass) {
		setenv("SSHPASS", pass, 1);
		argv[a++] = "sshpass";
		argv[a++] = "-e";
	}
	argv[a++] = "dbclient";
	/* Host keys change on every reflash; the pci0 link is point-to-point. */
	argv[a++] = "-y";
	argv[a++] = "-y";
	if (!access(SSH_KEY, R_OK)) {
		argv[a++] = "-i";
		argv[a++] = SSH_KEY;
	}
	if (!o->nrest)
		argv[a++] = "-t";
	argv[a++] = dest;
	for (i = 0; i < o->nrest && a < 31; i++)
		argv[a++] = o->rest[i];
	argv[a] = NULL;
	execvp(argv[0], argv);
	logmsg(LOG_ERR, "%s: %s", argv[0], strerror(errno));
	return EXIT_FAIL;
}

static int cmd_flash(struct opts *o)
{
	int n = single_node(o);
	const char *ip = node_cfg(n, "ipaddr", NULL);
	char node[4];
	int st, ret;
	pid_t pid;

	if (!o->source) {
		fprintf(stderr, "flash requires -f <image file or https:// URL>\n");
		return EXIT_USAGE;
	}
	if (!ip) {
		logmsg(LOG_ERR, "node %d: no ipaddr configured", n);
		return EXIT_FAIL;
	}
	if (!o->yes && isatty(0)) {
		char ans[8] = "";
		printf("This will OVERWRITE %s on node %d (%s). Type 'yes' to continue: ",
		       o->target ? o->target : cfg_get("global", "flash_target", "/dev/mmcblk0"),
		       n, ip);
		fflush(stdout);
		if (!fgets(ans, sizeof(ans), stdin) || strncmp(ans, "yes", 3))
			return EXIT_FAIL;
	}

	background("flash", o);
	if (node_lock(n, "flash"))
		return EXIT_BUSY;

	snprintf(node, sizeof(node), "%d", n);
	setenv("NODE", node, 1);
	setenv("NODE_IP", ip, 1);
	setenv("NODE_USER", node_cfg(n, "ssh_user", cfg_get("global", "ssh_user", "root")), 1);
	if (node_cfg(n, "ssh_password", NULL))
		setenv("SSHPASS", node_cfg(n, "ssh_password", NULL), 1);
	setenv("SOURCE", o->source, 1);
	setenv("TARGET", o->target ? o->target : cfg_get("global", "flash_target", "/dev/mmcblk0"), 1);

	logmsg(LOG_NOTICE, "node %d: flashing %s", n, o->source);
	pid = fork();
	if (pid == 0) {
		execl(FLASH_HELPER, FLASH_HELPER, (char *)NULL);
		_exit(127);
	}
	ret = (pid > 0 && waitpid(pid, &st, 0) > 0 && WIFEXITED(st)) ? WEXITSTATUS(st) : EXIT_FAIL;
	logmsg(ret ? LOG_ERR : LOG_NOTICE, "node %d: flash %s", n, ret ? "FAILED" : "finished");
	if (!ret && !o->no_reboot) {
		struct opts h = { .hard = 1 };
		logmsg(LOG_NOTICE, "node %d: power cycling into the new image", n);
		if (do_reboot(n, &h))
			ret = EXIT_FAIL;
	}
	node_unlock(n);
	return ret ? EXIT_FAIL : EXIT_OK;
}

static int cmd_boot(struct opts *o)
{
	const char *action = cfg_get("global", "boot_action", "poweron");
	int n, ret = EXIT_OK;

	(void)o;
	for (n = 1; n <= NODES; n++) {
		if (!atoi(node_cfg(n, "autostart", "1")))
			continue;
		if (!strcmp(action, "cycle")) {
			struct opts h = { .hard = 1 };
			if (run_one(n, "boot", do_reboot, &h))
				ret = EXIT_FAIL;
		} else if (!strcmp(action, "poweron")) {
			if (run_one(n, "boot", do_poweron, o))
				ret = EXIT_FAIL;
		}
		msleep(cfg_int("global", "stagger_ms", 1000));
	}
	return ret;
}

/* ---------- argument parsing ---------- */

static void usage(FILE *fp)
{
	fputs(
	"Usage: nodectl <command> [options]\n"
	"\n"
	"Commands:\n"
	"  status   [-n N|--all] [--json]   power, PCIe, network and job state\n"
	"  list                             list node PCIe devices\n"
	"  rescan                           rescan the PCI bus\n"
	"  poweron  (-n N|--all)            enable power\n"
	"  poweroff (-n N|--all)            cut power immediately (hard)\n"
	"  shutdown (-n N|--all) [--force] [--timeout S] [--no-poweroff]\n"
	"                                   press power button, wait, cut power\n"
	"  reboot   (-n N|--all) [--hard]   graceful (or hard) power cycle\n"
	"  reset    -n N                    pulse the hardware reset line\n"
	"  console  -n N                    serial console (exit: Ctrl-A Ctrl-X)\n"
	"  ssh      -n N [-- command...]    SSH to the node over pci0\n"
	"  flash    -n N -f IMAGE|URL [--target DEV] [--no-reboot] [-y]\n"
	"                                   stream an OS image to the node disk\n"
	"  boot                             apply boot_action (used by init)\n"
	"\n"
	"Common options:\n"
	"  --bg     run in background, log to " LOG_DIR "/nodeN.log\n"
	"\n"
	"Settings: /etc/config/nodectl\n", fp);
}

static void die_usage(void)
{
	usage(stderr);
	exit(EXIT_USAGE);
}

static int parse_node(const char *s)
{
	char *end;
	long n = strtol(s, &end, 10);

	if (*s == 0 || *end || n < 1 || n > NODES) {
		fprintf(stderr, "node number must be 1-%d\n", NODES);
		exit(EXIT_USAGE);
	}
	return (int)n;
}

static void parse_opts(int argc, char **argv, struct opts *o)
{
	int i;

	for (i = 0; i < argc; i++) {
		const char *a = argv[i];
		const char *next = i + 1 < argc ? argv[i + 1] : NULL;

		if (!strcmp(a, "--")) {
			o->rest = &argv[i + 1];
			o->nrest = argc - i - 1;
			return;
		} else if (!strcmp(a, "-n") && next) {
			o->mask |= 1u << parse_node(next);
			i++;
		} else if (!strcmp(a, "--all")) {
			o->mask = 0x1e;
		} else if (!strcmp(a, "--json")) {
			o->json = 1;
		} else if (!strcmp(a, "--hard")) {
			o->hard = 1;
		} else if (!strcmp(a, "--force")) {
			o->force = 1;
		} else if (!strcmp(a, "--bg")) {
			o->bg = 1;
		} else if (!strcmp(a, "--no-reboot") || !strcmp(a, "--no-poweroff")) {
			o->no_reboot = 1;
		} else if (!strcmp(a, "-y") || !strcmp(a, "--yes")) {
			o->yes = 1;
		} else if (!strcmp(a, "--timeout") && next) {
			o->timeout = atoi(next);
			i++;
		} else if (!strcmp(a, "-f") && next) {
			o->source = next;
			i++;
		} else if (!strcmp(a, "--target") && next) {
			o->target = next;
			i++;
		} else {
			fprintf(stderr, "unknown or incomplete option: %s\n", a);
			die_usage();
		}
	}
}

static void need_nodes(struct opts *o)
{
	if (!o->mask) {
		fprintf(stderr, "select nodes with -n N or --all\n");
		die_usage();
	}
}

int main(int argc, char **argv)
{
	struct opts o = { 0 };
	const char *cmd;
	int ret;

	if (argc < 2 || !strcmp(argv[1], "-h") || !strcmp(argv[1], "--help")) {
		usage(argc < 2 ? stderr : stdout);
		return argc < 2 ? EXIT_USAGE : EXIT_OK;
	}
	cmd = argv[1];
	parse_opts(argc - 2, argv + 2, &o);

	openlog("nodectl", 0, LOG_DAEMON);
	cfg_load();
	if (gpio_init() && strcmp(cmd, "list") && strcmp(cmd, "rescan"))
		return EXIT_FAIL;

	if (!strcmp(cmd, "status")) {
		if (!o.mask)
			o.mask = 0x1e;
		ret = cmd_status(&o);
	} else if (!strcmp(cmd, "list")) {
		ret = cmd_list();
	} else if (!strcmp(cmd, "rescan")) {
		ret = cmd_rescan();
	} else if (!strcmp(cmd, "poweron")) {
		need_nodes(&o);
		ret = run_nodes("poweron", do_poweron, &o, 0, cfg_int("global", "stagger_ms", 1000));
	} else if (!strcmp(cmd, "poweroff")) {
		need_nodes(&o);
		ret = run_nodes("poweroff", do_poweroff, &o, 0, 0);
	} else if (!strcmp(cmd, "shutdown")) {
		need_nodes(&o);
		background("shutdown", &o);
		ret = run_nodes("shutdown", do_shutdown, &o, 1, 0);
	} else if (!strcmp(cmd, "reboot")) {
		need_nodes(&o);
		background("reboot", &o);
		ret = run_nodes("reboot", do_reboot, &o, 1, 0);
	} else if (!strcmp(cmd, "reset")) {
		need_nodes(&o);
		ret = run_nodes("reset", do_reset, &o, 0, 0);
	} else if (!strcmp(cmd, "console")) {
		ret = cmd_console(&o);
	} else if (!strcmp(cmd, "ssh")) {
		ret = cmd_ssh(&o);
	} else if (!strcmp(cmd, "flash")) {
		ret = cmd_flash(&o);
	} else if (!strcmp(cmd, "boot")) {
		ret = cmd_boot(&o);
	} else {
		fprintf(stderr, "unknown command: %s\n", cmd);
		die_usage();
		ret = EXIT_USAGE;
	}

	if (uci)
		uci_free_context(uci);
	closelog();
	return ret;
}
