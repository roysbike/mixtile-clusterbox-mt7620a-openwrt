// ClusterBox add-on for MoCI: cluster topology and nodes, management
// access, services for the blades, configuration history, Tailscale.
// Backend: ubus objects "clusterbox" (package clusterbox) and "nodectl".

// The cluster page has no tabs any more; its old tabs moved to the
// network and system pages (old links still work).
const MOVED = {
	access: '/system/admin',
	services: '/network/dhcp',
	history: '/system/backup',
	tailscale: '/network/tailscale',
	firmware: '/system/upgrade'
};
const POLL_MS = 5000;
// How often an open page looks at the result of the BMC's own background
// release check (mixtile-update watch); this reads local state only.
const FW_POLL_MS = 15 * 60 * 1000;
const RELEASE_RE = /^v\d+\.\d+\.\d+(-rc\.\d+)?$/;
const AVAIL_MS = 60000;
// Console log viewer: bytes per request, chunks kept in the view.
const LOG_CHUNK = 131072;
const LOG_KEEP = 24;
const AV_TEXT = {
	online: 'online',
	booting: 'booting',
	nolink: 'no PCIe link',
	off: 'powered off',
	busy: 'nodectl job',
	unknown: 'no data'
};

export default class ClusterBoxAddon {
	constructor(core) {
		this.core = core;
		this.timer = null;
		this.prev = null;
		this.core.registerRoute('/cluster', (path, sub) => this.route(sub || []));
	}

	async init() {
		this.checkPassword();
		this.fwWatch();
		// After an access change the browser lands on the new address with
		// ?cbconfirm=<token>; confirming keeps the change.
		const params = new URLSearchParams(window.location.search);
		const token = params.get('cbconfirm');
		if (!token) return;
		params.delete('cbconfirm');
		const qs = params.toString();
		window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
		try {
			await this.call('confirm', { token });
			this.core.showToast('New management settings confirmed', 'success');
		} catch (e) {
			this.core.showToast(`Confirmation failed: ${e.message}`, 'error');
		}
	}

	// The factory password of mixtile (mixtile/mixtile): ask for a new one
	// at login. LATER hides the dialog until the next login.
	async checkPassword() {
		try {
			const st = await this.call('password_state');
			if (!st.factory || sessionStorage.getItem('cb-pw-later')) return;
		} catch {
			return;
		}
		const m = document.createElement('div');
		m.className = 'modal';
		m.innerHTML = `
			<div class="modal-backdrop"></div>
			<div class="modal-content">
				<div class="modal-header"><h3 class="modal-title">CHANGE THE DEFAULT PASSWORD</h3></div>
				<div class="modal-body">
					<p class="cb-muted" style="margin-bottom:16px">The user mixtile still has the factory password. It is used for the web UI,
					SSH and sudo; root has no password (SSH with a key only).</p>
					<div class="form-group"><label class="form-label">NEW PASSWORD</label>
						<input type="password" class="form-input" id="cb-pw-new" autocomplete="new-password"></div>
					<div class="form-group"><label class="form-label">REPEAT</label>
						<input type="password" class="form-input" id="cb-pw-rep" autocomplete="new-password"></div>
				</div>
				<div class="modal-footer">
					<button class="action-btn" id="cb-pw-later">LATER</button>
					<button class="action-btn" id="cb-pw-save">CHANGE PASSWORD</button>
				</div>
			</div>`;
		document.body.appendChild(m);
		m.querySelector('#cb-pw-later').onclick = () => {
			try {
				sessionStorage.setItem('cb-pw-later', '1');
			} catch {}
			m.remove();
		};
		m.querySelector('#cb-pw-save').onclick = async () => {
			const pw = m.querySelector('#cb-pw-new').value;
			if (pw.length < 8) return this.core.showToast('At least 8 characters', 'error');
			if (pw !== m.querySelector('#cb-pw-rep').value) return this.core.showToast('Passwords do not match', 'error');
			if (pw === 'mixtile') return this.core.showToast('Choose a password other than the factory one', 'error');
			try {
				const [status, res] = await this.core.ubusCall('moci', 'setPassword', { username: 'mixtile', password: pw });
				if (status !== 0 || !res?.result) throw new Error('setPassword failed');
				if (this.core.getSavedCredentials?.()) this.core.saveCredentials('mixtile', pw);
				this.core.showToast('Password changed', 'success');
				m.remove();
			} catch (e) {
				this.core.showToast(`Failed to change the password: ${e.message}`, 'error');
			}
		};
	}

	// Two tabs on the MoCI network page.
	// Tabs and sections on the MoCI network and system pages.
	getExtensions() {
		const sec = (id, page, tab, render, position = 'bottom') => ({ id, page, tab, position, render });
		return {
			'network:tab': [
				{ id: 'topology', label: 'TOPOLOGY', before: 'interfaces', render: el => this.renderTopology(el) },
				{ id: 'tailscale', label: 'TAILSCALE', before: 'vpn', render: el => this.loadTailscale(el) },
				{ id: 'openvpn', label: 'OPENVPN', after: 'vpn', render: el => this.renderOpenvpn(el) }
			],
			'tab:section': [
				sec('cb-wan', 'network', 'interfaces', el => this.loadServices(el, ['wan'])),
				sec('cb-dns', 'network', 'dhcp', el => this.loadServices(el, ['dns']), 'top'),
				sec('cb-time', 'system', 'general', el => this.loadServices(el, ['ntp'])),
				sec('cb-access', 'system', 'admin', el => this.loadAccess(el), 'top'),
				sec('cb-firmware', 'system', 'upgrade', el => this.loadFirmware(el), 'top'),
				sec('cb-history', 'system', 'backup', el => this.loadHistory(el)),
				sec('cb-history-set', 'system', 'backup', el => this.loadServices(el, ['history'])),
				sec('cb-software', 'system', 'software', el => this.loadSoftware(el)),
				sec('cb-log', 'system', 'logs', el => this.loadServices(el, ['log']), 'top')
			]
		};
	}

	cleanup() {
		this.stopPolling();
		this.closeLogs();
		clearInterval(this.fwTimer);
		clearTimeout(this.topoTimer);
	}

	// ---- helpers ---------------------------------------------------------

	esc(v) {
		return this.core.escapeHtml(v == null ? '' : String(v));
	}

	async call(method, params = {}, object = 'clusterbox', timeout = 20000) {
		const res = await this.core.ubusCall(object, method, params, { timeout });
		const [status, data] = Array.isArray(res) ? res : [res, null];
		if (status !== 0) throw new Error(`${object}.${method}: ubus status ${status}`);
		if (data && typeof data.code === 'number' && data.code !== 0) throw new Error(data.message || data.output || `code ${data.code}`);
		return data || {};
	}

	page() {
		return document.getElementById('addon-cluster-page');
	}

	stopPolling() {
		clearTimeout(this.timer);
		this.timer = null;
	}

	rate(bytes, prevBytes, dt) {
		if (prevBytes == null || !dt || bytes < prevBytes) return null;
		return ((bytes - prevBytes) * 8) / dt / 1000; // kbit/s
	}

	fmtRate(kbps) {
		if (kbps == null) return '';
		return this.core.formatRate(kbps);
	}

	linkText(gen, width) {
		if (!gen || !width) return '';
		return `Gen${gen} x${width}`;
	}

	// ---- routing ---------------------------------------------------------

	route(sub) {
		this.stopPolling();
		if (MOVED[sub[0]]) return this.core.navigate(MOVED[sub[0]]);
		const page = this.page();
		if (!page) return;
		page.innerHTML = '<div id="cb-pending"></div><div id="cb-body"></div>';
		this.showPending();
		this.loadOverview();
	}

	async showPending() {
		const el = document.getElementById('cb-pending');
		if (!el) return;
		try {
			const p = await this.call('pending');
			el.innerHTML = p.pending
				? `<div class="stat-card cb-banner">A change (${this.esc(p.kind)}) is waiting for confirmation;
					it is rolled back in ${Math.max(0, p.remaining)} s unless confirmed from the new address.</div>`
				: '';
		} catch {
			el.innerHTML = '';
		}
	}

	// ---- overview: the box from the front, and the cluster ---------------
	// Built once; every poll only changes texts and classes (data-f keys),
	// so the page stays light on the BMC and in the browser.

	async loadOverview() {
		const body = document.getElementById('cb-body');
		body.innerHTML = this.homeHtml();
		this.hist = this.hist || { wanRx: [], wanTx: [], omiRx: [], omiTx: [] };
		body.querySelector('[data-f="edit"]').addEventListener('click', () => this.editInfo());
		// An open POWER menu closes on a click anywhere else.
		if (!this.menuCloser) {
			this.menuCloser = e => document.querySelectorAll('.cb-menu[open]').forEach(d => d.contains(e.target) || d.removeAttribute('open'));
			document.addEventListener('click', this.menuCloser);
		}
		body.querySelectorAll('[data-act]').forEach(btn =>
			btn.addEventListener('click', () => {
				const bay = btn.closest('[data-slot]');
				const id = Number(bay.dataset.slot);
				btn.closest('details')?.removeAttribute('open');
				if (btn.dataset.act === 'logs') this.openLogs(id, this.nodeLabel(id, this.lastNodes?.[id - 1]));
				else this.nodeAction(id, btn.dataset.act);
			})
		);
		const tick = async () => {
			if (!document.getElementById('cb-home')) return this.stopPolling();
			if (!document.hidden) {
				try {
					const [t] = await Promise.all([this.call('topology'), this.info ? null : this.loadInfo()]);
					// The log is up to a minute behind: look again sooner when
					// it disagrees with what the nodes show now.
					if ((t.cluster?.nodes || []).some(n => this.availInfo?.[n.id] && this.availInfo[n.id].state !== this.nodeState(n)))
						this.availAt = Math.min(this.availAt || 0, Date.now() - AVAIL_MS + 10000);
					await this.loadAvailability();
					this.updateHome(t, this.rates(t));
				} catch (e) {
					this.homeError(e.message);
				}
			}
			this.timer = setTimeout(tick, POLL_MS);
		};
		tick();
	}

	async loadInfo() {
		try {
			this.info = await this.call('info_get');
			this.info.description = String(this.info.description || '').replace(/\\n/g, '\n');
		} catch {
			this.info = {};
		}
	}

	// Name of the node as the operator set it (info), else nodectl's.
	nodeLabel(id, n) {
		return this.info?.nodes?.[id]?.label || n?.name || `blade${id}`;
	}

	homeHtml() {
		const led = (k, title) => `<span class="cb-led" data-f="${k}" title="${title}"></span>`;
		const bay = id => `
			<div class="cb-bay" data-slot="${id}">
				<div class="cb-bay-plate"><span>SLOT</span><b>${id}</b></div>
				<div class="cb-bay-leds">${led('pwr', 'power')}${led('pcie', 'PCIe link')}${led('net', 'answers on its check port')}</div>
				<div class="cb-bay-main">
					<div class="cb-bay-line"><span class="cb-bay-name" data-f="name">blade${id}</span>
						<span class="cb-chip" data-f="role" hidden></span><span class="cb-state" data-f="state">…</span></div>
					<div class="cb-bay-line cb-mono cb-dim" data-f="facts"></div>
					<div class="cb-bay-av"><div data-f="av"></div><span class="cb-dim" data-f="avtext"></span></div>
				</div>
				<div class="cb-bay-actions">
					<button class="action-btn-sm" data-act="console" data-f="console">CONSOLE</button>
					<button class="action-btn-sm" data-act="logs">LOGS</button>
					<details class="cb-menu"><summary class="action-btn-sm">POWER</summary><div class="cb-menu-list" data-f="power"></div></details>
				</div>
			</div>`;
		const row = (k, label) => `<div class="cb-hrow" data-f="h-${k}"><span class="cb-dot"></span><span>${label}</span><span class="cb-hval" data-f="hv-${k}">…</span></div>`;
		const traffic = (k, label) => `<div class="cb-traffic">
				<div class="cb-traffic-head"><span>${label}</span><span class="cb-mono" data-f="${k}-rate"></span></div>
				<svg class="cb-spark" viewBox="0 0 120 30" preserveAspectRatio="none" aria-hidden="true">
					<polyline class="rx" data-f="${k}-rx" points=""/><polyline class="tx" data-f="${k}-tx" points=""/></svg></div>`;
		return `<div id="cb-home" class="cb-home">
			<div class="cb-home-head stat-card">
				<div class="cb-home-title">
					<div><div class="cb-kicker">CLUSTER</div><h3 data-f="cname">Mixtile Cluster Box</h3></div>
					<span class="cb-pill" data-f="overall">…</span>
				</div>
				<p class="cb-desc" data-f="cdesc"></p>
				<div class="cb-facts" data-f="cfacts"></div>
				<button class="action-btn-sm cb-edit" data-f="edit">EDIT</button>
			</div>
			<div class="cb-home-grid">
				<div class="cb-side">
				<div class="cb-chassis" aria-label="Cluster Box, front view">
					<div class="cb-bay cb-bay-bmc">
						<div class="cb-bay-plate"><span>CTRL</span><b>BMC</b></div>
						<div class="cb-bay-leds">${led('b-pwr', 'external power')}${led('b-wan', 'WAN')}${led('b-sw', 'PCIe switch')}</div>
						<div class="cb-bay-main">
							<div class="cb-bay-line"><span class="cb-bay-name">MT7620A · OpenWrt</span><span class="cb-state" data-f="b-state">…</span></div>
							<div class="cb-bay-line cb-mono cb-dim" data-f="b-facts"></div>
							<div class="cb-bay-line cb-mono cb-dim" data-f="b-facts2"></div>
						</div>
						<div class="cb-fan" data-f="fan" title="fan duty"></div>
					</div>
					<div class="cb-backplane"><span>PCIe SWITCH ASM2824</span><span class="cb-mono" data-f="sw"></span></div>
					${[1, 2, 3, 4].map(bay).join('')}
				</div>
				<div class="stat-card cb-card"><div class="section-title">SERVICES FORWARDED TO THE BLADES</div><div data-f="svc"></div></div>
				</div>
				<div class="cb-side">
					<div class="stat-card cb-card"><div class="section-title">HEALTH</div>
						${row('nodes', 'Nodes')}${row('fabric', 'PCIe fabric')}${row('inet', 'Internet')}${row('wan', 'WAN')}
						${row('svc', 'Services')}${row('ts', 'Tailscale')}${row('fw', 'Firmware')}${row('chassis', 'Chassis')}</div>
					<div class="stat-card cb-card"><div class="section-title">TRAFFIC THROUGH THE BMC</div>
						${traffic('wan', 'Internet (WAN)')}${traffic('omi', 'Blades ↔ BMC gateway')}
						<div class="cb-dim cb-note">Blade-to-blade traffic goes through the PCIe switch, not through the BMC.</div></div>
					<div class="stat-card cb-card"><div class="section-title">BMC</div>
						<div class="cb-kv"><span>Load</span><span data-f="bmc-load"></span></div>
						<div class="cb-kv"><span>Memory</span><span data-f="bmc-mem"></span></div>
						<div class="cb-bar"><i data-f="bmc-membar"></i></div>
						<div class="cb-kv"><span>Uptime</span><span data-f="bmc-up"></span></div>
						<div class="cb-kv"><span>Firmware</span><span class="cb-mono" data-f="bmc-fw"></span></div></div>
				</div>
			</div>
			<div class="cb-home-err cb-muted" data-f="err" hidden></div>
		</div>`;
	}

