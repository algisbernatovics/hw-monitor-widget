import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

/**
 * GNOME Shell imports extension.js once per session and then caches it.
 * The panel implementation lives in widget.js and is imported with the
 * file mtime on the URL, so a disable/enable picks up later edits.
 */
function widgetModuleUrl() {
    const base = import.meta.url.replace(/\/[^/]*$/, '');
    const file = Gio.File.new_for_uri(`${base}/widget.js`);
    let stamp = Date.now();
    try {
        const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        const mtime = info.get_modification_time();
        stamp = `${mtime.tv_sec}${mtime.tv_usec}`;
    } catch (_e) {
        /* fall back to Date.now() */
    }
    return `${base}/widget.js?t=${stamp}`;
}

export default class HwMonitorWidgetExtension extends Extension {
    async enable() {
        const mod = await import(widgetModuleUrl());
        this._inner = new mod.default(this.metadata);
        await this._inner.enable();
    }

    disable() {
        this._inner?.disable();
        this._inner = null;
    }
}
