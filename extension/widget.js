import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

function shellMajorVersion() {
    const ver = String(Config.PACKAGE_VERSION ?? '50');
    return parseInt(ver.split('.')[0], 10) || 50;
}

const HwMonitorToggleButton = GObject.registerClass(
class HwMonitorToggleButton extends PanelMenu.Button {
    _init(panel) {
        super._init(0.0, 'Hardware monitor', true);
        this._hwPanel = panel;
        this._icon = new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);
        this._wireToggleClick();
        this.syncStyle();
    }

    /** GNOME 50+ PanelMenu uses ClickGesture → empty menu; replace with show/hide. */
    _wireToggleClick() {
        const toggle = () => {
            this._hwPanel.toggleUserHidden();
            this.syncStyle();
        };

        if (shellMajorVersion() >= 50 && this._clickGesture) {
            this.remove_action(this._clickGesture);
            this._clickGesture = new Clutter.ClickGesture();
            this._clickGesture.set_recognize_on_press(true);
            this._clickGesture.set_enabled(true);
            this._clickGesture.connect('recognize', toggle);
            this.add_action(this._clickGesture);
            return;
        }

        this.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            toggle();
            return Clutter.EVENT_STOP;
        });
    }

    syncStyle() {
        this._icon.opacity = this._hwPanel.userHidden ? 120 : 255;
        this.accessible_name = this._hwPanel.userHidden
            ? 'Show hardware monitor panel'
            : 'Hide hardware monitor panel';
    }
});

const STATS_PATH = GLib.build_filenamev([
    GLib.get_user_cache_dir(),
    'hw-monitor-widget',
    'stats.json',
]);
const CONFIG_PATH = GLib.build_filenamev([
    GLib.get_home_dir(),
    '.config',
    'hw-monitor-widget',
    'settings.json',
]);

function readJsonConfig() {
    const defaults = {
        bar_width: 336,
        gap_x: 0,
        gap_y: 0,
        refresh_seconds: 2,
        cpu_title: 'CPU',
        bar_height: 6,
        gpu_titles: ['GPU 0'],
        auto_hide_when_focused: false,
        panel_corner: 'top-right',
        show_nvme_temp: true,
        user_hidden: false,
    };
    try {
        const file = Gio.File.new_for_path(CONFIG_PATH);
        const [, contents] = file.load_contents(null);
        const data = JSON.parse(new TextDecoder().decode(contents));
        return {...defaults, ...data};
    } catch (_e) {
        return defaults;
    }
}

function writeJsonConfigPatch(patch) {
    try {
        const current = readJsonConfig();
        const merged = {...current, ...patch};
        const payload = `${JSON.stringify(merged, null, 2)}\n`;
        const dir = GLib.path_get_dirname(CONFIG_PATH);
        GLib.mkdir_with_parents(dir, 0o755);
        /* ByteArray / file_set_contents is reliable from gnome-shell; Gio replace can fail quietly. */
        GLib.file_set_contents(CONFIG_PATH, payload);
    } catch (_e) {
        /* ignore — menu still updates in-memory */
    }
}

function defaultBarHeight() {
    return Math.max(6, Math.round(3 * (global.uiScale ?? 1)));
}

/** Horizontal padding from `.hw-monitor-widget` (12px + 12px). */
const PANEL_PAD_X = 24;

const TRACK_RGBA = [0.27, 0.27, 0.27, 0.92];
const USAGE_FILL_RGBA = [1.0, 0.0, 0.333, 1.0];
const TEMP_FILL_RGBA = [0.0, 0.949, 1.0, 1.0];

function tempToPercent(temp) {
    const n = Number.parseFloat(String(temp ?? '').replace(/[^0-9.]/g, ''));
    if (Number.isNaN(n))
        return 0;
    return Math.max(0, Math.min(100, n));
}

