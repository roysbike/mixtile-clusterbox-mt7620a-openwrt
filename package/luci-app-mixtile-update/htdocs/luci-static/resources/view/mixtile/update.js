'use strict';
'require view';
'require form';
'require fs';
'require ui';
'require dom';

// Firmware Update: a front end for /usr/libexec/mixtile-update. Every
// check (board, target, version, OpenMIOP protocol, checksum, signature)
// happens in the backend; this page only shows its JSON answers.

var BACKEND = '/usr/libexec/mixtile-update';

function run(args) {
	return fs.exec(BACKEND, args).then(function(res) {
		var out = {};

		try { out = JSON.parse(res.stdout || '{}'); }
		catch (e) { out = { status: 'error', message: (res.stderr || res.stdout || _('No answer from the update backend')).trim() }; }

		if (res.code != 0 && out.status != 'error')
			out = { status: 'error', message: out.message || (res.stderr || '').trim() || _('Command failed') };

		return out;
	});
}

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '33%' }, [ label ]),
		E('td', { 'class': 'td left' }, [ value != null && value !== '' ? value : '-' ])
	]);
}

function short(commit) {
	return commit ? commit.substring(0, 7) : '';
}

return view.extend({
	load: function() {
		return run([ 'status' ]);
	},

	statusTable: function(st) {
		var current = st.current_version ? '%s (%s)'.format(st.current_version, short(st.current_commit)) : _('unknown');
		var state;

		if (st.pending_install)
			state = _('Installed update is being verified');
		else if (st.update_available === true)
			state = E('strong', {}, _('Update available'));
		else if (st.latest_version)
			state = _('Up to date');
		else
			state = _('Not checked yet');

		var t = E('table', { 'class': 'table' }, [
			row(_('Current'), current),
			row(_('Latest'), st.latest_version ? '%s%s'.format(st.latest_version, st.checked_at ? ' (' + _('checked') + ' ' + st.checked_at + ')' : '') : null),
			row(_('Channel'), st.channel == 'stable' ? _('Stable') : _('RC (release candidates)')),
			row(_('OpenMIOP'), st.openmiop_protocol ? 'v' + st.openmiop_protocol : null),
			row(_('Board'), [ st.board, st.target ].filter(Boolean).join(', ')),
			row(_('Update source'), st.repository ? E('a', { href: 'https://github.com/' + st.repository + '/releases', target: '_blank', rel: 'noreferrer' }, 'github.com/' + st.repository) : null),
			row(_('Status'), state)
		]);

		if (st.last_install) {
			var p = st.last_install.split(' ');
			t.appendChild(row(_('Last update'), p[0] == 'ok'
				? _('%s installed and verified after reboot').format(p[1])
				: E('span', { 'class': 'alert-message warning' }, _('expected %s, running %s (%s)').format(p[1], p[2], short(p[3])))));
		}

		return t;
	},

	render: function(st) {
		var m, s, o;

		this.st = st;
		this.statusNode = E('div', {}, this.statusTable(st));
		this.releaseNode = E('div');
		this.actionNode = E('div', { 'class': 'cbi-page-actions', 'style': 'text-align:left' });

		m = new form.Map('mixtile-update', _('Firmware Update'),
			_('Checks GitHub Releases of the firmware repository for a newer ClusterBox firmware. Nothing is installed without your confirmation. The image is checked for this board and target, the version, the OpenMIOP protocol and its SHA-256 checksum before it can be installed.'));

		s = m.section(form.NamedSection, 'main', 'updater', _('Settings'));
		o = s.option(form.ListValue, 'channel', _('Release channel'),
			_('RC includes release candidates; Stable only final releases. Default: the channel of the installed firmware.'));
		o.value('', _('Default (%s)').format(st.channel || 'rc'));
		o.value('rc', _('RC (release candidates)'));
		o.value('stable', _('Stable'));

		return m.render().then(L.bind(function(mapEl) {
			this.updateActions();
			return E([], [
				mapEl,
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, _('Status')),
					this.statusNode,
					this.releaseNode,
					this.actionNode
				])
			]);
		}, this));
	},

	refresh: function() {
		return run([ 'status' ]).then(L.bind(function(st) {
			this.st = st;
			dom.content(this.statusNode, this.statusTable(st));
			this.updateActions();
			return st;
		}, this));
	},

	updateActions: function() {
		var st = this.st,
		    downloaded = (st.download == 'done'),
		    verified = !!st.verified_sha256;

		var btn = function(label, style, fn, disabled) {
			return E('button', { 'class': 'btn cbi-button ' + style, 'click': fn, 'disabled': disabled ? true : null }, [ label ]);
		};

		dom.content(this.actionNode, [
			btn(_('Check for updates'), 'cbi-button-action', ui.createHandlerFn(this, 'handleCheck')),
			' ',
			btn(_('Download & verify'), 'cbi-button-apply', ui.createHandlerFn(this, 'handleDownload'), !st.update_available),
			' ',
			btn(_('Install update'), 'cbi-button-negative important', ui.createHandlerFn(this, 'handleInstall'), !(downloaded && verified))
		]);
	},

	showRelease: function(c) {
		if (!c.latest_version) {
			dom.content(this.releaseNode, E('p', {}, c.message || _('No release found.')));
			return;
		}

		dom.content(this.releaseNode, [
			E('h4', {}, [ _('Release %s').format(c.latest_version), ' ',
				c.release_url ? E('a', { href: c.release_url, target: '_blank', rel: 'noreferrer' }, _('(release page)')) : '' ]),
			E('table', { 'class': 'table' }, [
				row(_('Commit'), short(c.commit)),
				row(_('Image'), '%s, %1024.2mB'.format(c.image || '?', c.image_size || 0)),
				row(_('SHA-256'), E('code', {}, c.image_sha256 || '')),
				row(_('OpenMIOP'), c.openmiop_protocol ? 'v' + c.openmiop_protocol : null),
				row(_('Signed'), c.signed ? _('yes (SHA256SUMS.sig)') : _('no (checksum only)'))
			]),
			E('details', {}, [
				E('summary', {}, _('Release notes')),
				E('pre', { 'style': 'white-space:pre-wrap; max-height:24em; overflow-y:auto' }, c.release_notes || '')
			])
		]);
	},

	handleCheck: function(ev) {
		return run([ 'check' ]).then(L.bind(function(c) {
			if (c.status == 'error') {
				ui.addNotification(null, E('p', _('Update check failed: %s').format(c.message)), 'danger');
				return;
			}

			this.showRelease(c);
			return this.refresh();
		}, this));
	},

	handleDownload: function(ev) {
		return run([ 'download', '--background' ]).then(L.bind(function(r) {
			if (r.status == 'error') {
				ui.addNotification(null, E('p', _('Download failed: %s').format(r.message)), 'danger');
				return;
			}

			var bar = E('p', { 'class': 'spinning' }, _('Downloading…'));
			ui.showModal(_('Downloading firmware'), [ bar ]);

			return new Promise(L.bind(function(resolve) {
				var tick = L.bind(function() {
					run([ 'status' ]).then(L.bind(function(st) {
						if (st.download == 'running') {
							bar.firstChild.data = _('Downloading… %1024.2mB').format(st.downloaded_bytes || 0);
							window.setTimeout(tick, 2000);
							return;
						}

						if (st.download != 'done') {
							ui.hideModal();
							ui.addNotification(null, E('p', _('Download failed: %s').format(st.download_error || _('unknown error'))), 'danger');
							resolve(this.refresh());
							return;
						}

						bar.firstChild.data = _('Verifying board, version, OpenMIOP protocol and SHA-256…');
						run([ 'verify' ]).then(L.bind(function(v) {
							ui.hideModal();
							if (v.status == 'verified')
								ui.addNotification(null, E('p', _('Firmware %s downloaded and verified (SHA-256 %s).').format(v.version, v.sha256)), 'info');
							else
								ui.addNotification(null, E('p', _('Verification failed: %s').format(v.message)), 'danger');
							resolve(this.refresh());
						}, this));
					}, this));
				}, this);

				window.setTimeout(tick, 1000);
			}, this));
		}, this));
	},

	handleInstall: function(ev) {
		var st = this.st,
		    ack = E('input', { 'type': 'checkbox' }),
		    go = E('button', { 'class': 'btn cbi-button-negative important', 'disabled': true }, [ _('Install and reboot') ]);

		ack.addEventListener('change', function() { go.disabled = !ack.checked; });

		go.addEventListener('click', ui.createHandlerFn(this, function() {
			return run([ 'install', '--yes', '--background' ]).then(function(r) {
				if (r.status == 'error') {
					ui.hideModal();
					ui.addNotification(null, E('p', _('Install refused: %s').format(r.message)), 'danger');
					return;
				}

				ui.showModal(_('Installing…'), [
					E('p', { 'class': 'spinning' }, _('The firmware is being written. The ClusterBox reboots when done. Do not power it off. The blades keep running.'))
				]);
				ui.awaitReconnect(window.location.host);
			});
		}));

		ui.showModal(_('Install firmware update?'), [
			E('p', {}, _('Installing %s over %s (%s).').format(this.st.latest_version || '?', st.current_version || '?', short(st.current_commit))),
			E('ul', {}, [
				E('li', {}, _('Configuration (/etc/config, users, SSH keys, /opt, /home, enabled services) is kept. Packages installed later with opkg are removed.')),
				E('li', {}, _('The BMC reboots (about 2 minutes). Blades keep power and keep running; the PCIe fabric pauses until openmiop-rc starts again.')),
				E('li', {}, _('If the BMC does not come back, recover by writing the firmware to the microSD card (see the release notes).'))
			]),
			E('p', {}, E('label', {}, [ ack, ' ', _('I have read the recovery notes for this release') ])),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]), ' ', go
			])
		]);
	}
});