	// Set text / class / attribute of the element with data-f="key" only
	// when it changes.
	f(root, key) {
		return root.querySelector(`[data-f="${key}"]`);
	}

	put(el, text) {
		if (el && el.textContent !== text) el.textContent = text;
	}

	level(el, lv) {
		if (!el) return;
		const cur = el.dataset.lv;
		if (cur === lv) return;
		if (cur) el.classList.remove(cur);
		if (lv) el.classList.add(lv);
		el.dataset.lv = lv || '';
	}

	homeError(msg) {
		const root = document.getElementById('cb-home');
		if (!root) return;
		const el = this.f(root, 'err');
		el.hidden = false;
		this.put(el, `No data from the BMC: ${msg}`);
		this.level(this.f(root, 'overall'), 'bad');
		this.put(this.f(root, 'overall'), 'NO DATA');
	}

	updateHome(t, r) {
		const root = document.getElementById('cb-home');
		if (!root) return;
		this.f(root, 'err').hidden = true;
		const info = this.info || {};
		const nodes = t.cluster?.nodes || [];
		const byId = {};
		for (const n of nodes) byId[Number(n.id)] = n;
		this.lastNodes = [1, 2, 3, 4].map(id => byId[id]);
		const states = this.lastNodes.map(n => (n ? this.nodeState(n) : 'unknown'));
		const online = states.filter(s => s === 'online').length;
		const lv = { online: 'ok', booting: 'warn', busy: 'warn', nolink: 'bad', off: 'off', unknown: 'off' };
		const wan = t.wan || {};
		const pcie = t.pcie || {};
		const bmc = t.bmc || {};
		const ch = t.cluster?.chassis || {};
		const svc = t.services || [];
		const svcUp = svc.filter(x => x.up === '1').length;
		const uplink = (pcie.uplink || '').split('|');

		// Cluster head.
		this.put(this.f(root, 'cname'), info.name || 'Mixtile Cluster Box');
		const desc = this.f(root, 'cdesc');
		this.put(desc, info.description || 'No description yet: EDIT names the cluster, describes it and sets the role of every node.');
		desc.classList.toggle('cb-dim', !info.description);
		const problems = [];
		if (states.includes('nolink')) problems.push('bad');
		if (!pcie.switch) problems.push('bad');
		if (states.some(s => s !== 'online') || !t.internet?.up || svcUp < svc.length) problems.push('warn');
		const overall = problems.includes('bad') ? 'bad' : problems.length ? 'warn' : 'ok';
		this.level(this.f(root, 'overall'), overall);
		this.put(this.f(root, 'overall'), `${overall === 'ok' ? 'HEALTHY' : overall === 'warn' ? 'ATTENTION' : 'PROBLEM'} · ${online}/4 ONLINE`);
		const facts = [
			['Nodes', `${online}/4 online`],
			['Fabric', pcie.omi0 ? `omi0 · ${pcie.omi_driver || ''}` : 'down'],
			['WAN', wan.ipaddr || wan.fallback || 'no address'],
			['Internet', t.internet?.up ? `${Math.round(t.internet.rtt_ms)} ms` : 'unreachable'],
			['Remote', t.tailscale?.state === 'Running' ? `Tailscale ${t.tailscale.ipaddr || ''}` : 'Tailscale off']
		];
		const fe = this.f(root, 'cfacts');
		const fh = facts.map(([k, v]) => `<span><em>${this.esc(k)}</em>${this.esc(v)}</span>`).join('');
		if (fe.dataset.h !== fh) {
			fe.innerHTML = fh;
			fe.dataset.h = fh;
		}

		// BMC bay.
		this.level(this.f(root, 'b-pwr'), ch.ext_power === false ? 'warn' : 'ok');
		this.level(this.f(root, 'b-wan'), wan.up ? 'ok' : wan.fallback ? 'warn' : 'bad');
		this.level(this.f(root, 'b-sw'), pcie.switch ? (pcie.omi0 ? 'ok' : 'warn') : 'bad');
		const bst = this.f(root, 'b-state');
		this.level(bst, wan.up || wan.fallback ? 'ok' : 'bad');
		this.put(bst, `up ${this.fmtDur(bmc.uptime || 0)}`);
		this.put(this.f(root, 'b-facts'), [wan.ipaddr || wan.fallback || 'no WAN address', (wan.link || '').match(/speed:(\d+)/)?.[1] ? `${wan.link.match(/speed:(\d+)/)[1]} Mbit/s` : '', bmc.hostname].filter(Boolean).join(' · '));
		this.put(this.f(root, 'b-facts2'), [`omi0 10.20.0.1`, this.shortVersion(bmc.firmware)].join(' · '));
		const fan = this.f(root, 'fan');
		this.put(fan, ch.fan_duty != null ? `FAN ${ch.fan_duty}%` : 'FAN');
		fan.style.setProperty('--cb-fan-s', ch.fan_duty ? `${(2.4 - (ch.fan_duty / 100) * 1.8).toFixed(2)}s` : '0s');
		this.put(this.f(root, 'sw'), pcie.switch ? `to BMC ${uplink[0] ? `${uplink[0].replace(' PCIe', '')} x${uplink[1]}` : ''} · ${nodes.filter(n => n.pcie_link).length}/4 blade links` : 'not found');
		this.level(root.querySelector('.cb-backplane'), pcie.switch ? 'ok' : 'bad');

		// Blade bays.
		this.lastNodes.forEach((n, i) => {
			const id = i + 1;
			const bay = root.querySelector(`[data-slot="${id}"]`);
			const st = states[i];
			const meta = info.nodes?.[id] || {};
			this.level(bay, lv[st]);
			this.put(this.f(bay, 'name'), this.nodeLabel(id, n));
			const role = this.f(bay, 'role');
			role.hidden = !meta.role;
			this.put(role, meta.role || '');
			const av = this.availInfo?.[id];
			const dur = av?.since && av.state === st ? ` · ${this.fmtDur(av.now - av.since)}` : '';
			const se = this.f(bay, 'state');
			this.level(se, lv[st]);
			this.put(se, `${(AV_TEXT[st] || st).toUpperCase()}${dur}`);
			this.level(this.f(bay, 'pwr'), n?.power ? 'ok' : n?.power === false ? 'off' : '');
			this.level(this.f(bay, 'pcie'), n?.pcie_link ? 'ok' : n?.power ? 'bad' : 'off');
			this.level(this.f(bay, 'net'), n?.reachable ? 'ok' : n?.power && n?.pcie_link ? 'warn' : 'off');
			this.put(this.f(bay, 'facts'), [n?.ipaddr || 'no address', n?.pcie_link ? this.linkText(n.link_gen, n.link_width) : n?.power ? 'no PCIe link' : 'no link',
				meta.note || '', n?.busy ? `nodectl: ${n.busy}` : ''].filter(Boolean).join(' · '));
			const avEl = this.f(bay, 'av');
			const avh = av ? this.availStrip(av) : '';
			if (avEl.dataset.h !== avh) {
				avEl.innerHTML = avh;
				avEl.dataset.h = avh;
			}
			this.put(this.f(bay, 'avtext'), av?.pct != null ? `${av.pct >= 99.95 ? '100' : av.pct.toFixed(1)}% online, 24 h` : '');
			this.f(bay, 'console').disabled = !n?.tty_present;
			const pw = this.f(bay, 'power');
			const acts = n?.power ? [['shutdown', 'SHUT DOWN'], ['reboot', 'REBOOT'], ['poweroff', 'CUT POWER']] : [['poweron', 'POWER ON']];
			const ph = acts.map(([a, l]) => `<button class="action-btn-sm${a === 'poweroff' ? ' danger' : ''}" data-pact="${a}">${l}</button>`).join('');
			if (pw.dataset.h !== ph) {
				pw.innerHTML = ph;
				pw.dataset.h = ph;
				pw.querySelectorAll('[data-pact]').forEach(b =>
					b.addEventListener('click', () => {
						b.closest('details')?.removeAttribute('open');
						this.nodeAction(id, b.dataset.pact);
					})
				);
			}
		});

		// Health.
		const h = (k, level, text) => {
			this.level(this.f(root, `h-${k}`), level);
			this.put(this.f(root, `hv-${k}`), text);
		};
		const worst = states.includes('nolink') ? 'bad' : states.some(s => s !== 'online') ? 'warn' : 'ok';
		h('nodes', worst, `${online}/4 online · ${nodes.filter(n => n.pcie_link).length}/4 PCIe`);
		h('fabric', !pcie.switch ? 'bad' : pcie.omi0 ? 'ok' : 'warn', pcie.switch ? (pcie.omi0 ? `omi0 up · ${pcie.omi_driver}` : 'omi0 down') : 'no switch');
		h('inet', t.internet?.up ? 'ok' : 'bad', t.internet?.up ? `${Math.round(t.internet.rtt_ms)} ms` : 'unreachable');
		h('wan', wan.up ? 'ok' : wan.fallback ? 'warn' : 'bad', wan.up ? `${wan.proto || ''} ${wan.ipaddr || ''}`.trim() : wan.fallback ? `fallback ${wan.fallback}` : 'down');
		h('svc', !svc.length ? 'off' : svcUp === svc.length ? 'ok' : svcUp ? 'warn' : 'bad', svc.length ? `${svcUp}/${svc.length} up` : 'none');
		h('ts', !t.tailscale?.installed ? 'off' : t.tailscale.state === 'Running' ? 'ok' : 'off', t.tailscale?.installed ? t.tailscale.state || 'off' : 'not installed');
		const u = this.fw?.updater || {};
		h('fw', u.update_available ? 'warn' : 'ok', u.update_available && u.latest_version ? `${u.latest_version} available` : this.shortVersion(bmc.firmware).replace(/ \(.*\)$/, ''));
		h('chassis', ch.ext_power === false ? 'warn' : 'ok', [ch.ext_power === false ? 'no external power' : 'power ok', ch.fan_duty != null ? `fan ${ch.fan_duty}%` : '',
			ch.temp_mc != null ? `${(ch.temp_mc / 1000).toFixed(0)} °C` : ''].filter(Boolean).join(' · '));

		// Traffic sparklines: the last 60 polls (5 min).
		const hs = this.hist;
		for (const k of ['wanRx', 'wanTx', 'omiRx', 'omiTx']) {
			if (r[k] != null) hs[k].push(r[k]);
			if (hs[k].length > 60) hs[k].shift();
		}
		const spark = (k, rx, tx) => {
			const max = Math.max(1, ...hs[rx], ...hs[tx]);
			const pts = a => a.map((v, i) => `${((i + 60 - a.length) * 120 / 59).toFixed(1)},${(29 - (v / max) * 27).toFixed(1)}`).join(' ');
			this.f(root, `${k}-rx`).setAttribute('points', pts(hs[rx]));
			this.f(root, `${k}-tx`).setAttribute('points', pts(hs[tx]));
			this.put(this.f(root, `${k}-rate`), r[rx] == null ? '…' : `↓ ${this.fmtRate(r[rx])}  ↑ ${this.fmtRate(r[tx])}`);
		};
		spark('wan', 'wanRx', 'wanTx');
		spark('omi', 'omiTx', 'omiRx');

		// Services.
		const sv = this.f(root, 'svc');
		const svh = svc.length
			? svc.map(x => `<div class="cb-svc ${x.up === '1' ? 'ok' : 'bad'}"><span class="cb-dot"></span><span>${this.esc(x.name)}</span>
				<span class="cb-mono cb-dim">:${this.esc(x.port)} → ${this.esc(x.target)}</span></div>`).join('')
			: '<div class="cb-muted">No services forwarded to the blades (SERVICES tab).</div>';
		if (sv.dataset.h !== svh) {
			sv.innerHTML = svh;
			sv.dataset.h = svh;
		}

		// BMC.
		const mem = bmc.mem_total_kb ? (1 - bmc.mem_avail_kb / bmc.mem_total_kb) * 100 : null;
		this.put(this.f(root, 'bmc-load'), bmc.load || '');
		this.put(this.f(root, 'bmc-mem'), mem == null ? '' : `${Math.round((bmc.mem_total_kb - bmc.mem_avail_kb) / 1024)} / ${Math.round(bmc.mem_total_kb / 1024)} MB (${mem.toFixed(0)}%)`);
		this.f(root, 'bmc-membar').style.width = `${mem || 0}%`;
		this.put(this.f(root, 'bmc-up'), this.fmtDur(bmc.uptime || 0));
		this.put(this.f(root, 'bmc-fw'), this.shortVersion(bmc.firmware));
	}

