'use strict';
'require view';

/* LuCI menu entry "ClusterBox UI": opens the main web UI (MoCI). It
 * keeps its own session, so it may ask to log in once. */
return view.extend({
	load: function() {
		window.location.href = '/moci/#/cluster';
		return new Promise(function() {});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
