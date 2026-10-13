'use strict';
'require view';
'require form';
'require rpc';
'require ui';
'require fs';
'require poll';
'require dom';

var KUBECONFIG = '/etc/teleport/kubeconfig';

var callStatus = rpc.declare({ object: 'teleport', method: 'status' });
var callServer = rpc.declare({ object: 'teleport', method: 'server', params: [ 'proxy' ] });
var callVersions = rpc.declare({ object: 'teleport', method: 'versions', expect: { versions: [] } });
var callInstall = rpc.declare({ object: 'teleport', method: 'install', params: [ 'version' ] });
var callService = rpc.declare({ object: 'teleport', method: 'service', params: [ 'action' ] });
var callLog = rpc.declare({ object: 'teleport', method: 'log', params: [ 'lines' ] });

function parseVer(v) {
	var m = String(v || '').match(/^v?(\d+)\.(\d+)\.(\d+)/);
	return m ? [ +m[1], +m[2], +m[3] ] : null;
}

function cmpVer(a, b) {
	for (var i = 0; i < 3; i++)
		if (a[i] != b[i])
			return a[i] - b[i];
	return 0;
}

/* Teleport supports agents that are not newer than the cluster and at most
 * one major version behind it. */
function compat(agent, server) {
	var a = parseVer(agent), s = parseVer(server);

	if (!a || !s)
		return null;
	if (cmpVer(a, s) > 0)
		return _('agent %s is newer than the cluster %s - not supported').format(agent, server);
	if (s[0] - a[0] > 1)
		return _('agent %s is more than one major version behind the cluster %s').format(agent, server);
	return '';
}

function badge(text, color) {
	return E('span', {
		'style': 'display:inline-block;padding:2px 8px;border-radius:10px;color:#fff;background:' + color
	}, text);
}

