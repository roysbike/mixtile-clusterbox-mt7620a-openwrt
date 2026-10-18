// ClusterBox add-on for MoCI: cluster topology and nodes, management
// access, services for the blades, configuration history, Tailscale.
// Backend: ubus objects "clusterbox" (package clusterbox) and "nodectl".

const TABS = [
	['overview', 'OVERVIEW'],
	['access', 'ACCESS'],
	['services', 'SERVICES'],
	['history', 'CONFIG HISTORY'],
	['tailscale', 'TAILSCALE']
];
const POLL_MS = 5000;

export default class ClusterBoxAddon {
	constructor(core) {
		this.core = core;
		this.timer = null;
		this.widgetTimer = null;
		this.prev = null;
		this.core.registerRoute('/cluster', (path, sub) => this.route(sub || []));
	}

	async init() {
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

	getExtensions() {
		return {
			'dashboard:widget': { id: 'cb-dashboard-topology', render: el => this.renderWidget(el) }
		};
	}

	cleanup() {
		this.stopPolling();
		clearInterval(this.widgetTimer);
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
		const tab = TABS.some(t => t[0] === sub[0]) ? sub[0] : 'overview';
		const page = this.page();
		if (!page) return;
		page.innerHTML = `<h2>CLUSTERBOX</h2>
			<div class="tabs">${TABS.map(
				([id, label]) => `<button class="tab-btn${id === tab ? ' active' : ''}" data-cbtab="${id}">${label}</button>`
			).join('')}</div>
			<div id="cb-pending"></div>
			<div id="cb-body"></div>`;
		page.querySelectorAll('[data-cbtab]').forEach(btn =>
			btn.addEventListener('click', () => this.core.navigate(`/cluster/${btn.dataset.cbtab}`))
		);
		this.showPending();
		const handlers = {
			overview: () => this.loadOverview(),
			access: () => this.loadAccess(),
			services: () => this.loadServices(),
			history: () => this.loadHistory(),
			tailscale: () => this.loadTailscale()
		};
		handlers[tab]();
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

	// ---- overview: topology + nodes ---------------------------------------

	async loadOverview() {
		const body = document.getElementById('cb-body');
		body.innerHTML = `<div class="stat-card"><div class="section-title">TOPOLOGY</div><div id="cb-topo">Loading…</div></div>
			<div class="section-title" style="margin-top:24px">NODES</div><div id="cb-nodes" class="cb-nodes"></div>`;
		const tick = async () => {
			if (!document.getElementById('cb-topo')) return this.stopPolling();
			try {
				const t = await this.call('topology');
				const rates = this.rates(t);
				document.getElementById('cb-topo').innerHTML = this.topologySvg(t, rates, false);
				this.renderNodes(t);
			} catch (e) {
				document.getElementById('cb-topo').innerHTML = `<div class="cb-muted">Topology unavailable: ${this.esc(e.message)}</div>`;
			}
			this.timer = setTimeout(tick, POLL_MS);
		};
		tick();
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

	// Internet -> gateway -> BMC -> PCIe switch -> 4 blades, left to right.
	// Columns leave gaps for the traffic labels between the boxes.
	topologySvg(t, r, compact) {
		const nodes = t.cluster?.nodes || [];
		const list = nodes.length ? nodes : [1, 2, 3, 4].map(id => ({ id, name: `blade${id}`, power: null }));
		const C = { inet: [10, 150], gw: [200, 160], bmc: [440, 200], sw: [720, 170], node: [950, 210] };
		const W = 1170;
		const bh = compact ? 46 : 64;
		const rowH = compact ? 52 : 74;
		const top = 48;
		const H = Math.max(top + list.length * rowH + 8, 200);
		const mid = top + (list.length * rowH) / 2 - 4;
		const lines = compact ? 2 : 3;
		const box = (col, y, h, cls, title, sub, sub2) => {
			const [x, w] = C[col] || col;
			return `<rect class="cb-box ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>
				<text class="cb-title" x="${x + 12}" y="${y + 21}">${this.esc(title)}</text>
				${sub && lines > 1 ? `<text class="cb-sub" x="${x + 12}" y="${y + 38}">${this.esc(sub)}</text>` : ''}
				${sub2 && lines > 2 ? `<text class="cb-sub" x="${x + 12}" y="${y + 54}">${this.esc(sub2)}</text>` : ''}`;
		};
		const link = (x1, y1, x2, y2, cls, l1, l2) => {
			const mx = (x1 + x2) / 2;
			return `<path class="cb-link ${cls}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>
				${l1 ? `<text class="cb-rate" x="${mx}" y="${y1 - 10}" text-anchor="middle">${this.esc(l1)}</text>` : ''}
				${l2 ? `<text class="cb-rate" x="${mx}" y="${y1 + 18}" text-anchor="middle">${this.esc(l2)}</text>` : ''}`;
		};
		const right = c => C[c][0] + C[c][1];
		const inet = t.internet || {};
		const wan = t.wan || {};
		const pcie = t.pcie || {};
		const ts = t.tailscale || {};
		const wanUp = !!wan.up || !!wan.fallback;
		const flow = k => (k != null && k > 50 ? ' flow' : '');
		const down = k => (r && k != null ? `↓ ${this.fmtRate(k)}` : '');
		const upr = k => (r && k != null ? `↑ ${this.fmtRate(k)}` : '');
		const y0 = mid - bh / 2;
		let svg = '';

		svg += box('inet', y0, bh, inet.up ? 'up' : 'down', 'INTERNET', inet.up ? `ping ${inet.rtt_ms} ms` : 'unreachable');
		svg += box('gw', y0, bh, wanUp ? 'up' : 'down', 'GATEWAY', wan.gateway || '—', wan.proto ? `WAN ${wan.proto}` : '');
		svg += link(right('inet'), mid, C.gw[0], mid, inet.up ? 'up' : 'down');

		const addr = wan.fallback ? `${wan.fallback} (fallback)` : wan.ipaddr || 'no address';
		svg += box('bmc', y0, bh, wanUp ? 'up' : 'down', 'BMC · MT7620A', addr,
			`load ${(t.bmc?.load || '').split(' ')[0] || '?'} · ${t.bmc?.firmware || ''}`);
		svg += link(right('gw'), mid, C.bmc[0], mid, (wanUp ? 'up' : 'down') + flow(r?.wanRx), down(r?.wanRx), upr(r?.wanTx));

		if (ts.installed) {
			const ok = ts.state === 'Running';
			svg += box('bmc', 4, 30, ok ? 'up' : 'off', `TAILSCALE ${ok ? ts.ipaddr || '' : (ts.state || 'off').toUpperCase()}`);
			svg += `<path class="cb-link ${ok ? 'up' : 'off'}" d="M${C.bmc[0] + C.bmc[1] / 2},34 L${C.bmc[0] + C.bmc[1] / 2},${y0}"/>`;
		}

		const swOk = !!pcie.switch;
		const up = (pcie.uplink || '').split('|');
		svg += box('sw', y0, bh, swOk ? 'up' : 'down', 'PCIe SWITCH', swOk ? 'ASM2824' : 'not found',
			up[0] ? `to BMC ${up[0].replace(' PCIe', '')} x${up[1]}` : '');
		const omiOk = swOk && pcie.omi0;
		svg += link(right('bmc'), mid, C.sw[0], mid, (omiOk ? 'up' : 'down') + flow(r?.omiRx),
			compact ? '' : down(r?.omiRx) || (pcie.omi_driver ? `omi0 · ${pcie.omi_driver}` : ''), compact ? '' : upr(r?.omiTx));

		list.forEach((n, i) => {
			const y = top + i * rowH;
			const h = rowH - 10;
			const cls = n.power === false ? 'off' : n.pcie_link ? 'up' : n.power ? 'down' : 'off';
			const sub = n.power === false ? 'powered off'
				: [this.linkText(n.link_gen, n.link_width) || (n.power ? 'no PCIe link' : 'unknown'), `slot ${n.id}`].join(' · ');
			const sub2 = [n.ipaddr, n.reachable === true ? 'online' : n.reachable === false ? 'no answer' : ''].filter(Boolean).join(' · ');
			svg += box('node', y, h, cls, (n.name || `blade${n.id}`).toUpperCase(), sub, sub2);
			svg += link(right('sw'), mid, C.node[0], y + h / 2, cls === 'up' ? 'up' : cls === 'off' ? 'off' : 'down');
		});
		return `<svg class="cb-topo" viewBox="0 0 ${W} ${H}" role="img" aria-label="ClusterBox topology">${svg}</svg>`;
	}

	renderNodes(t) {
		const el = document.getElementById('cb-nodes');
		if (!el) return;
		const nodes = t.cluster?.nodes || [];
		if (!nodes.length) {
			el.innerHTML = `<div class="stat-card cb-muted">No node data: nodectl cannot reach the backplane (power and reset lines).</div>`;
			return;
		}
		const b = (ok, yes, no) => this.core.renderBadge(ok ? 'success' : 'error', ok ? yes : no);
		el.innerHTML = nodes
			.map(n => {
				const id = Number(n.id);
				const state = n.busy ? this.core.renderBadge('warning', String(n.busy).toUpperCase())
					: n.power ? (n.reachable ? this.core.renderBadge('success', 'ONLINE') : this.core.renderBadge('warning', 'BOOTING'))
					: this.core.renderBadge('error', 'OFF');
				return `<div class="stat-card cb-node">
					<div class="cb-node-head"><span class="cb-node-name">${this.esc((n.name || `blade${id}`).toUpperCase())}</span>${state}</div>
					<div class="cb-node-row"><span>Slot</span><span>${id}</span></div>
					<div class="cb-node-row"><span>Power</span><span>${b(n.power, 'ON', 'OFF')}</span></div>
					<div class="cb-node-row"><span>PCIe</span><span>${n.pcie_link ? this.esc(this.linkText(n.link_gen, n.link_width) || 'link') : this.core.renderBadge('error', 'DOWN')}</span></div>
					<div class="cb-node-row"><span>Address</span><span class="cb-mono">${this.esc(n.ipaddr || '—')}</span></div>
					<div class="cb-node-row"><span>Console</span><span>${n.tty_present ? 'serial' : '—'}</span></div>
					<div class="cb-node-actions">
						${n.power ? `<button class="action-btn-sm" data-node="${id}" data-act="shutdown">SHUTDOWN</button>
							<button class="action-btn-sm" data-node="${id}" data-act="reboot">REBOOT</button>
							<button class="action-btn-sm danger" data-node="${id}" data-act="poweroff">POWER OFF</button>`
						: `<button class="action-btn-sm" data-node="${id}" data-act="poweron">POWER ON</button>`}
						${n.tty_present ? `<button class="action-btn-sm" data-node="${id}" data-act="console">CONSOLE</button>` : ''}
					</div></div>`;
			})
			.join('');
		el.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => this.nodeAction(Number(btn.dataset.node), btn.dataset.act)));
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

	// ---- dashboard widget ----------------------------------------------

	renderWidget(el) {
		el.innerHTML = `<div class="stat-card"><div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
			CLUSTERBOX <button class="action-btn-sm" id="cb-widget-open">OPEN</button></div><div id="cb-widget">Loading…</div></div>`;
		el.querySelector('#cb-widget-open').addEventListener('click', () => this.core.navigate('/cluster'));
		const tick = async () => {
			const box = document.getElementById('cb-widget');
			if (!box) return clearInterval(this.widgetTimer);
			try {
				const t = await this.call('topology');
				box.innerHTML = this.topologySvg(t, null, true);
			} catch (e) {
				box.innerHTML = `<div class="cb-muted">${this.esc(e.message)}</div>`;
			}
		};
		clearInterval(this.widgetTimer);
		tick();
		this.widgetTimer = setInterval(tick, POLL_MS * 2);
	}

	// ---- access ------------------------------------------------------------

	async loadAccess() {
		const body = document.getElementById('cb-body');
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
				<label class="cb-check"><input type="checkbox" id="cb-ssh_password" ${a.ssh_password !== '0' ? 'checked' : ''}> Password login (off = keys only)</label>
				<div class="section-title" style="margin-top:16px">REACHABLE FROM ZONES</div>
				${zones}
				<div class="cb-muted">The ports above are rejected on the zones not ticked.</div>
			</div></div>
			<div class="stat-card" style="margin-top:16px">
				<div class="cb-muted">Saving takes a configuration snapshot and applies the settings. Unless the new address is opened and confirms
				within 120 s, the snapshot is restored automatically.</div>
				<div class="quick-actions"><button class="action-btn" id="cb-access-save">SAVE AND APPLY</button></div>
			</div>`;
		document.getElementById('cb-access-save').addEventListener('click', () => this.saveAccess());
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
		const url = `${https ? 'https' : 'http'}://${window.location.hostname}:${port}/moci/?cbconfirm=${encodeURIComponent(res.token)}#/cluster/access`;
		this.core.showToast('Applying; opening the new address to confirm…', 'info');
		document.getElementById('cb-body').insertAdjacentHTML('afterbegin', `<div class="stat-card cb-banner">
			Applying. If this page does not move on by itself, open <a href="${this.esc(url)}">${this.esc(url)}</a>
			within ${res.timeout} s, otherwise the previous settings come back.</div>`);
		setTimeout(() => (window.location.href = url), 5000);
	}

	// ---- services ----------------------------------------------------------

	async loadServices() {
		const body = document.getElementById('cb-body');
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
		body.innerHTML = `<div class="cb-grid2">
			<div class="stat-card"><div class="section-title">DNS FOR THE BLADES</div>
				${chk('dns', 'enabled', 'Answer DNS on omi0 (10.20.0.1)')}
				${txt('dns', 'domain', 'LOCAL DOMAIN', 'cluster')}
				${txt('dns', 'server', 'UPSTREAM SERVERS', 'from WAN DHCP', 'Space separated, e.g. 1.1.1.1 9.9.9.9; empty = the DNS servers WAN DHCP gives')}
				${chk('dns', 'node_records', 'Names for the BMC (bmc) and the nodes (blade1…4 and their names)')}
			</div>
			<div class="stat-card"><div class="section-title">TIME</div>
				${chk('ntp', 'serve_blades', 'NTP server for the blades')}
				<div class="section-title" style="margin-top:16px">LOG</div>
				${chk('log', 'persistent', 'Keep the system log on the eMMC (/overlay/log)')}
				${txt('log', 'size', 'LOG SIZE, KiB', '1024')}
				${txt('log', 'remote_ip', 'REMOTE SYSLOG SERVER', 'none')}
				${txt('log', 'remote_port', 'REMOTE SYSLOG PORT', '514')}
			</div>
			<div class="stat-card"><div class="section-title">WAN FALLBACK ADDRESS</div>
				${chk('wan', 'fallback', 'Add a fallback address when DHCP does not answer')}
				${txt('wan', 'fallback_ipaddr', 'ADDRESS/PREFIX', 'last DHCP address', 'Empty = the last address DHCP gave')}
				${txt('wan', 'fallback_gateway', 'GATEWAY', 'last DHCP gateway')}
				${txt('wan', 'fallback_delay', 'WAIT FOR DHCP, s', '60')}
			</div>
			<div class="stat-card"><div class="section-title">CONFIGURATION HISTORY</div>
				${txt('history', 'keep', 'SNAPSHOTS TO KEEP', '50')}
				${chk('history', 'daily', 'Daily snapshot')}
			</div></div>
			<div class="quick-actions" style="margin-top:16px"><button class="action-btn" id="cb-services-save">SAVE AND APPLY</button></div>`;
		document.getElementById('cb-services-save').addEventListener('click', () => this.saveServices());
	}

	async saveServices() {
		const sections = {};
		document.querySelectorAll('#cb-body [data-s]').forEach(el => {
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

	async loadHistory() {
		const body = document.getElementById('cb-body');
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

	async loadTailscale() {
		const body = document.getElementById('cb-body');
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