	// Cluster name, description, node labels and roles (clusterbox UCI):
	// the BMC does not see Kubernetes, so the operator writes them.
	editInfo() {
		const info = this.info || {};
		const nodes = this.lastNodes || [];
		const body = `
			<div class="form-group"><label class="form-label">CLUSTER NAME</label>
				<input class="form-input" id="cb-i-name" maxlength="64" value="${this.esc(info.name || '')}" placeholder="Mixtile Cluster Box"></div>
			<div class="form-group"><label class="form-label">DESCRIPTION</label>
				<textarea class="form-input" id="cb-i-desc" rows="3" maxlength="400" placeholder="What runs here, who to call">${this.esc(info.description || '')}</textarea></div>
			<div class="cb-i-nodes">${[1, 2, 3, 4].map(id => {
				const m = info.nodes?.[id] || {};
				return `<div class="cb-i-node"><b>SLOT ${id}</b>
					<input class="form-input" data-i="label" data-id="${id}" maxlength="32" value="${this.esc(m.label || '')}" placeholder="${this.esc(nodes[id - 1]?.name || `blade${id}`)}" aria-label="slot ${id} name">
					<input class="form-input" data-i="role" data-id="${id}" maxlength="32" value="${this.esc(m.role || '')}" placeholder="role, e.g. control plane" aria-label="slot ${id} role">
					<input class="form-input" data-i="note" data-id="${id}" maxlength="64" value="${this.esc(m.note || '')}" placeholder="note" aria-label="slot ${id} note"></div>`;
			}).join('')}</div>`;
		const m = this.modal('CLUSTER DESCRIPTION', body,
			'<button class="action-btn" data-b="cancel">CANCEL</button><button class="action-btn" data-b="save">SAVE</button>');
		m.querySelector('.modal-content').classList.add('cb-i-modal');
		m.querySelector('[data-b="cancel"]').onclick = () => m.remove();
		m.querySelector('[data-b="save"]').onclick = async () => {
			const data = { name: m.querySelector('#cb-i-name').value.trim(), description: m.querySelector('#cb-i-desc').value.trim(), nodes: {} };
			m.querySelectorAll('[data-i]').forEach(inp => {
				(data.nodes[inp.dataset.id] = data.nodes[inp.dataset.id] || {})[inp.dataset.i] = inp.value.trim();
			});
			try {
				await this.call('info_set', { info: JSON.stringify(data) });
				this.info = data;
				m.remove();
				this.core.showToast('Saved', 'success');
			} catch (e) {
				this.core.showToast(`Save failed: ${e.message}`, 'error');
			}
		};
	}

	rates(t) {
		const now = Date.now() / 1000;
		const p = this.prev;
		const dt = p ? now - p.time : 0;
		const r = {
			wanRx: this.rate(t.wan?.rx_bytes, p?.wanRx, dt),
			wanTx: this.rate(t.wan?.tx_bytes, p?.wanTx, dt),
			omiRx: this.rate(t.pcie?.rx_bytes, p?.omiRx, dt),
			omiTx: this.rate(t.pcie?.tx_bytes, p?.omiTx, dt)
		};
		this.prev = { time: now, wanRx: t.wan?.rx_bytes, wanTx: t.wan?.tx_bytes, omiRx: t.pcie?.rx_bytes, omiTx: t.pcie?.tx_bytes };
		return r;
	}

	async nodeAction(node, act) {
		if (act === 'console') {
			try {
				const res = await this.call('console', { node, mode: 'serial' }, 'nodectl');
				window.open(`http://${window.location.hostname}:${res.port}/?arg=${encodeURIComponent(res.token)}`, '_blank', 'noopener');
			} catch (e) {
				this.core.showToast(`Console: ${e.message}`, 'error');
			}
			return;
		}
		const words = { poweron: 'Power on', poweroff: 'Cut power of', reboot: 'Reboot', shutdown: 'Shut down' };
		if (!confirm(`${words[act]} node ${node}?`)) return;
		try {
			await this.call('action', { node, action: act, force: false, hard: false }, 'nodectl', 30000);
			this.core.showToast(`${words[act]} node ${node}: started`, 'success');
		} catch (e) {
			this.core.showToast(`Node ${node}: ${e.message}`, 'error');
		}
	}

	// ---- availability (clusterbox availwatch) -----------------------------

	async loadAvailability() {
		if (this.availAt && Date.now() - this.availAt < AVAIL_MS) return;
		try {
			const a = await this.call('availability', { hours: 24 });
			this.availAt = Date.now();
			this.availInfo = {};
			for (const id of [1, 2, 3, 4]) this.availInfo[id] = this.availSegments(a, id);
		} catch {
			this.availInfo = null;
		}
	}

	// States of one node over [from, now]. While the watcher (the BMC)
	// was not running, and until it saw the node again, the state is
	// unknown.
	availSegments(a, id) {
		const evs = (a.events || []).filter(e => e[1] === 0 || e[1] === id).sort((x, y) => x[0] - y[0]);
		const segs = [];
		let t0 = a.from;
		let cur = a.initial?.[id] || 'unknown';
		let down = a.initial?.['0'] === 'stop';
		const push = (t, st) => {
			if (t <= t0) return;
			const last = segs[segs.length - 1];
			if (last && last.state === st) last.to = t;
			else segs.push({ from: t0, to: t, state: st });
		};
		for (const [t, n, st] of evs) {
			push(t, down ? 'unknown' : cur);
			t0 = Math.max(t0, t);
			if (n === 0) {
				down = st === 'stop';
				cur = 'unknown';
			} else {
				cur = st;
			}
		}
		push(a.now, down ? 'unknown' : cur);
		let known = 0;
		let online = 0;
		for (const g of segs) {
			if (g.state === 'unknown') continue;
			known += g.to - g.from;
			if (g.state === 'online') online += g.to - g.from;
		}
		const last = segs[segs.length - 1];
		return {
			segs,
			from: a.from,
			now: a.now,
			state: last?.state || 'unknown',
			since: last && last.state !== 'unknown' && last.from > a.from ? last.from : null,
			pct: known ? (online * 100) / known : null
		};
	}

	availStrip(av) {
		const span = av.now - av.from || 1;
		const when = t => new Date(t * 1000).toLocaleString();
		const rects = av.segs
			.map(g => {
				const x = ((g.from - av.from) / span) * 1000;
				const w = Math.max(((g.to - g.from) / span) * 1000, 1);
				return `<rect class="cb-av-${g.state}" x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="12">
					<title>${this.esc(AV_TEXT[g.state] || g.state)}: ${this.esc(when(g.from))} – ${this.esc(when(g.to))}</title></rect>`;
			})
			.join('');
		return `<svg class="cb-av" viewBox="0 0 1000 12" preserveAspectRatio="none" role="img" aria-label="availability, last 24 hours">${rects}</svg>`;
	}

	// The state availwatch logs for a node of nodectl status.
	nodeState(n) {
		if (n.busy) return 'busy';
		if (n.power == null) return 'unknown';
		if (!n.power) return 'off';
		if (!n.pcie_link) return 'nolink';
		return n.reachable ? 'online' : 'booting';
	}

	fmtDur(s) {
		s = Math.max(0, Math.round(s));
		const d = Math.floor(s / 86400);
		const h = Math.floor((s % 86400) / 3600);
		const m = Math.floor((s % 3600) / 60);
		if (d) return `${d}d ${h}h`;
		if (h) return `${h}h ${m}m`;
		if (m) return `${m}m`;
		return `${s}s`;
	}

	// ---- network topology (NETWORK > TOPOLOGY) ---------------------------
	// Internet, the upstream router, the BMC and its networks: the PCIe
	// fabric with the blades and the forwarded service addresses, and the
	// remote access networks (Tailscale, OpenVPN, WireGuard).

	renderTopology(el) {
		el.innerHTML = `<div class="stat-card"><div class="section-title">NETWORK TOPOLOGY</div>
			<div id="cb-net-topo" class="cb-muted">Loading…</div>
			<div class="cb-muted cb-note">Every 5 s from the BMC. Blade-to-blade traffic goes through the PCIe switch and is not seen here.</div></div>`;
		const tick = async () => {
			clearTimeout(this.topoTimer);
			const box = document.getElementById('cb-net-topo');
			if (!box || box.closest('.tab-content')?.classList.contains('hidden')) return;
			if (!document.hidden) {
				try {
					const [t, ifs, ov] = await Promise.all([
						this.call('topology'),
						this.core.ubusCall('network.interface', 'dump', {}).then(([st, d]) => (st === 0 ? d?.interface || [] : [])).catch(() => []),
						this.call('ovpn_list').catch(() => null),
						this.info ? null : this.loadInfo()
					]);
					box.classList.remove('cb-muted');
					box.innerHTML = this.netSvg(t, ifs, ov, this.netRates(t));
				} catch (e) {
					box.innerHTML = `<div class="cb-muted">Topology unavailable: ${this.esc(e.message)}</div>`;
				}
			}
			this.topoTimer = setTimeout(tick, POLL_MS);
		};
		tick();
	}

	netRates(t) {
		const now = Date.now() / 1000;
		const p = this.netPrev;
		const dt = p ? now - p.time : 0;
		const r = {
			wanRx: this.rate(t.wan?.rx_bytes, p?.wanRx, dt),
			wanTx: this.rate(t.wan?.tx_bytes, p?.wanTx, dt),
			omiRx: this.rate(t.pcie?.rx_bytes, p?.omiRx, dt),
			omiTx: this.rate(t.pcie?.tx_bytes, p?.omiTx, dt)
		};
		this.netPrev = { time: now, wanRx: t.wan?.rx_bytes, wanTx: t.wan?.tx_bytes, omiRx: t.pcie?.rx_bytes, omiTx: t.pcie?.tx_bytes };
		return r;
	}

	netSvg(t, ifs, ov, r) {
		const esc = v => this.esc(v);
		const addr = i => (i?.['ipv4-address'] || []).map(a => `${a.address}/${a.mask}`).join(' ');
		const byDev = d => ifs.find(i => i.l3_device === d || i.device === d);
		const wan = t.wan || {};
		const pcie = t.pcie || {};
		const nodes = t.cluster?.nodes || [];
		const svc = t.services || [];
		const ts = t.tailscale || {};
		const lv = ok => (ok === true ? 'up' : ok === false ? 'down' : 'off');
		const rate = (d, u) => (d == null ? '' : `↓ ${this.fmtRate(d)}  ↑ ${this.fmtRate(u)}`);

		// Right-hand column: networks and what is on them.
		const nets = [];
		const omi = byDev('omi0');
		const ends = nodes.map(n => ({
			lv: n.power === false ? 'off' : n.pcie_link ? (n.reachable ? 'up' : 'warn') : n.power ? 'down' : 'off',
			title: this.nodeLabel(Number(n.id), n),
			sub: `${n.ipaddr || '—'} · slot ${n.id} · ${n.pcie_link ? this.linkText(n.link_gen, n.link_width) : n.power ? 'no PCIe link' : 'off'}`
		}));
		const vips = [...new Set(svc.map(x => (x.target || '').split(':')[0]).filter(Boolean))];
		for (const ip of vips) {
			const names = svc.filter(x => x.target.startsWith(`${ip}:`));
			ends.push({
				lv: names.every(x => x.up === '1') ? 'up' : names.some(x => x.up === '1') ? 'warn' : 'down',
				title: ip,
				sub: names.map(x => `${x.name} :${x.port}`).join(' · '),
				vip: true
			});
		}
		nets.push({
			lv: !pcie.switch ? 'down' : pcie.omi0 ? 'up' : 'warn',
			title: 'omi0 · PCIe fabric',
			sub: `${addr(omi) || '10.20.0.1/24'} · ${pcie.omi_driver || 'no driver'}`,
			sub2: r.omiTx != null ? `gateway ${rate(r.omiTx, r.omiRx)}` : pcie.switch ? 'ASM2824 switch, Gen3 x2 per blade' : 'no PCIe switch',
			rate: true,
			ends
		});
		if (ts.installed) {
			nets.push({
				lv: ts.state === 'Running' ? 'up' : 'off',
				title: 'tailscale0 · Tailscale',
				sub: ts.ipaddr || ts.state || 'off',
				sub2: 'tailnet: subnet route to the blades',
				ends: [{ lv: ts.state === 'Running' ? 'up' : 'off', title: 'tailnet', sub: ts.state || 'off' }]
			});
		}
		const srv = ov?.server;
		if (srv?.configured) {
			const cl = srv.clients || [];
			nets.push({
				lv: srv.running ? 'up' : srv.enabled ? 'down' : 'off',
				title: 'tun-cb · OpenVPN server',
				sub: `${srv.subnet} · ${srv.proto}/${srv.port}`,
				sub2: `${cl.filter(c => c.connected).length}/${cl.length} clients connected`,
				ends: cl.length
					? cl.map(c => ({ lv: c.connected ? 'up' : 'off', title: c.name, sub: c.connected ? `${c.address} from ${c.real}` : 'not connected' }))
					: [{ lv: 'off', title: 'no clients', sub: 'NETWORK > OPENVPN adds them' }]
			});
		}
		for (const c of ov?.connections || []) {
			nets.push({
				lv: c.connected ? 'up' : c.enabled ? 'down' : 'off',
				title: `OpenVPN client · ${c.name}`,
				sub: c.remote || '',
				sub2: c.connected ? 'connected' : c.enabled ? (c.running ? 'connecting' : 'not running') : 'off',
				ends: [{ lv: c.connected ? 'up' : 'off', title: c.remote ? c.remote.split(' ')[0] : 'remote', sub: 'remote network' }]
			});
		}
		for (const i of ifs.filter(x => x.proto === 'wireguard')) {
			nets.push({ lv: i.up ? 'up' : 'off', title: `${i.l3_device || i.interface} · WireGuard`, sub: addr(i) || '', sub2: i.interface,
				ends: [{ lv: i.up ? 'up' : 'off', title: 'peers', sub: 'NETWORK > WIREGUARD' }] });
		}

		// Geometry: four left columns, nets and their endpoints on the right.
		const W = 1220;
		const C = { inet: [10, 150], gw: [190, 170], bmc: [400, 220], net: [680, 230], end: [960, 250] };
		const eh = 44, eg = 8, ng = 22;
		let y = 20;
		for (const n of nets) {
			n.y = y;
			n.h = Math.max(70, n.ends.length * (eh + eg) - eg);
			y += n.h + ng;
		}
		const H = Math.max(y, 260);
		const mid = Math.min(nets[0] ? nets[0].y + nets[0].h / 2 : 120, H / 2);
		const box = (col, yy, h, cls, title, sub, sub2) => {
			const [x, w] = C[col];
			return `<rect class="cb-box ${cls}" x="${x}" y="${yy}" width="${w}" height="${h}" rx="9"/>
				<text class="cb-title" x="${x + 12}" y="${yy + 20}">${esc(title)}</text>
				${sub ? `<text class="cb-sub" x="${x + 12}" y="${yy + 37}">${esc(sub)}</text>` : ''}
				${sub2 ? `<text class="cb-sub" x="${x + 12}" y="${yy + 53}">${esc(sub2)}</text>` : ''}`;
		};
		const link = (x1, y1, x2, y2, cls, label) => {
			const mx = (x1 + x2) / 2;
			return `<path class="cb-link ${cls}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>
				${label ? `<text class="cb-rate" x="${mx}" y="${Math.min(y1, y2) - 8}" text-anchor="middle">${esc(label)}</text>` : ''}`;
		};
		const right = c => C[c][0] + C[c][1];
		const wanUp = !!wan.up || !!wan.fallback;
		const bh = 76;
		const y0 = mid - bh / 2;
		let svg = '';
		svg += box('inet', y0 + 8, 60, lv(!!t.internet?.up), 'INTERNET', t.internet?.up ? `ping ${Math.round(t.internet.rtt_ms)} ms` : 'unreachable');
		svg += box('gw', y0, bh, lv(wanUp), 'UPSTREAM ROUTER', wan.gateway || '—', `WAN ${wan.proto || ''}`);
		svg += link(right('inet'), mid, C.gw[0], mid, lv(!!t.internet?.up));
		const speed = (wan.link || '').match(/speed:(\d+)/)?.[1];
		const zones = ['wan', 'openmiop', ts.installed ? 'tailscale' : '', srv?.configured || (ov?.connections || []).length ? 'vpn' : ''];
		const bl = [
			`WAN ${wan.ipaddr || wan.fallback || 'no address'}`,
			`${wan.device || 'eth0.2'}${speed ? ` · ${speed} Mbit/s` : ''}`,
			r.wanRx != null ? `WAN ${rate(r.wanRx, r.wanTx)}` : '',
			'NAT · firewall · DNS · NTP',
			svc.length ? `${svc.length} port forwards to the cluster` : 'no port forwards',
			`zones: ${zones.filter(Boolean).join(', ')}`
		].filter(Boolean);
		const bH = 30 + bl.length * 16;
		const [bx, bw] = C.bmc;
		svg += `<rect class="cb-box ${lv(wanUp)}" x="${bx}" y="${mid - bH / 2}" width="${bw}" height="${bH}" rx="9"/>
			<text class="cb-title" x="${bx + 12}" y="${mid - bH / 2 + 20}">${esc(`BMC · ${t.bmc?.hostname || 'ClusterBox'}`)}</text>
			${bl.map((l, i) => `<text class="cb-sub" x="${bx + 12}" y="${mid - bH / 2 + 37 + i * 16}">${esc(l)}</text>`).join('')}`;
		svg += link(right('gw'), mid, C.bmc[0], mid, lv(wanUp) + (r.wanRx > 50 ? ' flow' : ''));
		for (const n of nets) {
			const ny = n.y + n.h / 2;
			svg += box('net', n.y + (n.h - 70) / 2, 70, n.lv, n.title, n.sub, n.sub2);
			svg += link(right('bmc'), mid, C.net[0], ny, n.lv + (n.rate && r.omiTx > 50 ? ' flow' : ''));
			n.ends.forEach((e, i) => {
				const ey = n.y + i * (eh + eg);
				svg += box('end', ey, eh, `${e.lv}${e.vip ? ' vip' : ''}`, e.title, e.sub);
				svg += link(right('net'), ny, C.end[0], ey + eh / 2, e.lv === 'warn' ? 'down' : e.lv);
			});
		}
		return `<div class="cb-net-wrap"><svg class="cb-topo" viewBox="0 0 ${W} ${H}" role="img" aria-label="Network topology of the Cluster Box">${svg}</svg></div>`;
	}

