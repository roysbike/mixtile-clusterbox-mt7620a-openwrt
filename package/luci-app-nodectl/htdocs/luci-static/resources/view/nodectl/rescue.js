'use strict';
'require view';
'require rpc';
'require ui';
'require fs';
'require form';

var PXE = '/opt/pxe';

var callPxe = rpc.declare({ object: 'nodectl', method: 'pxe' });
var callPxeDelete = rpc.declare({ object: 'nodectl', method: 'pxe_delete', params: [ 'name' ] });
var callPxeEnable = rpc.declare({ object: 'nodectl', method: 'pxe_enable', params: [ 'enable', 'bootfile' ] });

function fmtSize(n) {
	if (n >= 1073741824)
		return (n / 1073741824).toFixed(1) + ' GiB';
	if (n >= 1048576)
		return (n / 1048576).toFixed(1) + ' MiB';
	if (n >= 1024)
		return (n / 1024).toFixed(1) + ' KiB';
	return n + ' B';
}

return view.extend({
	load: function() {
		return callPxe();
	},

	renderFiles: function(info) {
		var self = this;
		var files = info.files || [];

		if (!files.length)
			return E('p', { 'class': 'cbi-value-description' }, _('No images in /opt/pxe yet. Upload a kernel, initramfs, iPXE script or ISO below.'));

		return E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('File')),
				E('th', { 'class': 'th' }, _('Size')),
				E('th', { 'class': 'th' }, _('Use as DHCP boot')),
				E('th', { 'class': 'th' }, '')
			])
		].concat(files.map(function(f) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, f.name),
				E('td', { 'class': 'td' }, fmtSize(f.size)),
				E('td', { 'class': 'td' }, E('button', {
					'class': 'btn',
					'click': ui.createHandlerFn(self, function() {
						return callPxeEnable(true, f.name).then(function() {
							ui.addNotification(null, E('p', {}, _('TFTP enabled, boot file %s').format(f.name)), 'info');
							return location.reload();
						});
					})
				}, _('Advertise'))),
				E('td', { 'class': 'td' }, E('button', {
					'class': 'btn cbi-button-negative',
					'click': ui.createHandlerFn(self, function() {
						if (!window.confirm(_('Delete %s?').format(f.name)))
							return;
						return callPxeDelete(f.name).then(function() { return location.reload(); });
					})
				}, _('Delete')))
			]);
		})));
	},

	render: function(info) {
		var self = this;
		info = info || {};

		var file = E('input', { 'type': 'file', 'style': 'margin-right:8px' });
		var upload = E('button', {
			'class': 'btn cbi-button-apply',
			'click': ui.createHandlerFn(this, function() {
				if (!file.files || !file.files[0])
					return;
				var f = file.files[0];
				var name = f.name.replace(/[^A-Za-z0-9._+-]/g, '_');
				ui.addNotification(null, E('p', {}, _('Uploading %s…').format(name)), 'info');
				return f.arrayBuffer().then(function(buf) {
					return fs.write(PXE + '/' + name, new Blob([buf]));
				}).then(function() {
					return location.reload();
				}).catch(function(err) {
					ui.addNotification(null, E('p', {}, err.message || String(err)), 'danger');
				});
			})
		}, _('Upload to /opt/pxe'));

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Rescue / PXE')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Keep install and rescue images on the SD card and serve them to Blade3 nodes. Do not bake ISOs into the firmware image.')),
			E('div', { 'class': 'cbi-section' }, [
				E('p', {}, [
					E('strong', {}, _('TFTP: ')),
					info.tftp ? _('on') : _('off'),
					' · ',
					E('strong', {}, _('Root: ')), info.tftp_root || '/opt/pxe',
					' · ',
					E('strong', {}, _('Boot file: ')), info.bootfile || E('em', {}, _('not set')),
					E('br'),
					E('strong', {}, _('HTTP: ')), info.http || '/pxe/'
				]),
				E('p', {}, [
					E('button', {
						'class': 'btn cbi-button-positive',
						'click': ui.createHandlerFn(this, function() {
							return callPxeEnable(true, info.bootfile || '').then(function() { return location.reload(); });
						})
					}, _('Enable TFTP')),
					' ',
					E('button', {
						'class': 'btn',
						'click': ui.createHandlerFn(this, function() {
							return callPxeEnable(false, '').then(function() { return location.reload(); });
						})
					}, _('Disable TFTP'))
				])
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Images')),
				this.renderFiles(info),
				E('div', { 'style': 'margin-top:1em' }, [ file, upload ])
			]),
			E('div', { 'class': 'cbi-section-descr' }, [
				E('h3', {}, _('What to put here')),
				E('ul', {}, [
					E('li', {}, [ E('strong', {}, _('Kernel + initramfs')), ' — ',
						_('Best for Talos / Linux netboot. Advertise the kernel filename via TFTP.') ]),
					E('li', {}, [ E('strong', {}, _('iPXE script (.ipxe)')), ' — ',
						_('Then chain HTTP URLs for large images. HTTP path is %s').format(info.http || '/pxe/') ]),
					E('li', {}, [ E('strong', {}, _('ISO / IMG')), ' — ',
						_('Useful as a file the node can wget/dd, or for iPXE sanboot. TFTP of a multi-gigabyte ISO is a bad idea on this SoC; use HTTP.') ]),
					E('li', {}, [ E('strong', {}, _('Ready-made OpenWrt ISO')), ' — ',
						_('No. The ClusterBox firmware is a squashfs sysupgrade, not a PC ISO. Rescue images are for the Blade3 nodes, not for the BMC.') ])
				]),
				E('p', {}, _('Fine-grained DHCP/PXE match rules (BIOS vs UEFI) stay under Network → DHCP and DNS → PXE/TFTP.'))
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
