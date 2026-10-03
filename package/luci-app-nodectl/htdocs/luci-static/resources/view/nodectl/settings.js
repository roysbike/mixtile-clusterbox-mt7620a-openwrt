'use strict';
'require view';
'require form';
'require rpc';

var callLeases = rpc.declare({
	object: 'nodectl',
	method: 'leases',
	expect: { leases: [] }
});

var callPubkey = rpc.declare({
	object: 'nodectl',
	method: 'pubkey',
	expect: { pubkey: '' }
});

return view.extend({
	load: function() {
		return Promise.all([ callLeases(), callPubkey() ]);
	},

	render: function(data) {
		var leases = data[0], pubkey = data[1];
		var m, s, o;

		m = new form.Map('nodectl', _('Cluster settings'),
			_('Behaviour of node power control and per-node access settings.'));

		s = m.section(form.NamedSection, 'global', 'global', _('General'));

		o = s.option(form.ListValue, 'boot_action', _('On ClusterBox boot'));
		o.value('poweron', _('Power on nodes with autostart (keep running ones)'));
		o.value('keep', _('Do nothing'));
		o.value('cycle', _('Hard power cycle nodes with autostart'));
		o.default = 'poweron';

		o = s.option(form.ListValue, 'stop_action', _('On ClusterBox shutdown/reboot'));
		o.value('none', _('Keep nodes running'));
		o.value('shutdown', _('Graceful shutdown of all nodes'));
		o.value('poweroff', _('Cut power of all nodes'));
		o.default = 'none';

		o = s.option(form.Value, 'rescan_delay', _('PCIe rescan after boot (s)'), _('0 disables'));
		o.datatype = 'uinteger';
		o.default = '60';

		o = s.option(form.Value, 'press_ms', _('Power button press (ms)'));
		o.datatype = 'range(50,5000)';
		o.default = '500';

		o = s.option(form.Value, 'force_press_ms', _('Forced power-off press (ms)'));
		o.datatype = 'range(1000,20000)';
		o.default = '8000';

		o = s.option(form.Value, 'reset_ms', _('Reset pulse (ms)'));
		o.datatype = 'range(10,5000)';
		o.default = '200';

		o = s.option(form.Value, 'shutdown_timeout', _('Shutdown timeout (s)'),
			_('Power is cut after this time even if the node still answers.'));
		o.datatype = 'range(10,600)';
		o.default = '90';

		o = s.option(form.Value, 'shutdown_grace', _('Grace after node goes offline (s)'));
		o.datatype = 'range(0,120)';
		o.default = '10';

		o = s.option(form.Value, 'ssh_user', _('Default SSH user'));
		o.default = 'root';

		o = s.option(form.Value, 'flash_target', _('Default flash target'));
		o.default = '/dev/mmcblk0';

		s = m.section(form.TypedSection, 'node', _('Nodes'));
		s.anonymous = false;
		s.addremove = false;

		o = s.option(form.Value, 'name', _('Name'));

		o = s.option(form.Value, 'ipaddr', _('IP address'),
			_('Address on the pci0 network (10.20.0.0/24), used for status, SSH and flashing.'));
		o.datatype = 'ip4addr';
		leases.forEach(function(l) {
			o.value(l.ipaddr, '%s (%s %s)'.format(l.ipaddr, l.hostname || '?', l.mac));
		});

		o = s.option(form.Flag, 'autostart', _('Power on at boot'));
		o.default = '1';

		o = s.option(form.Value, 'ssh_user', _('SSH user'));
		o.placeholder = 'root';

		o = s.option(form.Value, 'ssh_password', _('SSH password'),
			_('Optional. Prefer adding the ClusterBox public key below to the node instead.'));
		o.password = true;

		return m.render().then(function(node) {
			node.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('ClusterBox SSH public key')),
				E('p', {}, _('Add this line to ~/.ssh/authorized_keys on each node for passwordless SSH console and flashing.')),
				E('pre', { 'style': 'white-space:pre-wrap;word-break:break-all' }, pubkey || _('Unable to read key'))
			]));
			return node;
		});
	}
});