	// ---- OpenVPN (NETWORK > OPENVPN) --------------------------------------
	// The server (remote access to the BMC and the blades; one .ovpn per
	// client) and client connections from uploaded .ovpn files.

	async renderOpenvpn(el) {
		this.ovEl = el;
		el.innerHTML = '<div class="stat-card cb-muted">Loading…</div>';
		let ov;
		try {
			ov = await this.call('ovpn_list');
		} catch (e) {
			el.innerHTML = `<div class="stat-card cb-muted">OpenVPN status unavailable: ${this.esc(e.message)}</div>`;
			return;
		}
		const s = ov.server || {};
		const badge = (ok, on, off) => this.core.renderBadge(ok ? 'success' : 'warning', ok ? on : off);
		const serverCard = s.configured
			? `<div class="stat-card"><div class="section-title">OPENVPN SERVER</div>
				<div class="cb-node-row"><span>State</span><span>${s.running ? this.core.renderBadge('success', 'RUNNING') : s.enabled ? this.core.renderBadge('error', 'NOT RUNNING') : this.core.renderBadge('warning', 'OFF')}</span></div>
				<div class="cb-node-row"><span>Clients connect to</span><span class="cb-mono">${this.esc(s.host)} ${this.esc(s.proto)}/${this.esc(s.port)}</span></div>
				<div class="cb-node-row"><span>Client addresses</span><span class="cb-mono">${this.esc(s.subnet)}</span></div>
				<div class="cb-node-row"><span>Route pushed</span><span class="cb-mono">10.20.0.0/24 (blades)</span></div>
				<div class="cb-node-row"><span>Server fingerprint</span><span class="cb-mono cb-fp" title="${this.esc(s.fingerprint)}">${this.esc((s.fingerprint || '').slice(0, 23))}…</span></div>
				<p class="cb-muted" style="margin:10px 0">The WAN address of the BMC is usually private: forward ${this.esc(s.proto === 'udp' ? 'UDP' : 'TCP')} port ${this.esc(s.port)} to it on the upstream router.
					Clients reach the BMC (web UI, SSH) and the blades.</p>
				<div class="cb-node-actions">
					<button class="action-btn-sm" data-ov="srv-toggle">${s.enabled ? 'TURN OFF' : 'TURN ON'}</button>
					<button class="action-btn-sm" data-ov="srv-setup">SETTINGS</button>
					<button class="action-btn-sm" data-ov="log" data-name="server">LOG</button>
					<button class="action-btn-sm danger" data-ov="srv-remove">REMOVE SERVER</button>
				</div>
				<div class="section-title" style="margin-top:20px">CLIENTS</div>
				<table class="data-table"><thead><tr><th>NAME</th><th>STATE</th><th>VPN ADDRESS</th><th>FROM</th><th>SINCE</th><th></th></tr></thead><tbody>
				${(s.clients || []).map(c => `<tr><td>${this.esc(c.name)}</td><td>${badge(c.connected, 'CONNECTED', 'OFFLINE')}</td>
					<td class="cb-mono">${this.esc(c.address || '')}</td><td class="cb-mono">${this.esc(c.real || '')}</td><td>${this.esc(c.since || '')}</td>
					<td><button class="action-btn-sm" data-ov="cl-get" data-name="${this.esc(c.name)}">.OVPN</button>
					<button class="action-btn-sm danger" data-ov="cl-del" data-name="${this.esc(c.name)}">DELETE</button></td></tr>`).join('') ||
					'<tr><td colspan="6" class="cb-muted">No clients yet.</td></tr>'}
				</tbody></table>
				<div class="cb-node-actions"><input class="form-input cb-ov-name" id="cb-ov-new" placeholder="client name, e.g. laptop" maxlength="24">
					<button class="action-btn-sm" data-ov="cl-add">ADD CLIENT AND DOWNLOAD .OVPN</button></div></div>`
			: `<div class="stat-card"><div class="section-title">OPENVPN SERVER</div>
				<p class="cb-muted" style="margin-bottom:12px">Remote access to the BMC and the blades' network (10.20.0.0/24) from a laptop or phone.
					Every client gets its own .ovpn file; no certificate authority to manage: each side pins the other's certificate fingerprint.</p>
				${this.ovServerForm({ port: '1194', proto: 'udp', subnet: '10.8.0.0/24', host: s.host || '' })}
				<div class="cb-node-actions"><button class="action-btn-sm" data-ov="srv-create">SET UP THE SERVER</button></div></div>`;
		const conns = ov.connections || [];
		const connCard = `<div class="stat-card"><div class="section-title">CONNECTIONS TO OTHER VPN SERVERS</div>
			<p class="cb-muted" style="margin-bottom:12px">The BMC connects out with an .ovpn file from the other side (an office, a cloud network).
				Directives that run programs are refused.</p>
			<table class="data-table"><thead><tr><th>NAME</th><th>SERVER</th><th>STATE</th><th></th></tr></thead><tbody>
			${conns.map(c => `<tr><td>${this.esc(c.name)}${c.kind === 'luci' ? ' <span class="cb-muted">(LuCI)</span>' : ''}</td><td class="cb-mono">${this.esc(c.remote || '')}</td>
				<td>${c.connected ? this.core.renderBadge('success', 'CONNECTED') : c.enabled ? this.core.renderBadge('warning', c.running ? 'CONNECTING' : 'NOT RUNNING') : this.core.renderBadge('warning', 'OFF')}</td>
				<td>${c.kind === 'imported'
					? `<button class="action-btn-sm" data-ov="cn-toggle" data-name="${this.esc(c.name)}" data-on="${c.enabled ? 0 : 1}">${c.enabled ? 'TURN OFF' : 'TURN ON'}</button>
						<button class="action-btn-sm" data-ov="log" data-name="${this.esc(c.instance)}">LOG</button>
						<button class="action-btn-sm danger" data-ov="cn-del" data-name="${this.esc(c.name)}">DELETE</button>`
					: `<a class="action-btn-sm" href="/cgi-bin/luci/admin/vpn/openvpn" target="_blank" rel="noopener">LUCI</a>`}</td></tr>`).join('') ||
				'<tr><td colspan="4" class="cb-muted">None.</td></tr>'}
			</tbody></table>
			<div class="cb-node-actions"><input class="form-input cb-ov-name" id="cb-ov-imp-name" placeholder="name, e.g. office" maxlength="24">
				<input type="file" id="cb-ov-file" accept=".ovpn,.conf,text/plain" class="form-input cb-ov-file">
				<button class="action-btn-sm" data-ov="cn-import">IMPORT .OVPN</button></div></div>`;
		el.innerHTML = `${serverCard}<div style="height:16px"></div>${connCard}<pre class="cb-logs-text cb-ov-log" id="cb-ov-log" hidden></pre>`;
		el.querySelectorAll('[data-ov]').forEach(b => (b.onclick = () => this.ovAction(b.dataset.ov, b.dataset, s)));
	}

	ovServerForm(v) {
		return `<div class="cb-grid2">
			<div class="form-group"><label class="form-label">ADDRESS CLIENTS CONNECT TO</label>
				<input class="form-input" id="cb-ov-host" value="${this.esc(v.host)}" placeholder="public IP or DNS name"></div>
			<div class="form-group"><label class="form-label">PORT AND PROTOCOL</label>
				<div style="display:flex;gap:8px"><input class="form-input" id="cb-ov-port" value="${this.esc(v.port)}" style="max-width:110px">
				<select class="form-input" id="cb-ov-proto"><option value="udp"${v.proto === 'udp' ? ' selected' : ''}>UDP</option>
					<option value="tcp-server"${v.proto !== 'udp' ? ' selected' : ''}>TCP</option></select></div></div>
			<div class="form-group"><label class="form-label">CLIENT ADDRESSES (/24)</label>
				<input class="form-input" id="cb-ov-subnet" value="${this.esc(v.subnet)}"></div></div>`;
	}

	download(name, text) {
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-openvpn-profile' }));
		a.download = name;
		document.body.appendChild(a);
		a.click();
		setTimeout(() => {
			URL.revokeObjectURL(a.href);
			a.remove();
		}, 1000);
	}

	async ovAction(act, d, srv) {
		const el = this.ovEl;
		const q = id => el.querySelector(id);
		const run = async (method, params, ok, timeout = 60000) => {
			try {
				const res = await this.call(method, params, 'clusterbox', timeout);
				if (ok) this.core.showToast(ok, 'success');
				return res;
			} catch (e) {
				this.core.showToast(e.message, 'error');
				return null;
			}
		};
		const form = () => ({ host: q('#cb-ov-host').value.trim(), port: q('#cb-ov-port').value.trim(), proto: q('#cb-ov-proto').value, subnet: q('#cb-ov-subnet').value.trim() });
		if (act === 'srv-create') {
			if (await run('ovpn_server_setup', form(), 'OpenVPN server set up')) this.renderOpenvpn(el);
		} else if (act === 'srv-setup') {
			const m = this.modal('OPENVPN SERVER', this.ovServerForm(srv),
				'<button class="action-btn" data-b="cancel">CANCEL</button><button class="action-btn" data-b="save">SAVE</button>');
			m.querySelector('[data-b="cancel"]').onclick = () => m.remove();
			m.querySelector('[data-b="save"]').onclick = async () => {
				const v = { host: m.querySelector('#cb-ov-host').value.trim(), port: m.querySelector('#cb-ov-port').value.trim(),
					proto: m.querySelector('#cb-ov-proto').value, subnet: m.querySelector('#cb-ov-subnet').value.trim() };
				if (await run('ovpn_server_setup', v, 'Saved; download the client files again if the address or port changed')) {
					m.remove();
					this.renderOpenvpn(el);
				}
			};
		} else if (act === 'srv-toggle') {
			if (await run('ovpn_server_enable', { enabled: srv.enabled ? '0' : '1' }, srv.enabled ? 'Server off' : 'Server on')) this.renderOpenvpn(el);
		} else if (act === 'srv-remove') {
			if (!confirm('Remove the OpenVPN server with all its client keys? Their .ovpn files stop working.')) return;
			if (await run('ovpn_server_remove', {}, 'Server removed')) this.renderOpenvpn(el);
		} else if (act === 'cl-add') {
			const name = q('#cb-ov-new').value.trim();
			const res = await run('ovpn_client_add', { name });
			if (res?.text) {
				this.download(`${name}.ovpn`, res.text);
				this.core.showToast(`${name}.ovpn downloaded: import it into the OpenVPN app`, 'success');
				this.renderOpenvpn(el);
			}
		} else if (act === 'cl-get') {
			const res = await run('ovpn_client_get', { name: d.name });
			if (res?.text) this.download(`${d.name}.ovpn`, res.text);
		} else if (act === 'cl-del') {
			if (!confirm(`Delete client ${d.name}? Its .ovpn file stops working.`)) return;
			if (await run('ovpn_client_del', { name: d.name }, `${d.name} deleted`)) this.renderOpenvpn(el);
		} else if (act === 'cn-import') {
			const name = q('#cb-ov-imp-name').value.trim();
			const file = q('#cb-ov-file').files[0];
			if (!file) return this.core.showToast('Choose an .ovpn file', 'error');
			if (file.size > 48 * 1024) return this.core.showToast('The file is larger than 48 KiB', 'error');
			if (await run('ovpn_import', { name, config: await file.text() }, `${name}: imported, connecting`)) this.renderOpenvpn(el);
		} else if (act === 'cn-toggle') {
			if (await run('ovpn_enable', { name: d.name, enabled: d.on }, d.on === '1' ? 'Connecting' : 'Off')) this.renderOpenvpn(el);
		} else if (act === 'cn-del') {
			if (!confirm(`Delete connection ${d.name}?`)) return;
			if (await run('ovpn_delete', { name: d.name }, `${d.name} deleted`)) this.renderOpenvpn(el);
		} else if (act === 'log') {
			const res = await run('ovpn_log', { name: d.name });
			const pre = q('#cb-ov-log');
			pre.hidden = false;
			pre.textContent = res?.text || 'No log lines.';
			pre.scrollIntoView({ block: 'nearest' });
		}
	}