/** Cairo meter — same technique as net graphs; fill always from x=0 (St CSS widgets center). */
function makeMeterBar(width, fillRgba, styleClass, height) {
    const h = height ?? defaultBarHeight();
    const area = new St.DrawingArea({
        style_class: styleClass,
        can_focus: false,
        reactive: false,
    });
    area._barWidth = width;
    area._barHeight = h;
    area._percent = 0;
    area._fillRgba = fillRgba;
    area.set_size(width, h);
    area.connect('repaint', () => {
        const cr = area.get_context();
        let w = area._barWidth;
        let bh = area._barHeight;
        const [aw, ah] = area.get_size();
        if (aw > 0)
            w = aw;
        if (ah > 0)
            bh = ah;
        const [tr, tg, tb, ta] = TRACK_RGBA;
        cr.setSourceRGBA(tr, tg, tb, ta);
        cr.rectangle(0, 0, w, bh);
        cr.fill();
        const fillW = (w * area._percent) / 100;
        if (fillW >= 0.5) {
            const [fr, fg, fb, fa] = area._fillRgba;
            cr.setSourceRGBA(fr, fg, fb, fa);
            cr.rectangle(0, 0, fillW, bh);
            cr.fill();
        }
    });
    area.queue_repaint();
    return area;
}

function makeUsageBar(width, height) {
    return makeMeterBar(width, USAGE_FILL_RGBA, 'usage-bar', height);
}

function makeTempBar(width, height) {
    return makeMeterBar(width, TEMP_FILL_RGBA, 'temp-bar', height);
}

function setBar(bar, percent) {
    bar._percent = Math.max(0, Math.min(100, percent ?? 0));
    bar.queue_repaint();
}

