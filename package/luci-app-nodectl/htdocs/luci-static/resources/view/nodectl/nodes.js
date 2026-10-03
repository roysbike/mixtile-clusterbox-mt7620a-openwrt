'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require dom';

var callStatus = rpc.declare({
	object: 'nodectl',
	method: 'status',
	expect: { nodes: [] }
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

function nodeState(n) {
	if (n.busy)
		return [ _('Busy: %s').format(n.busy), '#e0a000' ];
	if (!n.power)
		return [ _('Off'), '#888' ];
	if (n.ping)
		return [ _('Online'), '#2a2' ];
	if (n.ping === false)
		return [ n.pcie ? _('Booting / no network') : _('No PCIe link'), '#e0a000' ];
	return [ n.pcie ? _('Powered, PCIe up') : _('Powered, no PCIe link'), '#e0a000' ];
}

function badge(text, color) {
	return E('span', {
		'style': 'display:inline-block;padding:2px 8px;border-radius:10px;color:#fff;background:' + color
	}, text);
}

function yesno(v) {
	return v == null ? '-' : (v ? _('yes') : _('no'));
}

return view.extend({
	load: function() {
		return callStatus();
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
				E('td', { 'class': 'td' }, yesno(n.pcie)),
				E('td', { 'class': 'td' }, n.ipaddr || E('em', {}, _('not set'))),
				E('td', { 'class': 'td' }, String(n.prz)),
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
					self.btn(_('SSH'), '', function() { return self.openConsole(n.id, 'ssh'); }, !n.ipaddr || !n.ping),
					self.btn(_('Log'), '', function() { return self.showLog(n.id); })
				])
			]);
		});
	},

	refresh: function() {
		var self = this;

		return callStatus().then(function(nodes) {
			var tbody = document.getElementById('nodectl-rows');
			if (tbody)
				dom.content(tbody, self.renderRows(nodes));
		});
	},

	render: function(nodes) {
		var self = this;

		poll.add(function() { return self.refresh(); }, 5);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Blade3 nodes')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Power, reset and console access for the nodes of this ClusterBox. Node IP addresses and timings are set under Cluster → Settings.')),
			E('div', { 'class': 'cbi-section' }, [
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
						E('th', { 'class': 'th' }, _('PRZ')),
						E('th', { 'class': 'th' }, _('Actions'))
					])),
					E('tbody', { 'id': 'nodectl-rows' }, this.renderRows(nodes))
				])
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
