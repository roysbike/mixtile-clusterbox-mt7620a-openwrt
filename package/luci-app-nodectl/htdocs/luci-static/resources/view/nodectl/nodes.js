'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require dom';

var callStatus = rpc.declare({
	object: 'nodectl',
	method: 'status'
});

var callAction = rpc.declare({
	object: 'nodectl',
	method: 'action',
	params: [ 'node', 'action', 'force', 'hard' ]
});

var callRescan = rpc.declare({
	object: 'nodectl',
	method: 'rescan'
});

var callConsole = rpc.declare({
	object: 'nodectl',
	method: 'console',
	params: [ 'node', 'mode' ]
});

var callLog = rpc.declare({
	object: 'nodectl',
	method: 'log',
	params: [ 'node' ],
	expect: { log: '' }
});

var callConsoleLog = rpc.declare({
	object: 'nodectl',
	method: 'console_log',
	params: [ 'node', 'bytes' ],
	expect: { log: '' }
});

var callSend = rpc.declare({
	object: 'nodectl',
	method: 'send',
	params: [ 'node', 'text' ]
});

var callFan = rpc.declare({
	object: 'nodectl',
	method: 'fan',
	params: [ 'duty' ]
});

function nodeState(n) {
	if (n.busy)
		return [ _('Busy: %s').format(n.busy), '#e0a000' ];
	if (!n.power)
		return [ _('Off'), '#888' ];
	if (n.reachable)
		return [ _('Online'), '#2a2' ];
	if (n.reachable === false)
		return [ _('Powered, not answering'), '#e0a000' ];
	return [ _('Powered'), '#e0a000' ];
}

function badge(text, color) {
	return E('span', {
		'style': 'display:inline-block;padding:2px 8px;border-radius:10px;color:#fff;background:' + color
	}, text);
}

function pcieText(n) {
	if (n.pcie_link == null)
		return '-';
	if (!n.pcie_link)
		return _('down');
	return n.pcie ? _('up') : _('link, no device');
}

function cleanTerm(s) {
	return s
		.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
		.replace(/\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
		.replace(/\x1b./g, '')
		.replace(/\r+\n/g, '\n')
		.replace(/[^\n]*\r/g, '');
}

function fmtUptime(sec) {
	sec = parseInt(sec, 10) || 0;
	var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600),
	    m = Math.floor(sec % 3600 / 60);
	if (d)
		return _('%dd %dh').format(d, h);
	if (h)
		return _('%dh %dm').format(h, m);
	return _('%dm').format(m);
}

function fmtMem(kb) {
	return (kb / 1024).toFixed(0) + ' MiB';
}

function normalize(st) {
	st = st || {};
	return { nodes: st.nodes || [], chassis: st.chassis || {}, host: st.host || {} };
}

function findNode(nodes, id) {
	for (var i = 0; i < nodes.length; i++)
		if (nodes[i].id == id)
			return nodes[i];
	return { id: id, name: 'blade' + id, power: true };
}

