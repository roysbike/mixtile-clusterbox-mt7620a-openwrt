'use strict';
'require baseclass';
'require fs';

// System / Overview: identity of the installed ClusterBox firmware,
// read from /etc/mixtile-release (generated when the firmware was built).

function parseRelease(text) {
	var r = {};

	(text || '').split(/\n/).forEach(function(line) {
		var m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
		if (m)
			r[m[1]] = m[2];
	});

	return r;
}

return baseclass.extend({
	title: _('Mixtile ClusterBox'),

	load: function() {
		return L.resolveDefault(fs.read('/etc/mixtile-release'), '');
	},

	render: function(text) {
		var r = parseRelease(text);

		if (!r.FIRMWARE_VERSION)
			return null;

		var tagUrl = r.REPOSITORY ? r.REPOSITORY + '/releases/tag/' + r.FIRMWARE_VERSION : null,
		    commitUrl = r.REPOSITORY && r.GIT_COMMIT ? r.REPOSITORY + '/commit/' + r.GIT_COMMIT : null;

		var fields = [
			_('Firmware'), tagUrl ? E('a', { href: tagUrl, target: '_blank', rel: 'noreferrer' }, r.FIRMWARE_VERSION) : r.FIRMWARE_VERSION,
			_('Commit'), commitUrl ? E('a', { href: commitUrl, target: '_blank', rel: 'noreferrer' }, r.GIT_COMMIT_SHORT || r.GIT_COMMIT) : r.GIT_COMMIT,
			_('Build date'), r.BUILD_DATE,
			_('OpenMIOP protocol'), r.OPENMIOP_PROTOCOL ? 'v' + r.OPENMIOP_PROTOCOL + (r.OPENMIOP_VERSION ? ' (openmiop ' + r.OPENMIOP_VERSION + ')' : '') : null,
			_('OpenWrt / kernel'), [ r.OPENWRT_VERSION, r.KERNEL_VERSION ].filter(Boolean).join(' / '),
			_('Board'), [ r.BOARD, r.TARGET ].filter(Boolean).join(', '),
			_('Update channel'), E('span', {}, [ r.UPDATE_CHANNEL || 'rc', ' · ',
				E('a', { href: L.url('admin/system/mixtile-update') }, _('Firmware Update')) ])
		];

		var table = E('table', { 'class': 'table' });

		for (var i = 0; i < fields.length; i += 2)
			table.appendChild(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '33%' }, [ fields[i] ]),
				E('td', { 'class': 'td left' }, [ (fields[i + 1] != null && fields[i + 1] !== '') ? fields[i + 1] : '?' ])
			]));

		return table;
	}
});
