'use strict';
'require view';
'require rpc';
'require ui';
'require uci';
'require poll';

var callStatus = rpc.declare({
	object: 'nodectl',
	method: 'status',
	expect: { nodes: [] }
});

var callFlash = rpc.declare({
	object: 'nodectl',
	method: 'flash',
	params: [ 'node', 'source', 'target', 'reboot' ]
});

var callLog = rpc.declare({
	object: 'nodectl',
	method: 'log',
	params: [ 'node' ],
	expect: { log: '' }
});

return view.extend({
	load: function() {
		return Promise.all([ callStatus(), uci.load('nodectl') ]);
	},

	logNode: 0,

	pollLog: function() {
		var pre = document.getElementById('nodectl-flash-log');

		if (!this.logNode || !pre)
			return Promise.resolve();
		return callLog(this.logNode).then(function(log) {
			var lines = (log || '').replace(/\r/g, '\n').split('\n').filter(function(l) { return l.length; });
			pre.textContent = lines.slice(-40).join('\n') || _('Waiting for output…');
			pre.scrollTop = pre.scrollHeight;
		});
	},

	handleFlash: function(nodes, ev) {
		var self = this;
		var node = +document.getElementById('nodectl-node').value;
		var source = document.getElementById('nodectl-source').value.trim();
		var target = document.getElementById('nodectl-target').value.trim();
		var reboot = document.getElementById('nodectl-reboot').checked;
		var info = nodes.filter(function(n) { return n.id == node; })[0] || {};

		if (!/^(\/|https?:\/\/)/.test(source)) {
			ui.addNotification(null, E('p', {}, _('Enter an absolute path on the ClusterBox or an http(s) URL.')), 'danger');
			return;
		}
		if (!info.ipaddr || !info.ping) {
			ui.addNotification(null, E('p', {}, _('Node %d must be online over SSH (set its IP address in Settings).').format(node)), 'danger');
			return;
		}

		var confirmInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': info.name });
		ui.showModal(_('Overwrite node disk?'), [
			E('p', {}, _('All data on %s of node %d (%s, %s) will be destroyed and replaced with:').format(target, node, info.name, info.ipaddr)),
			E('pre', {}, source),
			E('p', {}, _('Type the node name to confirm:')),
			confirmInput,
			E('div', { 'class': 'right', 'style': 'margin-top:1em' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-negative',
					'click': function() {
						if (confirmInput.value !== info.name)
							return;
						ui.hideModal();
						return callFlash(node, source, target, reboot).then(function(res) {
							if (res.code != 0) {
								ui.addNotification(null, E('pre', {}, res.output || _('Flash failed to start')), 'danger');
								return;
							}
							self.logNode = node;
							ui.addTimeLimitedNotification(null, E('p', {}, _('Flashing node %d started.').format(node)), 5000, 'info');
							return self.pollLog();
						});
					}
				}, _('Flash'))
			])
		]);
	},

	render: function(data) {
		var self = this;
		var nodes = data[0];
		var target = uci.get('nodectl', 'global', 'flash_target') || '/dev/mmcblk0';

		poll.add(function() { return self.pollLog(); }, 3);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Flash node OS image')),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Streams a disk image to the node over SSH (pci0) and writes it to the target device. The image is decompressed on the node; .img, .raw, .bin, .gz, .xz and .zst are supported. The node must be running Linux with SSH access (key from Cluster → Settings, or a password).'),
				E('br'),
				_('The source can be an http(s) URL (streamed, nothing is stored on the ClusterBox) or a file path on the ClusterBox storage.')
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('Node')),
					E('div', { 'class': 'cbi-value-field' }, E('select', { 'id': 'nodectl-node', 'class': 'cbi-input-select' },
						nodes.map(function(n) {
							return E('option', { 'value': n.id }, '#%d %s (%s)'.format(n.id, n.name, n.ping ? _('online') : _('offline')));
						})))
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('Image')),
					E('div', { 'class': 'cbi-value-field' }, E('input', {
						'id': 'nodectl-source', 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%',
						'placeholder': 'https://example.com/blade3-image.img.xz'
					}))
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('Target device')),
					E('div', { 'class': 'cbi-value-field' }, E('input', {
						'id': 'nodectl-target', 'type': 'text', 'class': 'cbi-input-text', 'value': target
					}))
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('Reboot when done')),
					E('div', { 'class': 'cbi-value-field' }, E('input', { 'id': 'nodectl-reboot', 'type': 'checkbox', 'checked': '' }))
				]),
				E('div', { 'class': 'right' }, E('button', {
					'class': 'btn cbi-button-negative important',
					'click': ui.createHandlerFn(this, 'handleFlash', nodes)
				}, _('Flash…'))),
				E('h3', {}, _('Progress')),
				E('pre', { 'id': 'nodectl-flash-log', 'style': 'max-height:40vh;overflow:auto;white-space:pre-wrap' }, _('No flash job started from this page.'))
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