	// ---- software (SYSTEM > SOFTWARE, apk) ---------------------------------

	// "name-version arch {origin} (license) [installed]" lines of apk list.
	pkgParse(text) {
		return String(text || '')
			.split('\n')
			.map(l => l.match(/^(.+?)-(\d\S*)\s+(\S+)?.*?(\[installed\])?$/))
			.filter(Boolean)
			.map(m => ({ name: m[1], version: m[2], installed: !!m[4] }));
	}

	async loadSoftware(el) {
		this.swEl = el;
		el.innerHTML = `<div class="stat-card"><div class="section-title">PACKAGES (APK)</div>
				<p class="cb-muted" style="margin-bottom:12px">Packages from the OpenWrt ${this.esc(this.fw?.openwrt || '')} feeds for this board.
					Kernel modules only install if they match the firmware's kernel; core packages of the BMC cannot be removed here.</p>
				<div class="cb-node-actions">
					<button class="action-btn-sm" data-sw="update">UPDATE PACKAGE LISTS</button>
					<input class="form-input cb-sw-q" id="cb-sw-q" placeholder="search the feeds, e.g. htop" maxlength="40">
					<button class="action-btn-sm" data-sw="search">SEARCH</button>
				</div>
				<div class="cb-sw-job" id="cb-sw-job" hidden>
					<div class="progress-bar"><div class="progress-fill busy" id="cb-sw-fill" style="width:100%"></div></div>
					<div class="cb-muted" id="cb-sw-state"></div>
					<pre class="cb-logs-text cb-sw-log" id="cb-sw-log"></pre>
				</div>
				<div id="cb-sw-results"></div></div>
			<div class="stat-card" style="margin-top:16px"><div class="section-title">INSTALLED</div>
				<input class="form-input cb-sw-q" id="cb-sw-filter" placeholder="filter" style="margin-bottom:10px">
				<div id="cb-sw-installed" class="cb-muted">Loading…</div></div>`;
		const q = id => el.querySelector(id);
		el.querySelectorAll('[data-sw]').forEach(b => (b.onclick = () => this.swAction(b.dataset.sw)));
		q('#cb-sw-q').onkeydown = e => e.key === 'Enter' && this.swAction('search');
		q('#cb-sw-filter').oninput = () => this.swRenderInstalled();
		try {
			this.swInstalled = this.pkgParse((await this.call('pkg_list')).text);
		} catch (e) {
			q('#cb-sw-installed').textContent = e.message;
			return;
		}
		this.swRenderInstalled();
		this.swPoll(true);
	}

	swRenderInstalled() {
		const el = this.swEl;
		const box = el?.querySelector('#cb-sw-installed');
		if (!box) return;
		const f = el.querySelector('#cb-sw-filter').value.trim().toLowerCase();
		const list = (this.swInstalled || []).filter(p => !f || p.name.includes(f));
		box.classList.remove('cb-muted');
		box.innerHTML = `<div class="cb-muted" style="margin-bottom:6px">${list.length} of ${(this.swInstalled || []).length} packages</div>
			<table class="data-table"><thead><tr><th>PACKAGE</th><th>VERSION</th><th></th></tr></thead><tbody>
			${list.map(p => `<tr><td>${this.esc(p.name)}</td><td class="cb-mono">${this.esc(p.version)}</td>
				<td><button class="action-btn-sm danger" data-rm="${this.esc(p.name)}">REMOVE</button></td></tr>`).join('')}
			</tbody></table>`;
		box.querySelectorAll('[data-rm]').forEach(b => (b.onclick = () => this.swJob('remove', b.dataset.rm)));
	}

	async swAction(act) {
		const el = this.swEl;
		if (act === 'update') return this.swJob('update', '');
		const text = el.querySelector('#cb-sw-q').value.trim();
		const out = el.querySelector('#cb-sw-results');
		try {
			const found = this.pkgParse((await this.call('pkg_search', { q: text })).text);
			const have = new Set((this.swInstalled || []).map(p => p.name));
			out.innerHTML = found.length
				? `<table class="data-table" style="margin-top:12px"><thead><tr><th>PACKAGE</th><th>VERSION</th><th></th></tr></thead><tbody>
					${found.map(p => `<tr><td>${this.esc(p.name)}</td><td class="cb-mono">${this.esc(p.version)}</td>
						<td>${have.has(p.name) ? this.core.renderBadge('success', 'INSTALLED')
							: `<button class="action-btn-sm" data-in="${this.esc(p.name)}">INSTALL</button>`}</td></tr>`).join('')}
					</tbody></table>`
				: `<div class="cb-muted" style="margin-top:12px">Nothing found for "${this.esc(text)}" (UPDATE PACKAGE LISTS first if the lists are old).</div>`;
			out.querySelectorAll('[data-in]').forEach(b => (b.onclick = () => this.swJob('install', b.dataset.in)));
		} catch (e) {
			this.core.showToast(e.message, 'error');
		}
	}

	async swJob(action, name) {
		if (action === 'remove' && !confirm(`Remove ${name}?`)) return;
		try {
			await this.call('pkg_job', { action, name });
		} catch (e) {
			return this.core.showToast(e.message, 'error');
		}
		this.swPoll();
	}

	// Job progress: the apk log every 2 s until the job ends.
	async swPoll(quiet) {
		clearTimeout(this.swTimer);
		const el = this.swEl;
		if (!el?.isConnected) return;
		let st;
		try {
			st = (await this.call('pkg_status')).text || '';
		} catch {
			return;
		}
		const [head, ...log] = st.split('\n');
		const [state, action, name] = head.split(' ');
		const job = el.querySelector('#cb-sw-job');
		if (state === 'idle' || (quiet && state !== 'running')) return;
		job.hidden = false;
		const what = action === 'update' ? 'Updating the package lists' : `${action === 'install' ? 'Installing' : 'Removing'} ${name}`;
		el.querySelector('#cb-sw-fill').classList.toggle('busy', state === 'running');
		el.querySelector('#cb-sw-state').textContent = state === 'running' ? `${what}…` : `${what}: ${state === 'done' ? 'done' : 'failed'}`;
		const pre = el.querySelector('#cb-sw-log');
		pre.textContent = log.join('\n');
		pre.scrollTop = pre.scrollHeight;
		if (state === 'running') {
			this.swTimer = setTimeout(() => this.swPoll(), 2000);
		} else if (!quiet) {
			this.core.showToast(`${what}: ${state === 'done' ? 'done' : 'failed'}`, state === 'done' ? 'success' : 'error');
			try {
				this.swInstalled = this.pkgParse((await this.call('pkg_list')).text);
				this.swRenderInstalled();
			} catch {}
		}
	}

	// ---- console logs (nodectl archive on the eMMC, a file per boot) -------

	async openLogs(node, name) {
		this.closeLogs();
		const m = document.createElement('div');
		m.className = 'modal';
		m.innerHTML = `<div class="modal-backdrop"></div>
			<div class="modal-content cb-logs">
				<div class="modal-header cb-logs-head">
					<h3 class="modal-title">${this.esc(String(name).toUpperCase())} · CONSOLE LOG</h3>
					<select class="form-input cb-logs-boot" id="cb-logs-boot" aria-label="boot"></select>
					<button class="action-btn-sm" data-lg="close">CLOSE</button>
				</div>
				<div class="cb-logs-bar">
					<button class="action-btn-sm" data-lg="start">FROM BOOT</button>
					<button class="action-btn-sm" data-lg="earlier">EARLIER</button>
					<button class="action-btn-sm" data-lg="end">LATEST</button>
					<label class="cb-check"><input type="checkbox" id="cb-logs-follow" checked> follow</label>
					<input class="form-input cb-logs-find" id="cb-logs-find" placeholder="find in this boot" aria-label="find">
					<button class="action-btn-sm" data-lg="find">FIND</button>
					<button class="action-btn-sm" data-lg="download">DOWNLOAD</button>
					<span class="cb-muted" id="cb-logs-info"></span>
				</div>
				<div class="cb-logs-matches" id="cb-logs-matches" hidden></div>
				<pre class="cb-logs-text" id="cb-logs-text">Loading…</pre>
				<div class="cb-logs-bar"><button class="action-btn-sm" data-lg="later">LATER</button></div>
			</div>`;
		document.body.appendChild(m);
		const lg = { node, name, m, boots: [], boot: null, chunks: [], timer: null, busy: false };
		this.lg = lg;
		m.querySelector('.modal-backdrop').onclick = () => this.closeLogs();
		lg.onKey = e => e.key === 'Escape' && this.closeLogs();
		document.addEventListener('keydown', lg.onKey);
		m.querySelectorAll('[data-lg]').forEach(b => (b.onclick = () => this.logsAction(b.dataset.lg)));
		m.querySelector('#cb-logs-find').onkeydown = e => e.key === 'Enter' && this.logsAction('find');
		m.querySelector('#cb-logs-boot').onchange = e => this.logsSelect(e.target.value);
		try {
			await this.logsBoots();
		} catch (e) {
			this.logsText(`Console log unavailable: ${e.message}`);
			return;
		}
		if (!lg.boots.length) {
			this.logsText('No console log of this node yet (the archive starts with the next output of its console).');
			return;
		}
		await this.logsSelect(lg.boots[0].id);
		lg.timer = setInterval(() => this.logsFollow(), 3000);
	}

	closeLogs() {
		const lg = this.lg;
		if (!lg) return;
		clearInterval(lg.timer);
		document.removeEventListener('keydown', lg.onKey);
		lg.m.remove();
		this.lg = null;
	}

	// Files of the node grouped by boot, newest first; a boot is its
	// parts back to back.
	async logsBoots() {
		const lg = this.lg;
		const res = await this.call('console_boots', { node: lg.node });
		const byId = new Map();
		for (const f of res.files || []) {
			const id = f.name.slice(0, 15);
			if (!byId.has(id)) byId.set(id, { id, parts: [], total: 0 });
			const b = byId.get(id);
			b.parts.push({ name: f.name, size: f.size, start: b.total });
			b.total += f.size;
		}
		lg.boots = [...byId.values()].sort((a, b) => (a.id < b.id ? 1 : -1));
		const sel = lg.m.querySelector('#cb-logs-boot');
		const cur = lg.boot?.id;
		sel.innerHTML = lg.boots
			.map((b, i) => {
				const t = `${b.id.slice(0, 4)}-${b.id.slice(4, 6)}-${b.id.slice(6, 8)} ${b.id.slice(9, 11)}:${b.id.slice(11, 13)}:${b.id.slice(13, 15)}`;
				return `<option value="${b.id}">${t} · ${this.fmtBytes(b.total)}${i === 0 ? ' · current' : ''}</option>`;
			})
			.join('');
		if (cur) sel.value = cur;
		if (cur) lg.boot = lg.boots.find(b => b.id === cur) || lg.boot;
	}

	fmtBytes(n) {
		if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
		if (n >= 1024) return `${Math.round(n / 1024)} KB`;
		return `${n} B`;
	}

	async logsSelect(id) {
		const lg = this.lg;
		lg.boot = lg.boots.find(b => b.id === id);
		lg.m.querySelector('#cb-logs-matches').hidden = true;
		lg.m.querySelector('#cb-logs-follow').checked = lg.boot === lg.boots[0];
		await this.logsAction('end');
	}

	// Bytes [pos, end) of the boot, at most one part per request.
	async logsRead(pos, end) {
		const lg = this.lg;
		let text = '';
		while (pos < end) {
			const p = lg.boot.parts.find(q => pos >= q.start && pos < q.start + q.size);
			if (!p) break;
			const len = Math.min(end - pos, p.start + p.size - pos, LOG_CHUNK);
			const r = await this.call('console_read', { node: lg.node, name: p.name, offset: pos - p.start, length: len });
			text += r.data || '';
			if (r.next <= pos - p.start) break;
			pos = p.start + r.next;
		}
		return { text: this.cleanLog(text), end: pos };
	}

