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

/* Drop ANSI escape sequences and fold carriage returns for the log viewer. */
function cleanTerm(s) {
	return s
		.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
		.replace(/\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
		.replace(/\x1b./g, '')
		.replace(/\r+\n/g, '\n')
		.replace(/[^\n]*\r/g, '');
}

function normalize(st) {
	st = st || {};
	return { nodes: st.nodes || [], chassis: st.chassis || {} };
}

return view.extend({
	load: function() {
		return callStatus().then(normalize);
	},

	confirm: function(title, text, label) {
		return new Promise(function(resolve) {
			ui.showModal(title, [
				E('p', {}, text),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': function() { ui.hideModal(); resolve(false); } }, _('Cancel')),
					' ',
					E('button', { 'class': 'btn cbi-button-negative', 'click': function() { ui.hideModal(); resolve(true); } }, label)
				])
			]);
		});
	},

	doAction: function(node, action, opts, question) {
		var self = this;
		var who = node ? _('node %d').format(node) : _('all nodes');
		var ask = question ? this.confirm(_('Confirm'), question.format(who), action) : Promise.resolve(true);

		return ask.then(function(ok) {
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

	openConsole: function(node, mode) {
		var proto = window.location.protocol;

		return callConsole(node, mode).then(function(res) {
			if (!res || !res.token) {
				ui.addNotification(null, E('p', {}, (res && res.output) || _('Unable to open console')), 'danger');
				return;
			}
			var url = 'http://' + window.location.hostname + ':' + res.port + '/?arg=' + res.token;

			/* ttyd is served over plain HTTP; an iframe would be blocked as mixed content. */
			if (proto === 'https:') {
				window.open(url, '_blank');
				return;
			}
			ui.showModal(_('Node %d - %s console').format(node, mode === 'ssh' ? 'SSH' : _('serial')), [
				E('p', { 'class': 'cbi-value-description' },
					mode === 'ssh' ? '' : _('Press Ctrl-] then q to detach.')),
				E('iframe', {
					'src': url,
					'style': 'width:100%;height:70vh;border:none;background:#000'
				}),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))
				])
			], 'cbi-modal');
			var modal = document.querySelector('#modal_overlay .modal');
			if (modal)
				modal.style.maxWidth = '95vw';
		});
	},

	showLog: function(node) {
		return callLog(node).then(function(log) {
			ui.showModal(_('Node %d - last job log').format(node), [
				E('pre', { 'style': 'max-height:60vh;overflow:auto;white-space:pre-wrap' },
					(log || _('No log yet.')).replace(/\r/g, '\n')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))
				])
			], 'cbi-modal');
		});
	},

	/* Read-only view of the console log with a one-line command input; it
	 * works without ttyd and keeps the history the console server recorded. */
	showConsoleLog: function(n) {
		var self = this;
		var out = E('pre', {
			'style': 'height:60vh;overflow:auto;white-space:pre-wrap;background:#111;color:#ddd;padding:6px;font-size:12px'
		}, _('Loading…'));
		var input = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'style': 'width:70%',
			'placeholder': _('Command to send (Enter is appended)')
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

		ui.showModal(_('Node %d (%s) - serial console log').format(n.id, n.name), [
			n.console_server ? '' : E('p', { 'class': 'alert-message warning' },
				_('The console server for this node is not running; the log is not updated and commands cannot be sent.')),
			out,
			E('div', { 'style': 'margin-top:6px' }, [
				input, ' ',
				E('button', { 'class': 'btn cbi-button-action', 'disabled': n.console_server ? null : '',
					'click': function() { send(input.value); } }, _('Send')), ' ',
				E('button', { 'class': 'btn', 'disabled': n.console_server ? null : '',
					'click': function() { send(''); } }, _('Enter'))
			]),
			E('div', { 'class': 'right', 'style': 'margin-top:6px' }, [
				E('label', { 'style': 'margin-right:1em' }, [ follow, ' ', _('Follow') ]),
				E('button', { 'class': 'btn', 'click': function() { close(); self.openConsole(n.id, 'serial'); } }, _('Interactive')), ' ',
				E('button', { 'class': 'btn', 'click': close }, _('Close'))
			])
		], 'cbi-modal');

		var modal = document.querySelector('#modal_overlay .modal');
		if (modal)
			modal.style.maxWidth = '95vw';

		timer = window.setInterval(update, 2000);
		return update().then(function() { out.scrollTop = out.scrollHeight; });
	},

	btn: function(label, style, fn, disabled) {
		return E('button', {
			'class': 'btn cbi-button ' + (style || ''),
			'style': 'margin:2px',
			'disabled': disabled ? '' : null,
			'click': ui.createHandlerFn(this, fn)
		}, label);
	},

	renderRows: function(nodes) {
		var self = this;

		return nodes.map(function(n) {
			var st = nodeState(n);
			var busy = !!n.busy;

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, [ E('strong', {}, '#' + n.id), ' ', n.name ]),
				E('td', { 'class': 'td' }, badge(st[0], st[1])),
				E('td', { 'class': 'td' }, pcieText(n)),
				E('td', { 'class': 'td' }, n.ipaddr
					? [ n.ipaddr, E('br'), E('small', {}, n.check || '') ]
					: E('em', {}, _('not set'))),
				E('td', { 'class': 'td' }, [
					n.tty_present ? n.tty.replace('/dev/', '') : E('em', {}, _('no tty')),
					E('br'),
					E('small', {}, n.console_server ? _('server on, %s baud').format(n.baud) : _('server off'))
				]),
				E('td', { 'class': 'td' }, [
					n.power
						? self.btn(_('Shutdown'), 'cbi-button-action', function() {
							return self.doAction(n.id, 'shutdown', null, _('Press the power button of %s and cut power once it is down?'));
						}, busy)
						: self.btn(_('Power on'), 'cbi-button-positive', function() {
							return self.doAction(n.id, 'poweron');
						}, busy),
					self.btn(_('Reboot'), 'cbi-button-action', function() {
						return self.doAction(n.id, 'reboot', null, _('Gracefully reboot %s?'));
					}, busy || !n.power),
					self.btn(_('Reset'), 'cbi-button-negative', function() {
						return self.doAction(n.id, 'reset', null, _('Hardware reset %s? Unsaved data will be lost.'));
					}, busy || !n.power),
					self.btn(_('Power off'), 'cbi-button-negative', function() {
						return self.doAction(n.id, 'poweroff', null, _('Cut power of %s immediately? Unsaved data will be lost.'));
					}, !n.power),
					' ',
					self.btn(_('Serial'), '', function() { return self.openConsole(n.id, 'serial'); }, !n.tty_present),
					self.btn(_('Console log'), '', function() { return self.showConsoleLog(n); }),
					self.btn(_('SSH'), '', function() { return self.openConsole(n.id, 'ssh'); }, !n.ipaddr || !n.reachable),
					self.btn(_('Job log'), '', function() { return self.showLog(n.id); })
				])
			]);
		});
	},

	renderChassis: function(c) {
		var self = this;
		var duty = E('input', {
			'type': 'number', 'min': 0, 'max': 100, 'style': 'width:5em',
			'class': 'cbi-input-text', 'value': c.fan_duty != null && c.fan_duty >= 0 ? c.fan_duty : ''
		});

		return [
			E('span', { 'style': 'margin-right:2em' }, [
				E('strong', {}, _('Node power rail: ')),
				c.ext_power == null ? '-' : badge(c.ext_power ? _('on') : _('off'), c.ext_power ? '#2a2' : '#888')
			]),
			E('span', {}, [
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

	refresh: function() {
		var self = this;

		return callStatus().then(normalize).then(function(st) {
			var tbody = document.getElementById('nodectl-rows');
			var chassis = document.getElementById('nodectl-chassis');

			if (tbody)
				dom.content(tbody, self.renderRows(st.nodes));
			if (chassis && !chassis.contains(document.activeElement))
				dom.content(chassis, self.renderChassis(st.chassis));
		});
	},

	render: function(st) {
		var self = this;

		poll.add(function() { return self.refresh(); }, 5);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Blade3 nodes')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Power, reset and console access for the nodes of this ClusterBox. Node IP addresses and timings are set under Cluster → Settings.')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'id': 'nodectl-chassis', 'style': 'margin-bottom:1em' }, this.renderChassis(st.chassis)),
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
						E('th', { 'class': 'th' }, _('IP address')),
						E('th', { 'class': 'th' }, _('Console')),
						E('th', { 'class': 'th' }, _('Actions'))
					])),
					E('tbody', { 'id': 'nodectl-rows' }, this.renderRows(st.nodes))
				])
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