return view.extend({
	load: function() {
		return callStatus().then(normalize);
	},

	/* window.confirm keeps an open console iframe; ui.showModal would replace it. */
	ask: function(question, inConsole) {
		if (!question)
			return Promise.resolve(true);
		if (inConsole)
			return Promise.resolve(window.confirm(question));
		return new Promise(function(resolve) {
			ui.showModal(_('Confirm'), [
				E('p', {}, question),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': function() { ui.hideModal(); resolve(false); } }, _('Cancel')),
					' ',
					E('button', { 'class': 'btn cbi-button-negative', 'click': function() { ui.hideModal(); resolve(true); } }, _('Continue'))
				])
			]);
		});
	},

	doAction: function(node, action, opts, question, inConsole) {
		var self = this;
		var who = node ? _('node %d').format(node) : _('all nodes');

		return this.ask(question ? question.format(who) : null, inConsole).then(function(ok) {
			if (!ok)
				return;
			return callAction(node, action, !!(opts && opts.force), !!(opts && opts.hard)).then(function(res) {
				if (res.code != 0)
					ui.addNotification(null, E('pre', {}, res.output || _('Command failed')), 'danger');
				else
					ui.addTimeLimitedNotification(null, E('p', {}, _('%s: %s requested').format(who, action)), 3000, 'info');
				return self.refresh();
			});
		});
	},

	powerButtons: function(n, inConsole) {
		var self = this;
		var busy = !!n.busy;

		return [
			n.power
				? this.btn(_('Shutdown'), 'cbi-button-action', function() {
					return self.doAction(n.id, 'shutdown', null,
						_('Press the power button of %s and cut power once it is down?'), inConsole);
				}, busy)
				: this.btn(_('Power on'), 'cbi-button-positive', function() {
					return self.doAction(n.id, 'poweron', null, null, inConsole);
				}, busy),
			this.btn(_('Reboot'), 'cbi-button-action', function() {
				return self.doAction(n.id, 'reboot', null, _('Gracefully reboot %s?'), inConsole);
			}, busy || !n.power),
			this.btn(_('Reset'), 'cbi-button-negative', function() {
				return self.doAction(n.id, 'reset', null,
					_('Hardware reset %s? Unsaved data will be lost.'), inConsole);
			}, busy || !n.power),
			this.btn(_('Power off'), 'cbi-button-negative', function() {
				return self.doAction(n.id, 'poweroff', null,
					_('Cut power of %s immediately? Unsaved data will be lost.'), inConsole);
			}, !n.power)
		];
	},

	openConsole: function(node, mode) {
		var self = this;
		var proto = window.location.protocol;
		var n = typeof node === 'object' ? node : findNode(this._nodes || [], node);
		var id = n.id;

		return callConsole(id, mode).then(function(res) {
			if (!res || !res.token) {
				ui.addNotification(null, E('p', {}, (res && res.output) || _('Unable to open console')), 'danger');
				return;
			}
			var url = 'http://' + window.location.hostname + ':' + res.port + '/?arg=' + res.token;

			if (proto === 'https:') {
				window.open(url, '_blank');
				return;
			}

			var actions = E('div', { 'id': 'nodectl-console-actions',
				'style': 'display:flex;flex-wrap:wrap;gap:4px;align-items:center' },
				self.powerButtons(n, true).concat([
					self.btn(_('Close'), '', function() { ui.hideModal(); })
				]));

			ui.showModal(E('div', {
				'style': 'display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap'
			}, [
				E('span', {}, _('Node %d (%s) — console').format(id, n.name)),
				actions
			]), [
				E('iframe', {
					'src': url,
					'style': 'width:100%;height:72vh;border:none;background:#000;display:block'
				}),
				E('p', { 'class': 'cbi-value-description', 'style': 'margin:8px 0 0' },
					_('Detach: Ctrl-] then q. Power actions stay in this window.'))
			], 'cbi-modal');

			var modal = document.querySelector('#modal_overlay .modal');
			if (modal) {
				modal.style.maxWidth = '96vw';
				var h4 = modal.querySelector('h4');
				if (h4)
					h4.style.marginBottom = '8px';
			}

			self._consoleNode = id;
		});
	},

	showLog: function(node) {
		return callLog(node).then(function(log) {
			ui.showModal(_('Node %d — job log').format(node), [
				E('pre', { 'style': 'max-height:60vh;overflow:auto;white-space:pre-wrap' },
					(log || _('No log yet.')).replace(/\r/g, '\n')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))
				])
			], 'cbi-modal');
		});
	},

	showConsoleLog: function(n) {
		var self = this;
		var out = E('pre', {
			'style': 'height:60vh;overflow:auto;white-space:pre-wrap;background:#111;color:#ddd;padding:6px;font-size:12px'
		}, _('Loading…'));
		var input = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'style': 'width:70%',
			'placeholder': _('Command to send')
		});
		var follow = E('input', { 'type': 'checkbox', 'checked': '' });
		var timer = null, open = true;

		var update = function() {
			if (!open)
				return Promise.resolve();
			return callConsoleLog(n.id, 32768).then(function(log) {
				var atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 20;

				out.textContent = log ? cleanTerm(log) : _('Console log is empty.');
				if (follow.checked && atEnd)
					out.scrollTop = out.scrollHeight;
			});
		};

		var send = function(text) {
			return callSend(n.id, text).then(function(res) {
				if (res.code != 0)
					ui.addNotification(null, E('pre', {}, res.output || _('Send failed')), 'danger');
				input.value = '';
				window.setTimeout(update, 700);
			});
		};

		var close = function() {
			open = false;
			window.clearInterval(timer);
			ui.hideModal();
		};

		input.addEventListener('keydown', function(ev) {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				send(input.value);
			}
		});

		ui.showModal(_('Node %d (%s) — console log').format(n.id, n.name), [
			n.console_server ? '' : E('p', { 'class': 'alert-message warning' },
				_('The console server is not running; the log is not updated.')),
			out,
			E('div', { 'style': 'margin-top:6px' }, [
				input, ' ',
				E('button', { 'class': 'btn cbi-button-action', 'disabled': n.console_server ? null : '',
					'click': function() { send(input.value); } }, _('Send'))
			]),
			E('div', { 'class': 'right', 'style': 'margin-top:6px' }, [
				E('label', { 'style': 'margin-right:1em' }, [ follow, ' ', _('Follow') ]),
				E('button', { 'class': 'btn', 'click': function() { close(); self.openConsole(n, 'serial'); } }, _('Console')), ' ',
				E('button', { 'class': 'btn', 'click': close }, _('Close'))
			])
		], 'cbi-modal');

		var modal = document.querySelector('#modal_overlay .modal');
		if (modal)
			modal.style.maxWidth = '95vw';

		timer = window.setInterval(update, 2000);
		return update().then(function() { out.scrollTop = out.scrollHeight; });
	},

	btn: function(label, style, fn, disabled, title) {
		return E('button', {
			'class': 'btn cbi-button ' + (style || ''),
			'style': 'margin:2px',
			'title': title || '',
			'disabled': disabled ? '' : null,
			'click': ui.createHandlerFn(this, fn)
		}, label);
	},

	renderRows: function(nodes) {
		var self = this;

		return nodes.map(function(n) {
			var st = nodeState(n);

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, [ E('strong', {}, '#' + n.id), ' ', n.name ]),
				E('td', { 'class': 'td' }, badge(st[0], st[1])),
				E('td', { 'class': 'td' }, pcieText(n)),
				E('td', { 'class': 'td' }, n.ipaddr
					? [ n.ipaddr, n.check ? E('small', {}, ' · ' + n.check) : '' ]
					: E('em', {}, _('not set'))),
				E('td', { 'class': 'td' }, [
					E('div', { 'style': 'display:flex;flex-wrap:wrap;align-items:center' },
						self.powerButtons(n, false)),
					E('div', { 'style': 'display:flex;flex-wrap:wrap;align-items:center;margin-top:2px' }, [
						self.btn(_('Console'), 'cbi-button-apply', function() {
							return self.openConsole(n, 'serial');
						}, !n.tty_present, _('Serial console of this slot')),
						self.btn(_('Log'), '', function() {
							return self.showConsoleLog(n);
						}, false, _('Recorded console output')),
						self.btn(_('SSH'), '', function() {
							return self.openConsole(n, 'ssh');
						}, !n.ipaddr || !n.reachable, _('SSH to the node (needs an IP and a running sshd)')),
						self.btn(_('Jobs'), '', function() {
							return self.showLog(n.id);
						}, false, _('Last power / flash job log'))
					])
				])
			]);
		});
	},

	stat: function(label, value) {
		return E('span', { 'style': 'margin-right:1.6em;white-space:nowrap' }, [
			E('strong', {}, label + ': '), value
		]);
	},

	tempText: function(c, host) {
		var mc = (host && host.temp_mc != null) ? host.temp_mc : (c && c.temp_mc);
		if (mc == null)
			return E('em', {}, _('no sensor'));
		return (mc / 1000).toFixed(1) + ' °C';
	},

	renderChassis: function(c, host) {
		var self = this;
		var duty = E('input', {
			'type': 'number', 'min': 0, 'max': 100, 'style': 'width:4.5em',
			'class': 'cbi-input-text', 'value': c.fan_duty != null && c.fan_duty >= 0 ? c.fan_duty : ''
		});
		var mem = '';
		if (host.mem_total_kb)
			mem = '%s / %s'.format(
				fmtMem(host.mem_total_kb - host.mem_avail_kb),
				fmtMem(host.mem_total_kb));

		return [
			this.stat(_('Rail'), c.ext_power == null ? '-' :
				badge(c.ext_power ? _('on') : _('off'), c.ext_power ? '#2a2' : '#888')),
			this.stat(_('Temp'), this.tempText(c, host)),
			this.stat(_('Load'), host.loadavg || '-'),
			this.stat(_('Memory'), mem || '-'),
			this.stat(_('Up'), host.uptime != null ? fmtUptime(host.uptime) : '-'),
			this.stat(_('Exporter'), host.exporter ? _('node_exporter :9100') : _('local')),
			E('span', { 'style': 'white-space:nowrap' }, [
				E('strong', {}, _('Fans: ')), duty, ' % ',
				this.btn(_('Set'), 'cbi-button-apply', function() {
					return callFan(parseInt(duty.value, 10)).then(function(res) {
						if (res.code != 0)
							ui.addNotification(null, E('pre', {}, res.output || _('Command failed')), 'danger');
						return self.refresh();
					});
				})
			])
		];
	},

	refreshConsoleBar: function(nodes) {
		var bar = document.getElementById('nodectl-console-actions');
		if (!bar || this._consoleNode == null)
			return;
		var n = findNode(nodes, this._consoleNode);
		var self = this;
		dom.content(bar, this.powerButtons(n, true).concat([
			this.btn(_('Close'), '', function() { ui.hideModal(); })
		]));
	},

	refresh: function() {
		var self = this;

		return callStatus().then(normalize).then(function(st) {
			self._nodes = st.nodes;
			var tbody = document.getElementById('nodectl-rows');
			var chassis = document.getElementById('nodectl-chassis');

			if (tbody)
				dom.content(tbody, self.renderRows(st.nodes));
			if (chassis && !chassis.contains(document.activeElement))
				dom.content(chassis, self.renderChassis(st.chassis, st.host));
			self.refreshConsoleBar(st.nodes);
		});
	},

	render: function(st) {
		var self = this;

		this._nodes = st.nodes;
		poll.add(function() { return self.refresh(); }, 5);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Blade3 nodes')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Out-of-band power and console for this ClusterBox. IPs and timings: Cluster → Settings.')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'id': 'nodectl-chassis', 'style': 'margin-bottom:1em;line-height:2' },
					this.renderChassis(st.chassis, st.host)),
				E('div', { 'style': 'margin-bottom:1em' }, [
					this.btn(_('Power on all'), 'cbi-button-positive', function() {
						return self.doAction(0, 'poweron');
					}),
					this.btn(_('Shutdown all'), 'cbi-button-action', function() {
						return self.doAction(0, 'shutdown', null, _('Gracefully shut down %s?'));
					}),
					this.btn(_('Rescan PCIe'), '', function() {
						return callRescan().then(function() { return self.refresh(); });
					})
				]),
				E('table', { 'class': 'table' }, [
					E('thead', {}, E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, _('Node')),
						E('th', { 'class': 'th' }, _('State')),
						E('th', { 'class': 'th' }, _('PCIe')),
						E('th', { 'class': 'th' }, _('IP')),
						E('th', { 'class': 'th' }, _('Actions'))
					])),
					E('tbody', { 'id': 'nodectl-rows' }, this.renderRows(st.nodes))
				]),
				E('div', { 'class': 'cbi-section-descr', 'style': 'margin-top:1.2em' }, [
					E('strong', {}, _('Actions')),
					E('ul', { 'style': 'margin:.4em 0 0 1.2em' }, [
						E('li', {}, [ E('strong', {}, _('Shutdown')), ' — ',
							_('ACPI power-button pulse; power is cut after the node stops answering.') ]),
						E('li', {}, [ E('strong', {}, _('Power on')), ' — ',
							_('Energize the slot if it is off.') ]),
						E('li', {}, [ E('strong', {}, _('Reboot')), ' — ',
							_('Graceful shutdown, then power on.') ]),
						E('li', {}, [ E('strong', {}, _('Reset')), ' — ',
							_('Hardware reset pin. The node does not shut down cleanly.') ]),
						E('li', {}, [ E('strong', {}, _('Power off')), ' — ',
							_('Immediate power cut. Unsaved data is lost.') ]),
						E('li', {}, [ E('strong', {}, _('Console')), ' — ',
							_('Live serial console of this slot. Power controls stay in the header.') ]),
						E('li', {}, [ E('strong', {}, _('Log')), ' — ',
							_('Scrollback captured from the console server.') ]),
						E('li', {}, [ E('strong', {}, _('SSH')), ' — ',
							_('Shell on the node when an IP and sshd are available (not used on Talos).') ]),
						E('li', {}, [ E('strong', {}, _('Jobs')), ' — ',
							_('Last shutdown, reboot or flash job on the ClusterBox.') ])
					])
				])
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