function formatRate(bps) {
    if (bps >= 1024 * 1024)
        return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
    if (bps >= 1024)
        return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${Math.round(bps)} B/s`;
}

/**
 * Original section rule: a row of `─` in #444 (JetBrains Mono 11px).
 * The string is longer than the panel and clipped to the meter width, so the
 * ink ends on the same edge as the bars. A short fixed string stopped mid-panel.
 */
function makeSectionRule(width) {
    const span = Math.max(40, Math.round(width));
    const label = new St.Label({
        text: '─'.repeat(240),
        style_class: 'rule',
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.line_wrap = false;
    label.clip_to_allocation = true;
    const clip = new St.Widget({
        style_class: 'section-rule',
        clip_to_allocation: true,
        x_expand: true,
        style: `width: ${span}px; min-width: ${span}px; max-width: ${span}px;`,
    });
    clip.add_child(label);
    return clip;
}

function addSection(container, title, width) {
    container.add_child(new St.Label({
        text: title,
        style_class: 'section-title',
        x_expand: true,
    }));
    container.add_child(makeSectionRule(width));
}

function makeMetricRow(labelText) {
    const box = new St.BoxLayout({style_class: 'metric-row', vertical: false});
    const label = new St.Label({
        text: labelText,
        style_class: 'label-muted metric-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const value = new St.Label({
        text: '',
        style_class: 'metric-value',
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
    });
    box.add_child(label);
    box.add_child(value);
    return {box, value};
}

function makeSplitRow(leftLabel, leftValueText, rightText) {
    const box = new St.BoxLayout({style_class: 'metric-row', vertical: false});
    const left = new St.Label({
        text: `${leftLabel}${leftValueText}`,
        style_class: 'label-muted',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const right = new St.Label({
        text: rightText,
        style_class: 'metric-right',
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
    });
    box.add_child(left);
    box.add_child(right);
    return {box, left, right};
}

function rgbaFromHex(hex) {
    const h = hex.replace('#', '');
    return [
        parseInt(h.substring(0, 2), 16) / 255,
        parseInt(h.substring(2, 4), 16) / 255,
        parseInt(h.substring(4, 6), 16) / 255,
        1.0,
    ];
}

function makeSparkGraph(width, height, hexColor) {
    const history = Array.from({length: 60}, () => 0);
    const area = new St.DrawingArea({
        style_class: 'net-graph',
        can_focus: false,
        reactive: false,
    });
    area._graphWidth = width;
    area._graphHeight = height;
    area.set_size(width, height);
    const [r, g, b, a] = rgbaFromHex(hexColor);
    area.clip_to_allocation = true;
    area.connect('repaint', () => {
        const cr = area.get_context();
        let [w, h] = area.get_size();
        if (w < 1)
            w = area._graphWidth;
        if (h < 1)
            h = area._graphHeight;
        cr.save();
        cr.rectangle(0, 0, w, h);
        cr.clip();
        cr.setSourceRGBA(0.27, 0.27, 0.27, 0.35);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        cr.setSourceRGBA(r, g, b, a);
        const baseline = h - 0.5;
        cr.moveTo(0, baseline);
        const max = Math.max(...history, 1);
        const lastIndex = history.length - 1;
        for (let i = 0; i < history.length; i++) {
            const x = lastIndex > 0 ? (i / lastIndex) * (w - 1) : 0;
            const y = h - (history[i] / max) * (h - 2) - 1;
            cr.lineTo(x, y);
        }
        cr.lineTo(w - 0.5, baseline);
        cr.closePath();
        cr.fill();
        cr.restore();
    });
    area.addSample = value => {
        history.shift();
        history.push(Math.max(0, value));
        area.queue_repaint();
    };
    area.queue_repaint();
    return area;
}

class GpuBlock {
    constructor(container, barWidth, barHeight, sectionTitle) {
        addSection(container, sectionTitle, barWidth);

        ({box: this._loadRow, value: this._loadValue} = makeMetricRow('Load:'));
        container.add_child(this._loadRow);
        this._loadBar = makeUsageBar(barWidth, barHeight);
        container.add_child(this._loadBar);

        ({box: this._tempRow, value: this._tempValue} = makeMetricRow('Temp:'));
        container.add_child(this._tempRow);
        this._tempBar = makeTempBar(barWidth, barHeight);
        container.add_child(this._tempBar);

        ({box: this._vramRow, value: this._vramValue} = makeMetricRow('VRAM:'));
        container.add_child(this._vramRow);
        this._vramBar = makeUsageBar(barWidth, barHeight);
        container.add_child(this._vramBar);

        this._fanPowerRow = makeSplitRow('Fan:', '', 'Power:');
        container.add_child(this._fanPowerRow.box);
    }

    update(gpu) {
        if (!gpu) {
            this._loadValue.text = 'N/A';
            setBar(this._loadBar, 0);
            this._tempValue.text = 'N/A';
            setBar(this._tempBar, 0);
            this._vramValue.text = 'N/A';
            setBar(this._vramBar, 0);
            this._fanPowerRow.left.text = 'Fan: N/A';
            this._fanPowerRow.right.text = 'Power: N/A';
            return;
        }
        this._loadValue.text = `${Math.round(gpu.load ?? 0)}%`;
        setBar(this._loadBar, gpu.load ?? 0);
        const t = gpu.temp ?? 'N/A';
        this._tempValue.text = String(t).includes('°') ? `${t}` : `${t}°C`;
        setBar(this._tempBar, tempToPercent(t));
        this._vramValue.text = gpu.vram ?? 'N/A';
        setBar(this._vramBar, gpu.vram_pct ?? 0);
        this._fanPowerRow.left.text = `Fan: ${gpu.fan ?? 'N/A'}%`;
        this._fanPowerRow.right.text = `Power: ${gpu.power ?? 'N/A'} W`;
    }
}

class MountBlock {
    constructor(container, barWidth, barHeight, showNvmeTemp = true) {
        ({box: this._row, value: this._value} = makeMetricRow(''));
        container.add_child(this._row);
        this._usageBar = makeUsageBar(barWidth, barHeight);
        container.add_child(this._usageBar);
        this._showNvmeTemp = showNvmeTemp;
        if (showNvmeTemp) {
            ({box: this._tempRow, value: this._tempValue} = makeMetricRow('NVMe:'));
            container.add_child(this._tempRow);
            this._tempBar = makeTempBar(barWidth, barHeight);
            container.add_child(this._tempBar);
        }
    }

    update(mount, nvmeTemp) {
        const label = mount?.label ?? mount?.path ?? 'Disk';
        this._row.get_children()[0].text = `${label}:`;
        this._value.text = mount?.text ?? 'N/A';
        setBar(this._usageBar, mount?.pct ?? 0);
        if (!this._showNvmeTemp)
            return;
        this._tempValue.text = nvmeTemp ?? 'N/A';
        setBar(this._tempBar, tempToPercent(nvmeTemp));
    }
}

class WidgetPanel {
    constructor() {
        this._cfg = readJsonConfig();
        this._barWidth = this._cfg.bar_width ?? 420;
        this._barHeight = this._cfg.bar_height ?? defaultBarHeight();
        this._userHidden = Boolean(this._cfg.user_hidden);
        this._chromeAdded = false;
        this._syncingVisibility = false;
        this._focusId = null;
        this._workareasId = null;
        this._overviewIds = [];
        this._startupCompleteId = null;
        this._visibleGuardId = null;
        this._positionWarmupIds = [];

        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'hw-monitor-widget',
            reactive: false,
            can_focus: false,
            track_hover: false,
        });
        this._container.set_size(this._barWidth, -1);
        this._buildUi();
        this._visibleGuardId = this._container.connect('notify::visible', () => {
            if (this._syncingVisibility)
                return;
            const shouldShow = !this._userHidden && this._shouldShowForFocus();
            if (this._container.visible !== shouldShow)
                this._syncVisibility();
        });
        this._bindAutoHide();
        this._bindLayoutSignals();
        this._bindOverviewSignals();
        this._syncVisibility();
        this._schedulePositionWarmup();
        const secs = Math.max(1, this._cfg.refresh_seconds ?? 2);
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            secs,
            () => this._refresh(),
        );
        this._refresh();
    }

    get autoHideWhenFocused() {
        return Boolean(this._cfg.auto_hide_when_focused);
    }

    setAutoHideWhenFocused(enabled) {
        this._cfg.auto_hide_when_focused = Boolean(enabled);
        writeJsonConfigPatch({auto_hide_when_focused: this._cfg.auto_hide_when_focused});
        this._bindAutoHide();
        this._syncVisibility();
    }

    get userHidden() {
        return this._userHidden;
    }

    setUserHidden(hidden) {
        this._userHidden = Boolean(hidden);
        this._cfg.user_hidden = this._userHidden;
        writeJsonConfigPatch({user_hidden: this._userHidden});
        this._syncVisibility();
    }

    toggleUserHidden() {
        this.setUserHidden(!this._userHidden);
    }

    _bindAutoHide() {
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = null;
        }
        if (!this._cfg.auto_hide_when_focused)
            return;
        this._focusId = global.display.connect('notify::focus-window', () => this._syncVisibility());
    }

    _shouldShowForFocus() {
        if (!this._cfg.auto_hide_when_focused)
            return true;
        /* No focused client window → empty desktop / overview edge cases */
        return global.display.get_focus_window() === null;
    }

    _syncVisibility() {
        const show = !this._userHidden && this._shouldShowForFocus();
        this._syncingVisibility = true;
        try {
            if (show) {
                if (!this._chromeAdded) {
                    /* trackFullscreen:false — overview must not own show/hide. */
                    Main.layoutManager.addChrome(this._container, {
                        affectsStruts: false,
                        trackFullscreen: false,
                    });
                    this._chromeAdded = true;
                }
                this._container.visible = true;
                this._container.opacity = 255;
                this._position();
            } else {
                this._container.visible = false;
                this._container.opacity = 0;
                /* Remove from chrome so hot-corner/overview cannot restore the panel. */
                if (this._chromeAdded) {
                    Main.layoutManager.removeChrome(this._container);
                    this._chromeAdded = false;
                }
            }
        } finally {
            this._syncingVisibility = false;
        }
    }

    _buildUi() {
        const cpuTitle = this._cfg.cpu_title ?? 'CPU';
        const gpuTitles = this._cfg.gpu_titles ?? ['GPU 0'];

        addSection(this._container, cpuTitle, this._barWidth);
        ({box: this._cpuLoadRow, value: this._cpuLoadValue} = makeMetricRow('Load:'));
        this._container.add_child(this._cpuLoadRow);
        this._cpuBar = makeUsageBar(this._barWidth, this._barHeight);
        this._container.add_child(this._cpuBar);

        ({box: this._cpuTempRow, value: this._cpuTempValue} = makeMetricRow('Temp:'));
        this._container.add_child(this._cpuTempRow);
        this._cpuTempBar = makeTempBar(this._barWidth, this._barHeight);
        this._container.add_child(this._cpuTempBar);

        ({box: this._ramRow, value: this._ramValue} = makeMetricRow('RAM:'));
        this._container.add_child(this._ramRow);
        this._memBar = makeUsageBar(this._barWidth, this._barHeight);
        this._container.add_child(this._memBar);

        ({box: this._cpuFreqRow, value: this._cpuFreqValue} = makeMetricRow('Freq:'));
        this._container.add_child(this._cpuFreqRow);

        this._gpuBlocks = gpuTitles.map(
            title => new GpuBlock(this._container, this._barWidth, this._barHeight, title),
        );

        addSection(this._container, 'Storage', this._barWidth);
        const showNvmeTemp = this._cfg.show_nvme_temp !== false;
        this._mountBlocks = [
            new MountBlock(this._container, this._barWidth, this._barHeight, showNvmeTemp),
            new MountBlock(this._container, this._barWidth, this._barHeight, showNvmeTemp),
            new MountBlock(this._container, this._barWidth, this._barHeight, showNvmeTemp),
        ];

        addSection(this._container, 'IO & NET', this._barWidth);
        this._netSpeedRow = makeSplitRow('Down:', '', 'Up:');
        this._container.add_child(this._netSpeedRow.box);

        const graphGap = 8;
        const graphH = 35;
        const contentW = Math.max(80, this._barWidth - PANEL_PAD_X);
        const graphW = Math.max(40, Math.floor((contentW - graphGap) / 2));
        this._downGraph = makeSparkGraph(graphW, graphH, '#00f2ff');
        this._upGraph = makeSparkGraph(graphW, graphH, '#ff0055');
        const graphs = new St.BoxLayout({
            style_class: 'net-graphs',
            vertical: false,
            x_expand: false,
            x_align: Clutter.ActorAlign.START,
        });
        graphs.clip_to_allocation = true;
        graphs.set_size(contentW, graphH);
        graphs.add_child(this._downGraph);
        graphs.add_child(this._upGraph);
        this._container.add_child(graphs);
    }

    _bindLayoutSignals() {
        this._monitorChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => this._reloadLayout(),
        );
        this._workareasId = global.display.connect(
            'workareas-changed',
            () => {
                this._position();
                this._syncVisibility();
            },
        );
    }

    /**
     * Overview / hot-corner can stomp chrome visibility; keep user hide choice.
     * Hidden panels are removed from chrome entirely in _syncVisibility.
     */
    _bindOverviewSignals() {
        const resync = () => {
            this._syncVisibility();
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._syncVisibility();
                return GLib.SOURCE_REMOVE;
            });
            this._positionWarmupIds.push(
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    this._syncVisibility();
                    return GLib.SOURCE_REMOVE;
                }),
            );
        };
        for (const name of ['showing', 'hiding', 'hidden', 'shown']) {
            try {
                this._overviewIds.push(Main.overview.connect(name, resync));
            } catch (_e) {
                /* signal may not exist on all shell versions */
            }
        }
        try {
            this._startupCompleteId = Main.layoutManager.connect(
                'startup-complete',
                resync,
            );
        } catch (_e) {
            this._startupCompleteId = null;
        }
    }

    _schedulePositionWarmup() {
        this._clearPositionWarmup();
        const run = () => {
            this._position();
            this._syncVisibility();
            return GLib.SOURCE_REMOVE;
        };
        this._positionWarmupIds.push(
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, run),
        );
        for (const ms of [50, 150, 400, 800, 1500, 3000]) {
            this._positionWarmupIds.push(
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, run),
            );
        }
    }

    _clearPositionWarmup() {
        for (const id of this._positionWarmupIds) {
            if (id)
                GLib.source_remove(id);
        }
        this._positionWarmupIds = [];
    }

    _reloadLayout() {
        this._cfg = {...this._cfg, ...readJsonConfig()};
        this._userHidden = Boolean(this._cfg.user_hidden);
        this._position();
        this._schedulePositionWarmup();
        this._syncVisibility();
    }

    _position() {
        const monitor = Main.layoutManager.primaryMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const gapX = this._cfg.gap_x ?? 0;
        const gapY = this._cfg.gap_y ?? 0;
        const corner = String(this._cfg.panel_corner ?? 'top-right').toLowerCase();
        const x = corner === 'top-right'
            ? workArea.x + workArea.width - this._barWidth - gapX
            : workArea.x + gapX;
        this._container.set_position(x, workArea.y + gapY);
    }

    _readStats() {
        try {
            const file = Gio.File.new_for_path(STATS_PATH);
            const [, contents] = file.load_contents(null);
            return JSON.parse(new TextDecoder().decode(contents));
        } catch (_e) {
            return null;
        }
    }

    _refresh() {
        const data = this._readStats();
        if (!data) {
            this._cpuLoadValue.text = '…';
            return GLib.SOURCE_CONTINUE;
        }

        this._cpuLoadValue.text = `${Math.round(data.cpu_pct ?? 0)}%`;
        setBar(this._cpuBar, data.cpu_pct ?? 0);
        this._ramValue.text = data.mem_text ?? 'N/A';
        setBar(this._memBar, data.mem_pct ?? 0);

        const temp = data.cpu_temp ?? 'N/A';
        const hot = Number.parseFloat(String(temp).replace(/[^0-9.]/g, '')) > 80;
        this._cpuTempValue.text = `${temp}`;
        this._cpuTempValue.style_class = hot ? 'metric-value label-warn' : 'metric-value';
        setBar(this._cpuTempBar, tempToPercent(temp));
        this._cpuFreqValue.text = data.cpu_freq ?? 'N/A';

        const gpus = data.gpus ?? [];
        for (let i = 0; i < this._gpuBlocks.length; i++)
            this._gpuBlocks[i].update(gpus[i]);

        const mounts = data.mounts ?? [];
        const nvme = data.nvme_temp ?? 'N/A';
        for (let i = 0; i < this._mountBlocks.length; i++)
            this._mountBlocks[i].update(mounts[i], nvme);
        const down = data.net_down_bps ?? 0;
        const up = data.net_up_bps ?? 0;
        this._netSpeedRow.left.text = `Down: ${formatRate(down)}`;
        this._netSpeedRow.right.text = `Up: ${formatRate(up)}`;
        this._downGraph.addSample(down);
        this._upGraph.addSample(up);

        return GLib.SOURCE_CONTINUE;
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = null;
        }
        this._clearPositionWarmup();
        if (this._workareasId) {
            global.display.disconnect(this._workareasId);
            this._workareasId = null;
        }
        if (this._monitorChangedId) {
            Main.layoutManager.disconnect(this._monitorChangedId);
            this._monitorChangedId = null;
        }
        if (this._startupCompleteId) {
            Main.layoutManager.disconnect(this._startupCompleteId);
            this._startupCompleteId = null;
        }
        for (const id of this._overviewIds)
            Main.overview.disconnect(id);
        this._overviewIds = [];
        if (this._visibleGuardId) {
            this._container.disconnect(this._visibleGuardId);
            this._visibleGuardId = null;
        }
        if (this._chromeAdded) {
            Main.layoutManager.removeChrome(this._container);
            this._chromeAdded = false;
        }
        this._container.destroy();
    }
}

export default class HwMonitorWidgetExtension extends Extension {
    enable() {
        this._panel = new WidgetPanel();
        this._toggle = new HwMonitorToggleButton(this._panel);
        Main.panel.addToStatusArea(this.uuid, this._toggle);
    }

    disable() {
        this._toggle?.destroy();
        this._toggle = null;
        this._panel?.destroy();
        this._panel = null;
    }
}
