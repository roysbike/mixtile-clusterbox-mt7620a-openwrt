// ClusterBox add-on for MoCI: cluster topology and nodes, management
// access, services for the blades, configuration history, Tailscale.
// Backend: ubus objects "clusterbox" (package clusterbox) and "nodectl".

const TABS = [
	['overview', 'OVERVIEW'],
	['access', 'ACCESS'],
	['services', 'SERVICES'],
	['history', 'CONFIG HISTORY'],
	['tailscale', 'TAILSCALE'],
	['firmware', 'FIRMWARE']
];
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
		this.widgetTimer = null;
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

	getExtensions() {
		return {
			'dashboard:widget': { id: 'cb-dashboard-topology', render: el => this.renderWidget(el) }
		};
	}

	cleanup() {
		this.stopPolling();
		clearInterval(this.widgetTimer);
		this.closeLogs();
		clearInterval(this.fwTimer);
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
			tailscale: () => this.loadTailscale(),
			firmware: () => this.loadFirmware()
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
				// The log is up to a minute behind: look again sooner when
				// it disagrees with what the nodes show now.
				if ((t.cluster?.nodes || []).some(n => this.availInfo?.[n.id] && this.availInfo[n.id].state !== this.nodeState(n)))
					this.availAt = Math.min(this.availAt || 0, Date.now() - AVAIL_MS + 10000);
				await this.loadAvailability();
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
			const av = this.availInfo?.[n.id];
			const sub2 = [n.ipaddr, n.reachable === true ? 'online' : n.reachable === false ? 'no answer' : '',
				av?.since && av.state === this.nodeState(n) ? this.fmtDur(av.now - av.since) : ''].filter(Boolean).join(' · ');
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
					${this.availCard(n)}
					<div class="cb-node-actions">
						${n.power ? `<button class="action-btn-sm" data-node="${id}" data-act="shutdown">SHUTDOWN</button>
							<button class="action-btn-sm" data-node="${id}" data-act="reboot">REBOOT</button>
							<button class="action-btn-sm danger" data-node="${id}" data-act="poweroff">POWER OFF</button>`
						: `<button class="action-btn-sm" data-node="${id}" data-act="poweron">POWER ON</button>`}
						${n.tty_present ? `<button class="action-btn-sm" data-node="${id}" data-act="console">CONSOLE</button>` : ''}
						<button class="action-btn-sm" data-node="${id}" data-name="${this.esc(n.name || `blade${id}`)}" data-act="logs">LOGS</button>
					</div></div>`;
			})
			.join('');
		el.querySelectorAll('[data-act]').forEach(btn =>
			btn.addEventListener('click', () =>
				btn.dataset.act === 'logs'
					? this.openLogs(Number(btn.dataset.node), btn.dataset.name)
					: this.nodeAction(Number(btn.dataset.node), btn.dataset.act)
			)
		);
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

	availCard(n) {
		const av = this.availInfo?.[Number(n.id)];
		if (!av) return '';
		const st = this.nodeState(n);
		const pct = av.pct == null ? '—' : `${av.pct >= 99.95 ? '100' : av.pct.toFixed(1)}%`;
		const since = av.since && av.state === st ? `${AV_TEXT[st]} for ${this.fmtDur(av.now - av.since)}` : AV_TEXT[st] || st;
		return `<div class="cb-node-row"><span>Online, 24 h</span><span>${pct}</span></div>
			<div class="cb-node-row"><span>State</span><span>${this.esc(since)}</span></div>
			${this.availStrip(av)}
			<div class="cb-av-axis"><span>24 h ago</span><span>now</span></div>`;
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

	renderWidget(el) {
		el.innerHTML = `<div class="stat-card"><div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
			CLUSTERBOX <button class="action-btn-sm" id="cb-widget-open">OPEN</button></div><div id="cb-widget">Loading…</div></div>`;
		el.querySelector('#cb-widget-open').addEventListener('click', () => this.core.navigate('/cluster'));
		const tick = async () => {
			const box = document.getElementById('cb-widget');
			if (!box) return clearInterval(this.widgetTimer);
			try {
				const t = await this.call('topology');
				await this.loadAvailability();
				box.innerHTML = this.topologySvg(t, null, true);
				this.renderSummary(t);
			} catch (e) {
				box.innerHTML = `<div class="cb-muted">${this.esc(e.message)}</div>`;
				this.renderSummary(null, e.message);
			}
		};
		clearInterval(this.widgetTimer);
		tick();
		this.widgetTimer = setInterval(tick, POLL_MS * 2);
	}

	// Health of the whole box at the top of the dashboard: one tile per
	// component, coloured by its state; a click opens the cluster page.
	renderSummary(t, err) {
		const page = document.getElementById('dashboard-page');
		if (!page) return;
		let el = document.getElementById('cb-dash-summary');
		if (!el) {
			el = document.createElement('div');
			el.id = 'cb-dash-summary';
			el.className = 'cb-sum';
			el.addEventListener('click', e => e.target.closest('.cb-tile') && this.core.navigate('/cluster'));
			page.prepend(el);
		}
		if (!t) {
			el.innerHTML = this.tile('bad', 'CLUSTERBOX', 'no data', err || '');
			return;
		}
		const nodes = t.cluster?.nodes || [];
		const states = nodes.map(n => this.nodeState(n));
		const online = states.filter(s => s === 'online').length;
		const level = { online: 'ok', booting: 'warn', busy: 'warn', nolink: 'bad', off: 'off', unknown: 'off' };
		const worst = states.includes('nolink') ? 'bad' : states.some(s => s !== 'online') ? 'warn' : 'ok';
		const linked = nodes.filter(n => n.pcie_link).length;
		const pcie = t.pcie || {};
		const up = (pcie.uplink || '').split('|');
		const svc = t.services || [];
		const svcUp = svc.filter(x => x.up === '1').length;
		const bmc = t.bmc || {};
		const mem = bmc.mem_total_kb ? Math.round((1 - bmc.mem_avail_kb / bmc.mem_total_kb) * 100) : null;
		const load = parseFloat((bmc.load || '').split(' ')[0]);
		const tiles = [
			this.tile(nodes.length ? worst : 'off', 'CLUSTER', `${online}/${nodes.length || 4} online`,
				nodes.length ? `PCIe links ${linked}/${nodes.length}` : 'no node data')
		];
		nodes.forEach((n, i) => {
			const st = states[i];
			const av = this.availInfo?.[n.id];
			const dur = av?.since && av.state === st ? ` · ${this.fmtDur(av.now - av.since)}` : '';
			const pct = av?.pct != null ? ` · ${av.pct >= 99.95 ? '100' : av.pct.toFixed(1)}% 24h` : '';
			tiles.push(this.tile(level[st] || 'off', (n.name || `blade${n.id}`).toUpperCase(), `${AV_TEXT[st] || st}${dur}`,
				`${n.ipaddr || `slot ${n.id}`}${pct}`));
		});
		tiles.push(
			this.tile(!pcie.switch ? 'bad' : pcie.omi0 ? 'ok' : 'warn', 'PCIe FABRIC', pcie.switch ? 'ASM2824' : 'no switch',
				[up[0] ? `uplink ${up[0].replace(' PCIe', '')} x${up[1]}` : '', pcie.omi_driver || 'no omi driver'].filter(Boolean).join(' · ')),
			this.tile(mem > 90 || load > 4 ? 'warn' : 'ok', 'BMC', `load ${isNaN(load) ? '?' : load.toFixed(2)}`,
				[mem != null ? `mem ${mem}%` : '', `up ${this.fmtDur(bmc.uptime || 0)}`, bmc.firmware || ''].filter(Boolean).join(' · ')),
			this.tile(t.internet?.up ? 'ok' : t.wan?.up ? 'warn' : 'bad', 'INTERNET', t.internet?.up ? `${Math.round(t.internet.rtt_ms)} ms` : 'unreachable',
				`WAN ${t.wan?.ipaddr || t.wan?.fallback || 'no address'}`)
		);
		if (svc.length)
			tiles.push(this.tile(svcUp === svc.length ? 'ok' : svcUp ? 'warn' : 'bad', 'SERVICES', `${svcUp}/${svc.length} up`,
				svc.some(x => x.up === '0')
					? `down: ${svc.filter(x => x.up === '0').map(x => x.name).join(', ')}`
					: svc.map(x => x.name).join(' · ')));
		if (t.tailscale?.installed)
			tiles.push(this.tile(t.tailscale.state === 'Running' ? 'ok' : 'off', 'TAILSCALE', t.tailscale.state || 'off', t.tailscale.ipaddr || ''));
		const fw = this.fw;
		if (fw) {
			const u = fw.updater || {};
			const avail = u.update_available && u.latest_version;
			tiles.push(this.tile(avail ? 'warn' : 'ok', 'FIRMWARE', this.shortVersion(u.current_version).replace(/ \(.*\)$/, ''),
				avail ? `${u.latest_version} available` : RELEASE_RE.test(u.current_version || '') ? 'up to date' : `development build · OpenWrt ${fw.openwrt}`));
		}
		el.innerHTML = tiles.join('');
	}

	tile(level, title, value, sub) {
		return `<div class="stat-card cb-tile ${level}" title="Open the cluster page">
			<div class="cb-tile-title">${this.esc(title)}</div>
			<div class="cb-tile-value">${this.esc(value)}</div>
			${sub ? `<div class="cb-tile-sub">${this.esc(sub)}</div>` : ''}</div>`;
	}

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

	async loadFirmware() {
		const body = document.getElementById('cb-body');
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
			if (document.getElementById('cb-body') === body) this.loadFirmware();
		});
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