	// Terminal escapes and carriage returns out.
	cleanLog(t) {
		return t
			.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
			.replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g, '')
			.replace(/\r+\n/g, '\n')
			.replace(/\r/g, '');
	}

	async logsAction(act) {
		const lg = this.lg;
		if (!lg || !lg.boot || lg.busy) return;
		if (act === 'close') return this.closeLogs();
		lg.busy = true;
		try {
			const total = lg.boot.total;
			const lo = lg.chunks.length ? lg.chunks[0].lo : 0;
			const hi = lg.chunks.length ? lg.chunks[lg.chunks.length - 1].hi : 0;
			if (act === 'end') {
				const from = Math.max(0, total - LOG_CHUNK);
				const r = await this.logsRead(from, total);
				lg.chunks = [{ lo: from, hi: r.end, text: r.text }];
				this.logsRender('bottom');
			} else if (act === 'start') {
				const r = await this.logsRead(0, Math.min(total, LOG_CHUNK));
				lg.chunks = [{ lo: 0, hi: r.end, text: r.text }];
				lg.m.querySelector('#cb-logs-follow').checked = false;
				this.logsRender('top');
			} else if (act === 'earlier' && lo > 0) {
				const from = Math.max(0, lo - LOG_CHUNK);
				const r = await this.logsRead(from, lo);
				lg.chunks.unshift({ lo: from, hi: lo, text: r.text });
				if (lg.chunks.length > LOG_KEEP) lg.chunks.pop();
				this.logsRender('keep-bottom');
			} else if (act === 'later' && hi < total) {
				const r = await this.logsRead(hi, Math.min(total, hi + LOG_CHUNK));
				lg.chunks.push({ lo: hi, hi: r.end, text: r.text });
				if (lg.chunks.length > LOG_KEEP) lg.chunks.shift();
				this.logsRender('keep');
			} else if (act === 'find') {
				await this.logsFind();
			} else if (act === 'download') {
				await this.logsDownload();
			}
		} catch (e) {
			this.core.showToast(`Console log: ${e.message}`, 'error');
		} finally {
			lg.busy = false;
		}
	}

	logsText(t) {
		const pre = this.lg?.m.querySelector('#cb-logs-text');
		if (pre) pre.textContent = t;
	}

	logsRender(scroll, mark) {
		const lg = this.lg;
		const pre = lg.m.querySelector('#cb-logs-text');
		const before = pre.scrollHeight - pre.scrollTop;
		const text = lg.chunks.map(c => c.text).join('');
		const i = mark ? text.indexOf(mark) : -1;
		if (i >= 0) {
			const m = document.createElement('mark');
			m.textContent = mark;
			pre.replaceChildren(text.slice(0, i), m, text.slice(i + mark.length));
			m.scrollIntoView({ block: 'center' });
		} else {
			pre.textContent = text || '(empty)';
			if (scroll === 'bottom') pre.scrollTop = pre.scrollHeight;
			else if (scroll === 'top') pre.scrollTop = 0;
			else if (scroll === 'keep-bottom') pre.scrollTop = pre.scrollHeight - before;
		}
		const lo = lg.chunks[0]?.lo || 0;
		const hi = lg.chunks[lg.chunks.length - 1]?.hi || 0;
		lg.m.querySelector('#cb-logs-info').textContent =
			`${this.fmtBytes(lo)} – ${this.fmtBytes(hi)} of ${this.fmtBytes(lg.boot.total)}`;
	}

	// New output of the current boot, or a new boot of the node.
	async logsFollow() {
		const lg = this.lg;
		if (!lg || lg.busy || !lg.m.querySelector('#cb-logs-follow').checked) return;
		lg.busy = true;
		try {
			const newest = lg.boots[0]?.id;
			const hi = lg.chunks.length ? lg.chunks[lg.chunks.length - 1].hi : 0;
			const atEnd = lg.boot && hi >= lg.boot.total;
			await this.logsBoots();
			if (lg.boots[0] && lg.boots[0].id !== newest) {
				lg.boot = lg.boots[0];
				lg.m.querySelector('#cb-logs-boot').value = lg.boot.id;
				lg.chunks = [];
			}
			if (!atEnd && lg.chunks.length) return;
			const total = lg.boot.total;
			if (total <= hi && lg.chunks.length) return;
			const pre = lg.m.querySelector('#cb-logs-text');
			const bottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
			const r = await this.logsRead(hi, Math.min(total, hi + 2 * LOG_CHUNK));
			lg.chunks.push({ lo: hi, hi: r.end, text: r.text });
			if (lg.chunks.length > LOG_KEEP) lg.chunks.shift();
			this.logsRender(bottom ? 'bottom' : 'keep');
		} catch {
			// next round
		} finally {
			lg.busy = false;
		}
	}

	async logsFind() {
		const lg = this.lg;
		const pattern = lg.m.querySelector('#cb-logs-find').value.trim();
		const box = lg.m.querySelector('#cb-logs-matches');
		if (!pattern) {
			box.hidden = true;
			return;
		}
		const res = await this.call('console_grep', { node: lg.node, boot: lg.boot.id, pattern }, 'clusterbox', 60000);
		const hits = (res.matches || '')
			.split('\n')
			.filter(Boolean)
			.map(l => {
				const a = l.indexOf(' ');
				const b = l.indexOf(' ', a + 1);
				return { file: l.slice(0, a), off: Number(l.slice(a + 1, b)), text: this.cleanLog(l.slice(b + 1)) };
			});
		box.hidden = false;
		box.innerHTML = hits.length
			? `<div class="cb-muted">${hits.length}${hits.length >= 500 ? '+' : ''} lines</div>` +
				hits.map((h, i) => `<div class="cb-logs-hit" data-hit="${i}">${this.esc(h.text)}</div>`).join('')
			: '<div class="cb-muted">Not found in this boot.</div>';
		box.querySelectorAll('[data-hit]').forEach(el =>
			el.addEventListener('click', async () => {
				const h = hits[Number(el.dataset.hit)];
				const p = lg.boot.parts.find(q => q.name === h.file);
				if (!p) return;
				const pos = p.start + h.off;
				const from = Math.max(0, pos - LOG_CHUNK / 2);
				lg.m.querySelector('#cb-logs-follow').checked = false;
				const r = await this.logsRead(from, Math.min(lg.boot.total, from + LOG_CHUNK));
				lg.chunks = [{ lo: from, hi: r.end, text: r.text }];
				this.logsRender('keep', h.text.trimEnd());
			})
		);
	}

	async logsDownload() {
		const lg = this.lg;
		const info = lg.m.querySelector('#cb-logs-info');
		const parts = [];
		for (let pos = 0; pos < lg.boot.total; ) {
			const r = await this.logsRead(pos, Math.min(lg.boot.total, pos + 2 * LOG_CHUNK));
			if (r.end <= pos) break;
			parts.push(r.text);
			pos = r.end;
			info.textContent = `downloading ${this.fmtBytes(pos)} of ${this.fmtBytes(lg.boot.total)}`;
		}
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob(parts, { type: 'text/plain' }));
		a.download = `${lg.name}-${lg.boot.id}.log`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 10000);
		info.textContent = `downloaded ${this.fmtBytes(lg.boot.total)}`;
	}

	// ---- dashboard widget ----------------------------------------------

	// ---- firmware (mixtile-update) ---------------------------------------

	shortVersion(v) {
		return String(v || '?').replace(/-(\d+)-g([0-9a-f]{7})[0-9a-f]*$/, '+$1 ($2)');
	}

	async fwLoad() {
		try {
			this.fw = await this.call('fw_status');
		} catch {
			this.fw = null;
		}
		return this.fw;
	}

	// The BMC checks GitHub by itself (mixtile-update watch); here only its
	// result is read, and a banner offers a new release.
	fwWatch() {
		const tick = async () => {
			const fw = await this.fwLoad();
			this.fwBanner(fw);
		};
		clearInterval(this.fwTimer);
		tick();
		this.fwTimer = setInterval(tick, FW_POLL_MS);
	}

	fwBanner(fw) {
		document.getElementById('cb-fw-banner')?.remove();
		const u = fw?.updater;
		if (!u?.update_available || !u.latest_version) return;
		let skip = '';
		try {
			skip = localStorage.getItem('cb-fw-skip') || '';
		} catch {}
		if (skip === u.latest_version) return;
		const b = document.createElement('div');
		b.id = 'cb-fw-banner';
		b.className = 'stat-card cb-fw-banner';
		b.innerHTML = `<div><b>Firmware ${this.esc(u.latest_version)}</b> is available
				<span class="cb-muted">(running ${this.esc(this.shortVersion(u.current_version))})</span></div>
			<div class="cb-fw-banner-actions">
				<button class="action-btn-sm" data-fw="notes">WHAT'S NEW</button>
				<button class="action-btn-sm" data-fw="update">UPDATE</button>
				<button class="action-btn-sm" data-fw="skip" title="Hide until the next release">×</button>
			</div>`;
		b.querySelector('[data-fw="notes"]').onclick = () => this.fwNotes();
		b.querySelector('[data-fw="update"]').onclick = () => this.fwUpdate();
		b.querySelector('[data-fw="skip"]').onclick = () => {
			try {
				localStorage.setItem('cb-fw-skip', u.latest_version);
			} catch {}
			b.remove();
		};
		(document.querySelector('main.content') || document.body).prepend(b);
	}

	// Release notes (GitHub markdown) as HTML: escaped first, then a small
	// subset — headings, lists, quotes and [!NOTE]-style alerts, code,
	// tables, bold, links (http/https only).
	markdown(md) {
		const inline = t =>
			this.esc(t)
				.replace(/`([^`]+)`/g, '<code>$1</code>')
				.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
				.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, txt, url) => `<a href="${url}" target="_blank" rel="noopener">${txt}</a>`);
		const out = [];
		let list = null;
		let quote = null;
		let code = null;
		let table = null;
		let para = null;
		const flush = () => {
			// Hard-wrapped lines of one paragraph go together.
			if (para) out.push(`<p>${inline(para.join(' '))}</p>`);
			if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
			if (quote) {
				const m = quote[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/);
				const body = (m ? quote.slice(1) : quote).map(inline).join(' ');
				out.push(`<blockquote class="cb-md-quote${m ? ` ${m[1].toLowerCase()}` : ''}">${m ? `<b>${m[1]}</b> ` : ''}${body}</blockquote>`);
			}
			if (table) {
				const rows = table.filter(r => !/^\s*\|?\s*:?-+/.test(r)).map(r => r.replace(/^\s*\||\|\s*$/g, '').split('|'));
				out.push(`<table class="cb-md-table">${rows
					.map((r, i) => `<tr>${r.map(c => (i ? `<td>${inline(c.trim())}</td>` : `<th>${inline(c.trim())}</th>`)).join('')}</tr>`)
					.join('')}</table>`);
			}
			list = quote = table = para = null;
		};
		for (const line of String(md || '').replace(/\r/g, '').split('\n')) {
			if (code) {
				if (/^```/.test(line)) {
					out.push(`<pre class="cb-md-code">${this.esc(code.join('\n'))}</pre>`);
					code = null;
				} else code.push(line);
				continue;
			}
			if (/^```/.test(line)) {
				flush();
				code = [];
				continue;
			}
			let m;
			if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
				flush();
				out.push(`<div class="cb-md-h${m[1].length}">${inline(m[2])}</div>`);
			} else if ((m = line.match(/^\s*[-*]\s+(.*)$/)) || (m = line.match(/^\s*\d+\.\s+(.*)$/))) {
				const tag = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
				if (!list || list.tag !== tag) {
					flush();
					list = { tag, items: [] };
				}
				list.items.push(m[1]);
			} else if ((m = line.match(/^>\s?(.*)$/))) {
				if (!quote) {
					flush();
					quote = [];
				}
				quote.push(m[1]);
			} else if (/^\s*\|/.test(line)) {
				if (!table) {
					flush();
					table = [];
				}
				table.push(line);
			} else if (!line.trim()) {
				flush();
			} else if (list && /^\s{2,}/.test(line)) {
				list.items[list.items.length - 1] += ' ' + line.trim();
			} else {
				if (!para) {
					flush();
					para = [];
				}
				para.push(line.trim());
			}
		}
		flush();
		if (code) out.push(`<pre class="cb-md-code">${this.esc(code.join('\n'))}</pre>`);
		return out.join('');
	}

	modal(title, body, buttons) {
		const m = document.createElement('div');
		m.className = 'modal';
		m.innerHTML = `<div class="modal-backdrop"></div>
			<div class="modal-content cb-fw-modal">
				<div class="modal-header"><h3 class="modal-title">${this.esc(title)}</h3></div>
				<div class="modal-body">${body}</div>
				<div class="modal-footer">${buttons}</div>
			</div>`;
		document.body.appendChild(m);
		m.querySelector('.modal-backdrop').onclick = () => m.remove();
		return m;
	}

	async fwNotes() {
		const fw = this.fw || (await this.fwLoad());
		const c = fw?.check || {};
		const u = fw?.updater || {};
		if (!c.latest_version) return this.core.showToast('No release check yet', 'error');
		const meta = [
			c.published_at ? `published ${new Date(c.published_at).toLocaleString()}` : '',
			c.prerelease ? 'release candidate' : 'stable',
			c.image_size ? this.fmtBytes(c.image_size) : '',
			c.signed ? 'signed' : 'not signed',
			c.openmiop_protocol ? `OpenMIOP v${c.openmiop_protocol}` : ''
		].filter(Boolean);
		const m = this.modal(
			`FIRMWARE ${c.latest_version}`,
			`<div class="cb-fw-versions"><span>${this.esc(this.shortVersion(u.current_version))}</span><span class="cb-fw-arrow">→</span>
				<span class="cb-fw-new">${this.esc(c.latest_version)}</span></div>
				<div class="cb-muted" style="margin-bottom:12px">${this.esc(meta.join(' · '))}</div>
				<div class="cb-md">${this.markdown(c.release_notes) || '<p class="cb-muted">No release notes.</p>'}</div>`,
			`${c.release_url ? `<a class="action-btn" href="${this.esc(c.release_url)}" target="_blank" rel="noopener">RELEASE PAGE</a>` : ''}
				<button class="action-btn" data-fw="close">CLOSE</button>
				${u.update_available ? '<button class="action-btn" data-fw="update">UPDATE NOW</button>' : ''}`
		);
		m.querySelector('[data-fw="close"]').onclick = () => m.remove();
		const up = m.querySelector('[data-fw="update"]');
		if (up)
			up.onclick = () => {
				m.remove();
				this.fwUpdate();
			};
	}

	// Download, verify, install (mixtile-update), then wait for the BMC to
	// come back with the new firmware and reload the page.
	async fwUpdate() {
		const fw = await this.fwLoad();
		const c = fw?.check || {};
		const u = fw?.updater || {};
		if (!u.update_available) return this.core.showToast('No update available', 'error');
		if (
			!confirm(
				`Install firmware ${c.latest_version}?\n\nThe BMC reboots (a few minutes). It is the PCIe root complex: every blade loses its link and reconnects; blade network through the BMC is down meanwhile.`
			)
		)
			return;
		document.getElementById('cb-fw-banner')?.remove();
		const m = this.modal(
			`UPDATING TO ${c.latest_version}`,
			`<ol class="cb-fw-steps">
				<li data-step="download">Download <span class="cb-muted" data-info="download"></span>
					<div class="progress-bar"><div class="progress-fill" data-bar style="width:0%"></div></div></li>
				<li data-step="verify">Verify (SHA-256, board, signature)</li>
				<li data-step="install">Install and reboot the BMC</li>
				<li data-step="wait">Wait for the BMC <span class="cb-muted" data-info="wait"></span></li>
			</ol>
			<div class="cb-muted" data-msg>Do not power off the Cluster Box.</div>`,
			'<button class="action-btn" data-fw="close" disabled>CLOSE</button>'
		);
		m.querySelector('.modal-backdrop').onclick = null;
		const step = (name, state) => {
			const li = m.querySelector(`[data-step="${name}"]`);
			if (li) li.className = state;
		};
		const fail = msg => {
			m.querySelector('[data-msg]').textContent = `Failed: ${msg}`;
			m.querySelector('[data-fw="close"]').disabled = false;
			m.querySelector('[data-fw="close"]').onclick = () => m.remove();
		};
		const sleep = ms => new Promise(r => setTimeout(r, ms));
		try {
			step('download', 'active');
			let r = await this.call('fw_download', {}, 'clusterbox', 30000);
			if (r.status === 'error') throw new Error(r.message);
			for (let n = 0; ; n++) {
				await sleep(2000);
				const st = (await this.fwLoad())?.updater || {};
				const pct = c.image_size ? Math.min(100, (st.downloaded_bytes * 100) / c.image_size) : 0;
				m.querySelector('[data-bar]').style.width = `${pct.toFixed(0)}%`;
				m.querySelector('[data-info="download"]').textContent =
					`${this.fmtBytes(st.downloaded_bytes || 0)} of ${this.fmtBytes(c.image_size || 0)}`;
				if (st.download === 'done') break;
				// "none" for a moment while the background download starts.
				if (st.download === 'failed' || (st.download === 'none' && n > 4)) throw new Error(st.download_error || 'download failed');
			}
			step('download', 'done');
			step('verify', 'active');
			r = await this.call('fw_install', {}, 'clusterbox', 120000);
			if (r.status === 'error') throw new Error(r.message);
			step('verify', 'done');
			step('install', 'active');
		} catch (e) {
			return fail(e.message);
		}
		// The BMC goes away during sysupgrade; the page reloads once it
		// serves the web UI again (index.html picks up the new files).
		const t0 = Date.now();
		let down = false;
		for (;;) {
			await sleep(3000);
			const secs = Math.round((Date.now() - t0) / 1000);
			m.querySelector('[data-info="wait"]').textContent = `${secs} s`;
			let ok = false;
			try {
				ok = (await fetch('/moci/version.txt', { cache: 'no-store' })).ok;
			} catch {}
			if (!ok && !down) {
				down = true;
				step('install', 'done');
				step('wait', 'active');
			}
			if (ok && down) {
				step('wait', 'done');
				m.querySelector('[data-msg]').textContent = 'The BMC is back. Reloading…';
				await sleep(2000);
				location.reload();
				return;
			}
			if (secs > 900) return fail('the BMC did not come back within 15 minutes; check it on the network or its UART');
		}
	}

	async loadFirmware(body = this.fwEl) {
		this.fwEl = body;
		body.innerHTML = '<div class="stat-card">Loading…</div>';
		const fw = await this.fwLoad();
		if (!fw) {
			body.innerHTML = '<div class="stat-card cb-muted">Firmware information unavailable.</div>';
			return;
		}
		const u = fw.updater || {};
		const c = fw.check || {};
		const release = RELEASE_RE.test(u.current_version || '');
		const repo = u.repository ? `https://github.com/${u.repository}` : '';
		const bar = (used, size, label) => {
			const pct = size ? Math.min(100, (used * 100) / size) : 0;
			return `<div class="cb-node-row"><span>${label}</span><span>${this.fmtBytes(used * 1024)} of ${this.fmtBytes(size * 1024)}</span></div>
				<div class="progress-bar"><div class="progress-fill" style="width:${pct.toFixed(1)}%"></div></div>`;
		};
		const checked = u.checked_at ? new Date(u.checked_at) : null;
		const ago = checked ? this.fmtDur((Date.now() - checked.getTime()) / 1000) : '';
		let state;
		if (fw.checking) state = this.core.renderBadge('warning', 'CHECKING');
		else if (u.update_available) state = this.core.renderBadge('warning', `${u.latest_version} AVAILABLE`);
		else if (!checked) state = this.core.renderBadge('error', 'NOT CHECKED YET');
		else state = this.core.renderBadge('success', release ? 'UP TO DATE' : 'NO UPDATE');
		const last = (u.last_install || '').split(' ');
		body.innerHTML = `<div class="cb-grid2">
			<div class="stat-card">
				<div class="section-title">RUNNING FIRMWARE</div>
				<div class="cb-fw-big">${this.esc(this.shortVersion(u.current_version))}</div>
				<div class="cb-muted" style="margin-bottom:12px">${release ? 'release' : 'development build: updates are offered between releases only'}</div>
				<div class="cb-node-row"><span>OpenWrt</span><span>${this.esc(fw.openwrt)} (${this.esc(fw.openwrt_revision)})</span></div>
				<div class="cb-node-row"><span>Kernel</span><span>${this.esc(fw.kernel)}</span></div>
				<div class="cb-node-row"><span>Commit</span><span class="cb-mono">${u.current_commit ? (repo ? `<a href="${this.esc(repo)}/commit/${this.esc(u.current_commit)}" target="_blank" rel="noopener">${this.esc(u.current_commit.slice(0, 10))}</a>` : this.esc(u.current_commit.slice(0, 10))) : '—'}</span></div>
				<div class="cb-node-row"><span>Built</span><span>${u.build_date ? this.esc(new Date(u.build_date).toLocaleString()) : '—'}</span></div>
				<div class="cb-node-row"><span>Board</span><span class="cb-mono">${this.esc(u.board || '')}</span></div>
				<div class="cb-node-row"><span>OpenMIOP protocol</span><span>v${this.esc(u.openmiop_protocol || '?')}</span></div>
				${last[0] ? `<div class="cb-node-row"><span>Last update</span><span>${this.esc(last[1] || '')} ${last[0] === 'ok' ? this.core.renderBadge('success', 'OK') : this.core.renderBadge('error', 'MISMATCH')}</span></div>` : ''}
				<div style="margin-top:12px">${bar(fw.rootfs_used_kb, fw.rootfs_part_kb, 'System partition (eMMC p2)')}</div>
				<div style="margin-top:8px">${bar(fw.overlay_used_kb, fw.overlay_size_kb, 'Overlay, logs (eMMC p3)')}</div>
			</div>
			<div class="stat-card">
				<div class="section-title">UPDATES</div>
				<div class="cb-node-row"><span>State</span><span>${state}</span></div>
				<div class="cb-node-row"><span>Latest release</span><span>${c.latest_version ? this.esc(c.latest_version) + (c.prerelease ? ' (rc)' : '') : '—'}</span></div>
				<div class="cb-node-row"><span>Channel</span><span>${this.esc(u.channel || '')}</span></div>
				<div class="cb-node-row"><span>Source</span><span>${repo ? `<a href="${this.esc(repo)}/releases" target="_blank" rel="noopener">${this.esc(u.repository)}</a>` : '—'}</span></div>
				<div class="cb-node-row"><span>Last check</span><span>${checked ? `${this.esc(checked.toLocaleString())} (${ago} ago)` : 'never'}</span></div>
				<div class="cb-node-row"><span>Background check</span><span>${fw.auto_check ? `every ${fw.check_interval} h` : 'off'}</span></div>
				${c.message ? `<div class="cb-muted" style="margin-top:8px">${this.esc(c.message)}</div>` : ''}
				<div class="cb-node-actions">
					<button class="action-btn-sm" data-fw="check">CHECK NOW</button>
					${c.latest_version ? `<button class="action-btn-sm" data-fw="notes">WHAT'S NEW IN ${this.esc(c.latest_version)}</button>` : ''}
					${u.update_available ? '<button class="action-btn-sm" data-fw="update">UPDATE</button>' : ''}
				</div>
			</div>
		</div>
		${c.release_notes ? `<div class="stat-card" style="margin-top:16px"><div class="section-title">RELEASE NOTES ${this.esc(c.latest_version)}</div><div class="cb-md">${this.markdown(c.release_notes)}</div></div>` : ''}`;
		body.querySelector('[data-fw="notes"]')?.addEventListener('click', () => this.fwNotes());
		body.querySelector('[data-fw="update"]')?.addEventListener('click', () => this.fwUpdate());
		body.querySelector('[data-fw="check"]').addEventListener('click', async e => {
			e.target.disabled = true;
			e.target.textContent = 'CHECKING…';
			const before = u.checked_at;
			try {
				await this.call('fw_check');
				for (let i = 0; i < 40; i++) {
					await new Promise(r => setTimeout(r, 3000));
					const f = await this.fwLoad();
					if (f && !f.checking && f.updater?.checked_at !== before) break;
				}
			} catch (err) {
				this.core.showToast(`Check failed: ${err.message}`, 'error');
			}
			this.fwBanner(this.fw);
			if (body.isConnected) this.loadFirmware(body);
		});
	}

	// ---- access ------------------------------------------------------------

	async loadAccess(body) {
		this.accessEl = body;
		let a;
		try {
			a = await this.call('admin_get');
		} catch (e) {
			body.innerHTML = `<div class="stat-card cb-muted">${this.esc(e.message)}</div>`;
			return;
		}
		const inp = (id, label, val, hint) => `<div class="form-group"><label class="form-label">${label}</label>
			<input type="number" min="0" max="65535" class="form-input" id="cb-${id}" value="${this.esc(val)}">
			${hint ? `<div class="cb-muted">${hint}</div>` : ''}</div>`;
		const zones = (a.all_zones || []).map(z => `<label class="cb-check"><input type="checkbox" data-zone="${this.esc(z)}"
			${(a.zones || []).includes(z) ? 'checked' : ''}> ${this.esc(z)}</label>`).join('');
		body.innerHTML = `<div class="cb-grid2">
			<div class="stat-card"><div class="section-title">WEB UI AND CONSOLES</div>
				${inp('http_port', 'HTTP PORT', a.http_port)}
				${inp('https_port', 'HTTPS PORT', a.https_port, '0 turns HTTPS off')}
				<label class="cb-check"><input type="checkbox" id="cb-redirect_https" ${a.redirect_https === '1' ? 'checked' : ''}> Redirect HTTP to HTTPS</label>
				${inp('terminal_port', 'TERMINAL PORT (LuCI terminal)', a.terminal_port)}
				${inp('console_port', 'NODE CONSOLE PORT', a.console_port)}
			</div>
			<div class="stat-card"><div class="section-title">SSH</div>
				${inp('ssh_port', 'SSH PORT', a.ssh_port)}
				<label class="cb-check"><input type="checkbox" id="cb-ssh_password" ${a.ssh_password !== '0' ? 'checked' : ''}> Password login for mixtile (off = keys only; root: keys only)</label>
				<div class="section-title" style="margin-top:16px">REACHABLE FROM ZONES</div>
				${zones}
				<div class="cb-muted">The ports above are rejected on the zones not ticked.</div>
			</div></div>
			<div class="stat-card" style="margin-top:16px">
				<div class="cb-muted">Saving takes a configuration snapshot and applies the settings. Unless the new address is opened and confirms
				within 120 s, the snapshot is restored automatically.</div>
				<div class="quick-actions"><button class="action-btn" id="cb-access-save">SAVE AND APPLY</button></div>
			</div>`;
		body.querySelector('#cb-access-save').addEventListener('click', () => this.saveAccess());
	}

	async saveAccess() {
		const v = id => document.getElementById(`cb-${id}`).value.trim();
		const params = {
			http_port: v('http_port'),
			https_port: v('https_port') || '0',
			redirect_https: document.getElementById('cb-redirect_https').checked ? '1' : '0',
			ssh_port: v('ssh_port'),
			ssh_password: document.getElementById('cb-ssh_password').checked ? '1' : '0',
			terminal_port: v('terminal_port'),
			console_port: v('console_port'),
			zones: Array.from(document.querySelectorAll('[data-zone]')).filter(c => c.checked).map(c => c.dataset.zone)
		};
		if (!params.zones.length) return this.core.showToast('Tick at least one zone', 'error');
		let res;
		try {
			res = await this.call('admin_set', params);
		} catch (e) {
			return this.core.showToast(e.message, 'error');
		}
		const https = window.location.protocol === 'https:' && params.https_port !== '0';
		const port = https ? params.https_port : params.http_port;
		const url = `${https ? 'https' : 'http'}://${window.location.hostname}:${port}/moci/?cbconfirm=${encodeURIComponent(res.token)}#/system/admin`;
		this.core.showToast('Applying; opening the new address to confirm…', 'info');
		this.accessEl.insertAdjacentHTML('afterbegin', `<div class="stat-card cb-banner">
			Applying. If this page does not move on by itself, open <a href="${this.esc(url)}">${this.esc(url)}</a>
			within ${res.timeout} s, otherwise the previous settings come back.</div>`);
		setTimeout(() => (window.location.href = url), 5000);
	}

	// ---- services ----------------------------------------------------------

	// Settings of the BMC's own services (UCI clusterbox), one card per
	// group; each card sits on the page it belongs to (DNS/DHCP on
	// NETWORK > DHCP & DNS, the WAN fallback on INTERFACES, time on
	// SYSTEM > GENERAL, the log on LOGS, the history on BACKUP).
	async loadServices(body, cards) {
		let c;
		try {
			const [st, data] = await this.core.uciGet('clusterbox');
			if (st !== 0) throw new Error(`uci status ${st}`);
			c = data.values || {};
		} catch (e) {
			body.innerHTML = `<div class="stat-card cb-muted">${this.esc(e.message)}</div>`;
			return;
		}
		const g = (s, o, d = '') => (c[s] && c[s][o] != null ? c[s][o] : d);
		const chk = (s, o, label, d = '1') => `<label class="cb-check"><input type="checkbox" data-s="${s}" data-o="${o}" data-type="bool"
			${g(s, o, d) === '1' ? 'checked' : ''}> ${label}</label>`;
		const txt = (s, o, label, ph = '', hint = '') => {
			const v = g(s, o);
			return `<div class="form-group"><label class="form-label">${label}</label>
				<input type="text" class="form-input" data-s="${s}" data-o="${o}" data-type="${Array.isArray(v) ? 'list' : 'text'}"
				value="${this.esc(Array.isArray(v) ? v.join(' ') : v)}" placeholder="${this.esc(ph)}">
				${hint ? `<div class="cb-muted">${hint}</div>` : ''}</div>`;
		};
		const CARDS = {
			dns: () => `<div class="section-title">DNS, DHCP AND NAMES FOR THE BLADES (omi0)</div>
				<div class="cb-grid2"><div>
					${chk('dns', 'enabled', 'Answer DNS on omi0 (10.20.0.1)')}
					${txt('dns', 'domain', 'LOCAL DOMAIN', 'cluster')}
					${txt('dns', 'server', 'UPSTREAM DNS SERVERS', 'from WAN DHCP', 'Space separated, e.g. 1.1.1.1 9.9.9.9; empty = the servers WAN DHCP gives')}
					${chk('dns', 'node_records', 'Names for the BMC (bmc) and the nodes (blade1…4 and their names)')}
				</div><div>
					${chk('dns', 'dhcp', 'DHCP on omi0 (gateway, DNS and NTP: the BMC)')}
					${txt('dns', 'dhcp_start', 'FIRST ADDRESS (10.20.0.x)', '20', 'The blades, 10.20.0.205 and the MetalLB pool 210-219 are static; keep the range clear of them')}
					${txt('dns', 'dhcp_limit', 'NUMBER OF ADDRESSES', '80')}
					${txt('dns', 'dhcp_lease', 'LEASE TIME', '12h')}
				</div></div>`,
			ntp: () => `<div class="section-title">TIME SERVER FOR THE BLADES</div>
				${chk('ntp', 'serve_blades', 'NTP server on 10.20.0.1 (sysntpd; the blades and DHCP clients use it)')}`,
			log: () => `<div class="section-title">LOG STORAGE</div>
				<div class="cb-grid2"><div>
					${chk('log', 'persistent', 'Keep the system log on the eMMC (/overlay/log)')}
					${txt('log', 'size', 'LOG SIZE, KiB', '1024')}
				</div><div>
					${txt('log', 'remote_ip', 'REMOTE SYSLOG SERVER', 'none')}
					${txt('log', 'remote_port', 'REMOTE SYSLOG PORT', '514')}
				</div></div>`,
			wan: () => `<div class="section-title">WAN FALLBACK ADDRESS</div>
				${chk('wan', 'fallback', 'Add a fallback address when WAN DHCP does not answer, so the BMC stays reachable')}
				<div class="cb-grid2"><div>
					${txt('wan', 'fallback_ipaddr', 'ADDRESS/PREFIX', 'last DHCP address', 'Empty = the last address DHCP gave')}
					${txt('wan', 'fallback_gateway', 'GATEWAY', 'last DHCP gateway')}
				</div><div>
					${txt('wan', 'fallback_delay', 'WAIT FOR DHCP, s', '60')}
				</div></div>`,
			history: () => `<div class="section-title">SNAPSHOT SETTINGS</div>
				${txt('history', 'keep', 'SNAPSHOTS TO KEEP', '50')}
				${chk('history', 'daily', 'Daily snapshot')}`
		};
		body.innerHTML = `<div class="stat-card">${cards.map(k => CARDS[k]()).join('')}
			<div class="quick-actions" style="margin-top:12px"><button class="action-btn" data-cbsave>SAVE AND APPLY</button></div></div>`;
		body.querySelector('[data-cbsave]').addEventListener('click', () => this.saveServices(body));
	}

	async saveServices(body) {
		const sections = {};
		body.querySelectorAll('[data-s]').forEach(el => {
			const s = el.dataset.s;
			sections[s] = sections[s] || {};
			if (el.dataset.type === 'bool') sections[s][el.dataset.o] = el.checked ? '1' : '0';
			else if (el.dataset.o === 'server') sections[s][el.dataset.o] = el.value.trim().split(/[\s,]+/).filter(Boolean);
			else sections[s][el.dataset.o] = el.value.trim();
		});
		try {
			for (const [s, values] of Object.entries(sections)) {
				// An empty list cannot be set; delete it instead.
				if (Array.isArray(values.server) && !values.server.length) {
					delete values.server;
					await this.core.uciDelete('clusterbox', s, 'server').catch(() => {});
				}
				const [st] = await this.core.uciSet('clusterbox', s, values);
				if (st !== 0) throw new Error(`uci set ${s}: status ${st}`);
			}
			const [st] = await this.core.uciCommit('clusterbox');
			if (st !== 0) throw new Error(`uci commit: status ${st}`);
			this.core.showToast('Saved; the BMC applies the settings now', 'success');
		} catch (e) {
			this.core.showToast(e.message, 'error');
		}
	}

	// ---- configuration history ------------------------------------------

	async loadHistory(body = this.histEl) {
		this.histEl = body;
		let h;
		try {
			h = await this.call('history_list');
		} catch (e) {
			body.innerHTML = `<div class="stat-card cb-muted">${this.esc(e.message)}</div>`;
			return;
		}
		const rows = (h.snapshots || []).map(s => `<tr>
			<td class="cb-mono">${this.esc(new Date(s.time * 1000).toLocaleString())}</td>
			<td>${this.esc(s.reason)}</td>
			<td class="cb-mono">${this.esc(s.changed)}</td>
			<td>${this.esc(this.core.formatBytes(s.size))}</td>
			<td style="white-space:nowrap">
				<button class="action-btn-sm" data-h="diff" data-id="${this.esc(s.id)}">DIFF</button>
				<button class="action-btn-sm" data-h="download" data-id="${this.esc(s.id)}">DOWNLOAD</button>
				<button class="action-btn-sm" data-h="restore" data-id="${this.esc(s.id)}">RESTORE</button>
				<button class="action-btn-sm danger" data-h="delete" data-id="${this.esc(s.id)}">DELETE</button>
			</td></tr>`).join('');
		body.innerHTML = `<div class="stat-card">
			<div class="section-title">SNAPSHOTS <span class="cb-muted">(${this.esc(h.dir)}, newest ${this.esc(h.keep)} kept)</span></div>
			<div class="quick-actions" style="margin-bottom:12px"><button class="action-btn" id="cb-snap-now">TAKE SNAPSHOT NOW</button></div>
			<table class="data-table"><thead><tr><th>TIME</th><th>REASON</th><th>CHANGED</th><th>SIZE</th><th></th></tr></thead>
			<tbody>${rows || '<tr><td colspan="5" class="cb-muted">No snapshots yet.</td></tr>'}</tbody></table></div>
			<div id="cb-diff-box"></div>`;
		document.getElementById('cb-snap-now').addEventListener('click', async () => {
			try {
				await this.call('history_snapshot', { reason: 'manual (web UI)' });
				this.loadHistory();
			} catch (e) {
				this.core.showToast(e.message, 'error');
			}
		});
		body.querySelectorAll('[data-h]').forEach(btn => btn.addEventListener('click', () => this.historyAction(btn.dataset.h, btn.dataset.id)));
	}

	async historyAction(act, id) {
		try {
			if (act === 'diff') return await this.showDiff(id);
			if (act === 'download') return await this.download(id);
			if (act === 'delete') {
				if (!confirm(`Delete snapshot ${id}?`)) return;
				await this.call('history_delete', { id });
				return this.loadHistory();
			}
			if (act === 'restore') {
				if (!confirm(`Restore the configuration of ${id}? A snapshot of the current state is taken first; the restore is rolled back after 120 s unless you keep it.`)) return;
				const res = await this.call('history_restore', { id });
				this.restoreGuard(res);
			}
		} catch (e) {
			this.core.showToast(e.message, 'error');
		}
	}

	restoreGuard(res) {
		const box = document.getElementById('cb-diff-box');
		let left = res.timeout;
		box.innerHTML = `<div class="stat-card cb-banner">Restoring. Keep this configuration? Rolled back in <b id="cb-left">${left}</b> s.
			<div class="quick-actions"><button class="action-btn" id="cb-keep">KEEP</button></div></div>`;
		const iv = setInterval(() => {
			left -= 1;
			const el = document.getElementById('cb-left');
			if (el) el.textContent = Math.max(0, left);
			if (left <= 0 || !el) clearInterval(iv);
		}, 1000);
		document.getElementById('cb-keep').addEventListener('click', async () => {
			try {
				await this.call('confirm', { token: res.token });
				clearInterval(iv);
				this.core.showToast('Restored configuration kept', 'success');
				this.loadHistory();
			} catch (e) {
				this.core.showToast(e.message, 'error');
			}
		});
	}

	async showDiff(id) {
		const box = document.getElementById('cb-diff-box');
		const { files = [] } = await this.call('history_files', { id });
		const opts = files.map(f => `<option value="${this.esc(f)}">${this.esc(f)}</option>`).join('');
		box.innerHTML = `<div class="stat-card"><div class="section-title">DIFF ${this.esc(id)} → CURRENT</div>
			<select class="form-input" id="cb-diff-file">${opts}</select><div id="cb-diff" class="cb-diff log-viewer" style="margin-top:12px"></div></div>`;
		const sel = document.getElementById('cb-diff-file');
		const show = async () => {
			const f = await this.call('history_file', { id, path: sel.value });
			document.getElementById('cb-diff').innerHTML = this.diffHtml(f.snapshot || '', f.exists ? f.current || '' : '', id);
		};
		sel.addEventListener('change', show);
		// Start with the first file that differs.
		for (const f of files) {
			const r = await this.call('history_file', { id, path: f });
			if (!r.exists || r.current !== r.snapshot) {
				sel.value = f;
				break;
			}
		}
		show();
		box.scrollIntoView({ behavior: 'smooth' });
	}

	// Line diff (LCS) as a unified-style listing with 3 lines of context.
	diffHtml(a, b, id) {
		const A = a.split('\n');
		const B = b.split('\n');
		if (A.length * B.length > 4e6) return '<span class="cb-muted">File too large to compare here.</span>';
		const n = A.length;
		const m = B.length;
		const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
		for (let i = n - 1; i >= 0; i--)
			for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
		const ops = [];
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (A[i] === B[j]) ops.push([' ', A[i++], j++]);
			else if (L[i + 1][j] >= L[i][j + 1]) ops.push(['-', A[i++]]);
			else ops.push(['+', B[j++]]);
		}
		while (i < n) ops.push(['-', A[i++]]);
		while (j < m) ops.push(['+', B[j++]]);
		if (!ops.some(o => o[0] !== ' ')) return `<span class="cb-muted">No difference: the current file equals snapshot ${this.esc(id)}.</span>`;
		const keepIdx = new Set();
		ops.forEach((o, k) => {
			if (o[0] !== ' ') for (let d = -3; d <= 3; d++) keepIdx.add(k + d);
		});
		let out = `<span class="del">--- snapshot ${this.esc(id)}</span>\n<span class="add">+++ current</span>\n`;
		let gap = false;
		ops.forEach((o, k) => {
			if (!keepIdx.has(k)) {
				if (!gap) out += '<span class="hunk">@@ … @@</span>\n';
				gap = true;
				return;
			}
			gap = false;
			const cls = o[0] === '+' ? 'add' : o[0] === '-' ? 'del' : '';
			out += `<span class="${cls}">${o[0]} ${this.esc(o[1])}</span>\n`;
		});
		return out;
	}

	async download(id) {
		const { dir } = await this.call('history_list');
		const [st, data] = await this.core.ubusCall('file', 'read', { path: `${dir}/${id}.tar.gz`, base64: true });
		if (st !== 0 || !data?.data) throw new Error(`cannot read snapshot (status ${st})`);
		const bin = atob(data.data);
		const bytes = new Uint8Array(bin.length);
		for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }));
		a.download = `clusterbox-config-${id}.tar.gz`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 10000);
	}

	// ---- Tailscale ---------------------------------------------------------

	async loadTailscale(body = this.tsEl) {
		this.tsEl = body;
		let s;
		try {
			s = await this.call('tailscale_status');
		} catch (e) {
			body.innerHTML = `<div class="stat-card cb-muted">${this.esc(e.message)}</div>`;
			return;
		}
		if (!s.installed) {
			body.innerHTML = '<div class="stat-card cb-muted">Tailscale is not installed on this firmware.</div>';
			return;
		}
		const running = s.state === 'Running';
		body.innerHTML = `<div class="cb-grid2">
			<div class="stat-card"><div class="section-title">STATUS</div>
				<div class="cb-node-row"><span>State</span><span>${running ? this.core.renderBadge('success', 'RUNNING') : this.core.renderBadge('warning', this.esc((s.state || 'stopped').toUpperCase()))}</span></div>
				<div class="cb-node-row"><span>Tailnet address</span><span class="cb-mono">${this.esc(s.ipaddr || '—')}</span></div>
				<div class="cb-node-row"><span>Name</span><span class="cb-mono">${this.esc(s.dnsname || '—')}</span></div>
				<div class="cb-node-row"><span>Routes</span><span class="cb-mono">${this.esc(s.routes || '—')}</span></div>
				${s.auth_url ? `<p>Log in to add this BMC to your tailnet: <a href="${this.esc(s.auth_url)}" target="_blank" rel="noopener noreferrer">${this.esc(s.auth_url)}</a></p>` : ''}
			</div>
			<div class="stat-card"><div class="section-title">CONNECT</div>
				<div class="form-group"><label class="form-label">AUTH KEY (optional)</label>
					<input type="password" class="form-input" id="cb-ts-key" placeholder="tskey-… or empty for a login link"></div>
				<label class="cb-check"><input type="checkbox" id="cb-ts-routes" checked> Route the blades (advertise 10.20.0.0/24)</label>
				<label class="cb-check"><input type="checkbox" id="cb-ts-ssh"> Tailscale SSH</label>
				<div class="quick-actions">
					<button class="action-btn" id="cb-ts-up">${running ? 'APPLY' : 'CONNECT'}</button>
					${running ? '<button class="action-btn" id="cb-ts-down">DISCONNECT</button>' : ''}
					<button class="action-btn" id="cb-ts-logout">LOG OUT</button>
				</div>
				<div class="cb-muted">Advertised routes must be approved in the Tailscale admin console.</div>
			</div></div>`;
		const act = async (method, params = {}) => {
			try {
				await this.call(method, params, 'clusterbox', 60000);
				this.core.showToast('Done', 'success');
			} catch (e) {
				this.core.showToast(e.message, 'error');
			}
			setTimeout(() => this.loadTailscale(), 3000);
		};
		document.getElementById('cb-ts-up').addEventListener('click', () =>
			act('tailscale_up', {
				authkey: document.getElementById('cb-ts-key').value.trim(),
				routes: document.getElementById('cb-ts-routes').checked ? '1' : '0',
				ssh: document.getElementById('cb-ts-ssh').checked ? '1' : '0'
			})
		);
		document.getElementById('cb-ts-down')?.addEventListener('click', () => act('tailscale_down'));
		document.getElementById('cb-ts-logout').addEventListener('click', () => confirm('Log this BMC out of the tailnet?') && act('tailscale_logout'));
	}
}