return view.extend({
	load: function() {
		return Promise.all([
			callStatus(),
			callServer('').catch(function() { return {}; }),
			callVersions().catch(function() { return []; })
		]);
	},

	renderStatus: function(st, srv, versions) {
		var self = this;
		var issue = compat(st.installed, srv.server_version);
		var sel = E('select', { 'class': 'cbi-input-select' }, [ E('option', { 'value': 'latest' }, _('latest')) ]
			.concat(versions.map(function(v) {
				var c = compat(v, srv.server_version);
				return E('option', { 'value': v }, c ? '%s (%s)'.format(v, _('incompatible')) : v);
			})));
		var state = st.install_state || '';

		/* Preselect the newest build the cluster supports. */
		for (var i = 0; i < versions.length; i++) {
			if (compat(versions[i], srv.server_version) === '') {
				sel.value = versions[i];
				break;
			}
		}

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Agent')),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'width': '33%' }, _('Binary')),
					E('td', { 'class': 'td left' }, st.installed
						? [ 'v' + st.installed, ' ', E('small', {}, _('(%s free on /opt)').format(st.disk_free || '?')) ]
						: E('em', {}, _('not installed')))
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, _('Service')),
					E('td', { 'class': 'td left' }, st.running
						? [ badge(_('running'), '#2a2'), ' ', _('PID %d, %d MiB RSS').format(st.pid, Math.round(st.rss_kb / 1024)) ]
						: badge(_('stopped'), '#888'))
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, _('Cluster')),
					E('td', { 'class': 'td left' }, srv.server_version
						? [ '%s - Teleport v%s'.format(srv.proxy, srv.server_version),
							srv.tunnel_addr ? E('small', {}, ' (' + _('tunnel %s').format(srv.tunnel_addr) + ')') : '',
							issue ? [ E('br'), badge(issue, '#c33') ] : '' ]
						: E('em', {}, srv.proxy ? _('%s is not reachable').format(srv.proxy) : _('proxy not configured')))
				]),
				state ? E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, _('Installer')),
					E('td', { 'class': 'td left' }, state)
				]) : ''
			]),
			E('div', { 'style': 'margin-top:.5em' }, [
				sel, ' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'disabled': st.installing ? '' : null,
					'click': ui.createHandlerFn(this, function() {
						return callInstall(sel.value).then(function(res) {
							if (res.code != 0)
								ui.addNotification(null, E('p', {}, res.output), 'danger');
							return self.refreshStatus();
						});
					})
				}, st.installed ? _('Update / reinstall') : _('Install')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(this, 'service', 'restart') }, _('Restart')), ' ',
				E('button', { 'class': 'btn cbi-button cbi-button-negative', 'click': ui.createHandlerFn(this, 'service', 'stop') }, _('Stop')), ' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(this, 'showLog') }, _('Log'))
			]),
			E('p', { 'class': 'cbi-section-descr' },
				_('The agent (~380 MB) is downloaded from the firmware repository releases into /opt/teleport on the SD card. It only makes outbound connections to the proxy; auth and proxy services are disabled.'))
		]);
	},

	service: function(action) {
		var self = this;

		return callService(action).then(function(res) {
			if (res.code != 0)
				ui.addNotification(null, E('pre', {}, res.output || _('Command failed')), 'danger');
			return self.refreshStatus();
		});
	},

	showLog: function() {
		return callLog(300).then(function(res) {
			ui.showModal(_('Teleport log'), [
				res.install_log ? [ E('h4', {}, _('Installer')), E('pre', { 'style': 'white-space:pre-wrap' }, res.install_log) ] : '',
				E('h4', {}, _('Agent')),
				E('pre', { 'style': 'max-height:55vh;overflow:auto;white-space:pre-wrap;font-size:12px' }, res.log || _('No log entries.')),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			], 'cbi-modal');
		});
	},

	refreshStatus: function() {
		var self = this;

		/* Only poll the cheap status (pid/rss). server/versions hit the
		 * network and must not run on the 10s timer — they used to fork
		 * the 380 MB agent binary via `teleport version`. */
		return callStatus().then(function(st) {
			var el = document.getElementById('teleport-status');
			if (el && !el.contains(document.activeElement))
				dom.content(el, self.renderStatus(st, self._server || {}, self._versions || []));
		});
	},

	render: function(data) {
		var self = this;
		var m, s, o;

		m = new form.Map('teleport', _('Teleport'),
			_('Connects this ClusterBox to a Teleport cluster and publishes SSH to the box, web apps (including this UI), Kubernetes and databases reachable from it.'));

		s = m.section(form.NamedSection, 'main', 'teleport', _('Cluster connection'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('Enable agent'));
		o.rmempty = false;

		o = s.option(form.Value, 'proxy_server', _('Proxy address'), _('host:port of the Teleport proxy, e.g. teleport.example.com:443'));
		o.datatype = 'hostport';
		o.rmempty = false;

		o = s.option(form.ListValue, 'join_method', _('Join method'));
		o.value('token', _('Token'));
		o.value('bound_keypair', _('Bound keypair'));
		o.default = 'token';

		o = s.option(form.Value, 'token', _('Join token'),
			_('Create with: tctl tokens add --type=node,app,kube,db --ttl=1h'));
		o.password = true;

		o = s.option(form.DynamicList, 'ca_pin', _('CA pin'), _('Optional, from tctl status (sha256:...)'));

		o = s.option(form.Value, 'nodename', _('Node name'));
		o.placeholder = 'clusterbox';

		o = s.option(form.DynamicList, 'label', _('Labels'), _('key=value, applied to the SSH node'));

		o = s.option(form.ListValue, 'log_severity', _('Log level'));
		[ 'ERROR', 'WARN', 'INFO', 'DEBUG' ].forEach(function(l) { o.value(l); });
		o.default = 'INFO';

		o = s.option(form.Value, 'mem_limit', _('Memory limit (MiB)'), _('Soft Go heap limit; the box has 256 MiB RAM.'));
		o.datatype = 'range(48,200)';
		o.placeholder = '64';

		o = s.option(form.Value, 'nice', _('CPU nice'),
			_('15 keeps LuCI responsive. 0 lets the agent use the whole core (XHR timeouts).'));
		o.datatype = 'range(0,19)';
		o.placeholder = '15';

		o = s.option(form.Value, 'data_dir', _('Data directory'));
		o.placeholder = '/opt/teleport/data';

		s = m.section(form.NamedSection, 'installer', 'installer', _('Agent download'));
		s.addremove = false;
		o = s.option(form.Value, 'repo', _('GitHub repository'),
			_('Must publish teleport-v*-mipsel release assets. Default is the official firmware repo.'));
		o.placeholder = 'mixtile-rockchip/mixtile-clusterbox-mt7620a-openwrt';
		o = s.option(form.Value, 'version', _('Default version'));
		o.placeholder = 'latest';

		s = m.section(form.NamedSection, 'ssh', 'ssh', _('SSH to the ClusterBox'));
		s.addremove = false;
		o = s.option(form.Flag, 'enabled', _('Enable'));
		o.default = '1';
		o = s.option(form.DynamicList, 'label', _('Extra labels'));

		s = m.section(form.GridSection, 'app', _('Web applications'),
			_('HTTP(S) services reachable from the ClusterBox. URI \'luci\' publishes this UI on the port uhttpd listens on.'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = true;
		s.nodescriptions = true;

		o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.default = '1';
		o.editable = true;
		o = s.option(form.Value, 'name', _('Name'));
		o.datatype = 'and(minlength(1),maxlength(63))';
		o.rmempty = false;
		o = s.option(form.Value, 'uri', _('URI'));
		o.placeholder = 'http://10.0.0.10:8080';
		o.rmempty = false;
		o = s.option(form.Value, 'public_addr', _('Public address'));
		o.modalonly = true;
		o.optional = true;
		o = s.option(form.Value, 'description', _('Description'));
		o.modalonly = true;
		o = s.option(form.Flag, 'insecure_skip_verify', _('Skip TLS verification'));
		o.modalonly = true;
		o = s.option(form.DynamicList, 'label', _('Labels'));
		o.modalonly = true;

		s = m.section(form.NamedSection, 'kube', 'kube', _('Kubernetes'));
		s.addremove = false;
		o = s.option(form.Flag, 'enabled', _('Enable'));
		o = s.option(form.TextValue, '_kubeconfig', _('kubeconfig'),
			_('Stored in %s. Every context becomes a Kubernetes cluster in Teleport; the API servers must be reachable from the ClusterBox.').format(KUBECONFIG));
		o.rows = 12;
		o.monospace = true;
		o.load = function() {
			return fs.read(KUBECONFIG).catch(function() { return ''; });
		};
		o.write = function(sid, value) {
			return fs.write(KUBECONFIG, value.replace(/\r\n/g, '\n').trim() + '\n');
		};
		o.remove = function() {};
		o = s.option(form.DynamicList, 'label', _('Labels'));

		s = m.section(form.GridSection, 'database', _('Databases'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;

		o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.default = '1';
		o.editable = true;
		o = s.option(form.Value, 'name', _('Name'));
		o.rmempty = false;
		o = s.option(form.ListValue, 'protocol', _('Protocol'));
		[ 'postgres', 'mysql', 'mongodb', 'redis', 'cockroachdb', 'clickhouse', 'clickhouse-http',
		  'sqlserver', 'elasticsearch', 'opensearch', 'cassandra' ].forEach(function(p) { o.value(p); });
		o = s.option(form.Value, 'uri', _('Address'));
		o.placeholder = '10.0.0.20:5432';
		o.rmempty = false;
		o = s.option(form.ListValue, 'tls_mode', _('TLS'));
		o.value('', _('verify-full (default)'));
		o.value('verify-ca', 'verify-ca');
		o.value('insecure', 'insecure');
		o.modalonly = true;
		o = s.option(form.Value, 'description', _('Description'));
		o.modalonly = true;
		o = s.option(form.DynamicList, 'label', _('Labels'));
		o.modalonly = true;

		this._server = data[1] || {};
		this._versions = data[2] || [];
		poll.add(function() { return self.refreshStatus(); }, 15);

		return m.render().then(function(node) {
			var descr = node.querySelector('.cbi-map-descr');
			var status = E('div', { 'id': 'teleport-status' }, self.renderStatus(data[0], self._server, self._versions));

			if (descr)
				descr.parentNode.insertBefore(status, descr.nextSibling);
			else
				node.insertBefore(status, node.firstChild);
			return node;
		});
	}
});
