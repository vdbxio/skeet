// SPDX-License-Identifier: MIT
// Skeet: a draggable, always-on-top dictation button (a dancing parrot).
//
// It lives in the Shell's top chrome rather than in an app window, so it
// floats above everything and tapping it never takes keyboard focus away
// from the text field the words are typed into.
//
//   tap  -> start / stop dictation
//   drag -> move it; on release it snaps to the nearest side edge
//
// The speech recognition runs in skeetd.py, a background service on the
// session bus (io.github.vdbxio.Skeet) that keeps Parakeet loaded, records,
// and types the final text with ydotool. This button only asks it to toggle
// and mirrors its state, so the `skeet --toggle` shortcut works too:
// red ring while recording, amber while the last words are being transcribed.
// While recording, a caption bubble beside the button shows what it has
// heard so far. After text is typed, Delete (above) and Enter (below) buttons
// appear for a few seconds: Delete backspaces over exactly that text.
//
// Everything here runs on the compositor's main loop, so nothing may block:
// D-Bus calls and file I/O are async (apart from listing the small icon
// folder once at startup), and every input handler is wrapped so
// an exception can never leave the button stuck mid-press.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const ACTION_SCALE = 0.75; // Delete/Enter buttons relative to the mic
const ACTION_GAP = 10;
const DANCE_MS = 60;
const PARROT_SCALE = 1.0; // frame size relative to the button
const EDGE_MARGIN = 10;
const DRAG_THRESHOLD = 14;
const TAP_DEBOUNCE_MS = 300;
const SAFETY_RESET_S = 330; // the service gives up recording at 300 s

const BUBBLE_GAP = 12;
const BUBBLE_MAX_WIDTH = 440;
const BUBBLE_LINES = 3;
const BUBBLE_LINGER_MS = 1500;

const POS_FILE = GLib.build_filenamev([
    GLib.get_user_config_dir(), 'skeet.json']);

const BUS_NAME = 'io.github.vdbxio.Skeet';
const OBJ_PATH = '/io/github/vdbxio/Skeet';

const T = Clutter.EventType;

// Identify which finger (or the mouse) an event belongs to. Clutter hands
// GJS a fresh wrapper object for the event sequence on every event, so the
// sequences themselves can't be compared with ===; compare the slot instead.
function pointerKey(ev) {
    const seq = ev.get_event_sequence();
    if (!seq)
        return 'pointer';
    try {
        return `touch:${seq.get_slot()}`;
    } catch {
        return 'touch';
    }
}

export default class SkeetExtension extends Extension {
    enable() {
        this._state = 'idle';
        this._press = null;
        this._lastTap = 0;
        this._timeouts = new Set();
        this._cancellable = new Gio.Cancellable();
        this._signalIds = [];
        this._watchId = 0;
        this._safetyId = 0;
        this._bubbleHideId = 0;
        this._actionsHideId = 0;
        this._settings = this.getSettings();
        this._size = this._settings.get_int('button-size');

        this._frames = this._loadFrames();
        this._frameCenter = this._measureFrames();
        this._frame = 0;
        this._danceId = 0;
        // The parrot is the button's background image, so St clips it to the
        // circle and draws the ring on top of it. Without frames, a mic icon.
        this._icon = this._frames.length ? null : new St.Icon({
            icon_name: 'audio-input-microphone-symbolic',
            style_class: 'skeet-icon',
        });
        this._button = new St.Bin({
            style_class: 'skeet',
            reactive: true,
            track_hover: true,
            can_focus: false,
            child: this._icon,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._button.set_pivot_point(0.5, 0.5);

        // GNOME 50 chrome params are only trackFullscreen/affectsStruts;
        // anything else throws.
        Main.layoutManager.addTopChrome(this._button, {trackFullscreen: false});

        this._button.connect('event', (_a, ev) => this._onEvent(ev));

        this._deleteButton = this._makeActionButton('edit-clear-symbolic',
            () => this._call('DeleteLast'));
        this._enterButton = this._makeActionButton('osk-enter-symbolic',
            () => this._call('PressEnter'));
        this._applySize();

        // Anything that suggests the typed text is no longer "just typed"
        // hides Delete/Enter, so Delete can't eat the wrong characters.
        const hide = () => this._hideActions();
        this._handlers = [
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => {
                hide();
                this._placeInBounds(false);
            })],
            [global.display, global.display.connect('notify::focus-window', hide)],
            [global.workspace_manager,
                global.workspace_manager.connect('active-workspace-changed', hide)],
            [Main.overview, Main.overview.connect('showing', hide)],
            [this._settings, this._settings.connect('changed::button-size', () => {
                this._size = this._settings.get_int('button-size');
                this._applySize();
                this._placeInBounds(false);
            })],
            [this._settings, this._settings.connect('changed::icon-offset',
                () => this._paintButton())],
            [this._settings, this._settings.connect('changed::live-captions', () => {
                if (!this._settings.get_boolean('live-captions'))
                    this._bubble?.hide();
            })],
        ];

        this._buildBubble();
        this._restorePosition();
        this._watchService();
    }

    disable() {
        this._cancellable.cancel();
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        this._safetyId = 0;
        this._bubbleHideId = 0;
        this._actionsHideId = 0;

        for (const [obj, id] of this._handlers ?? [])
            obj.disconnect(id);
        this._handlers = [];
        for (const id of this._signalIds ?? [])
            Gio.DBus.session.signal_unsubscribe(id);
        this._signalIds = [];
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }
        if (this._bubble) {
            this._bubble.destroy();
            this._bubble = null;
            this._bubbleLabel = null;
        }
        for (const b of [this._deleteButton, this._enterButton]) {
            if (b) {
                Main.layoutManager.removeChrome(b);
                b.destroy();
            }
        }
        this._deleteButton = this._enterButton = null;
        this._settings = null;
        if (this._button) {
            Main.layoutManager.removeChrome(this._button);
            this._button.destroy();
            this._button = null;
        }
        this._icon = null;
        this._press = null;
    }

    // ---- input ---------------------------------------------------------

    _onEvent(ev) {
        try {
            switch (ev.type()) {
            case T.BUTTON_PRESS:
                if (ev.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;
                // fall through
            case T.TOUCH_BEGIN:
                return this._onBegin(ev);
            case T.MOTION:
            case T.TOUCH_UPDATE:
                return this._onMove(ev);
            case T.BUTTON_RELEASE:
            case T.TOUCH_END:
                return this._onEnd(ev);
            case T.TOUCH_CANCEL:
                if (this._press?.key === pointerKey(ev))
                    this._endPress();
                return Clutter.EVENT_STOP;
            }
        } catch (e) {
            console.error(`skeet: input handler failed: ${e.message}\n${e.stack}`);
            this._endPress();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onBegin(ev) {
        const key = pointerKey(ev);
        // A second finger while one is already down: ignore it.
        if (this._press && this._press.key !== key && key !== 'pointer' &&
            this._press.key !== 'pointer')
            return Clutter.EVENT_STOP;
        // Otherwise a new press always wins over a stale one, so a lost
        // release can never lock the button.
        if (this._press)
            this._endPress();

        const [x, y] = ev.get_coords();
        this._press = {
            key,
            startX: x,
            startY: y,
            offX: x - this._button.x,
            offY: y - this._button.y,
            dragging: false,
        };
        this._button.add_style_class_name('pressed');
        this._button.ease({scale_x: 0.92, scale_y: 0.92, duration: 80,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        return Clutter.EVENT_STOP;
    }

    _onMove(ev) {
        const p = this._press;
        if (!p || p.key !== pointerKey(ev))
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = ev.get_coords();
        if (!p.dragging &&
            Math.hypot(x - p.startX, y - p.startY) > DRAG_THRESHOLD) {
            p.dragging = true;
            this._hideActions();
            this._button.remove_all_transitions();
            this._button.set_scale(1, 1);
        }
        if (p.dragging) {
            const [cx, cy] = this._clamp(x - p.offX, y - p.offY);
            this._button.set_position(cx, cy);
            this._placeBubble(cx, cy);
        }
        return Clutter.EVENT_STOP;
    }

    _onEnd(ev) {
        const p = this._press;
        if (!p || p.key !== pointerKey(ev))
            return Clutter.EVENT_PROPAGATE;

        this._endPress();
        if (p.dragging) {
            this._placeInBounds(true);
            this._savePosition();
        } else {
            this._tap();
        }
        return Clutter.EVENT_STOP;
    }

    _endPress() {
        this._press = null;
        if (!this._button)
            return;
        this._button.remove_style_class_name('pressed');
        this._button.ease({scale_x: 1, scale_y: 1, duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // ---- actions -------------------------------------------------------

    _tap() {
        // Swallow accidental double-taps so one touch can't start and
        // immediately stop a recording.
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastTap < TAP_DEBOUNCE_MS)
            return;
        this._lastTap = now;

        if (this._state === 'transcribing')
            return; // the text is about to be typed
        const was = this._state;
        // Show the change right away; the service confirms it in a moment.
        this._applyState(was === 'idle' ? 'recording' : 'transcribing');
        this._call('Toggle', () => this._applyState(was));
    }

    _call(method, onError) {
        Gio.DBus.session.call(BUS_NAME, OBJ_PATH, BUS_NAME, method, null, null,
            Gio.DBusCallFlags.NONE, 5000, this._cancellable, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    console.error(`skeet: ${method} failed: ${e.message}`);
                    onError?.();
                    if (e.matches?.(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN)) {
                        // Never set up (or uninstalled): take them to Setup.
                        Main.notify('Skeet',
                            'The speech engine isn’t set up yet. Opening Skeet settings…');
                        this.openPreferences();
                    } else {
                        Main.notify('Skeet', 'The dictation service is not responding.');
                    }
                }
            });
    }

    // ---- service state -------------------------------------------------

    _watchService() {
        const sub = (signal, fn) => Gio.DBus.session.signal_subscribe(
            BUS_NAME, BUS_NAME, signal, OBJ_PATH, null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, params) => {
                try {
                    fn(params.deepUnpack()[0]);
                } catch (e) {
                    console.error(`skeet: ${signal} handler failed: ${e.message}`);
                }
            });
        this._signalIds = [
            sub('StateChanged', state => this._applyState(state)),
            sub('Caption', text => {
                if (this._state !== 'idle' && text)
                    this._showBubble(text, false);
            }),
            sub('Typed', text => {
                if (text && this._settings.get_boolean('action-buttons'))
                    this._showActions();
            }),
            sub('Error', message => Main.notify('Skeet', message)),
            sub('NeedsModel', () => {
                this._applyState('idle');
                Main.notify('Skeet', 'Download a speech model first. Opening Skeet settings…');
                this.openPreferences();
            }),
        ];
        // Pick up the current state whenever the service (re)appears; drop
        // back to idle if it goes away mid-recording.
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._fetchState(),
            () => this._applyState('idle'));
    }

    _fetchState() {
        Gio.DBus.session.call(BUS_NAME, OBJ_PATH, 'org.freedesktop.DBus.Properties',
            'Get', new GLib.Variant('(ss)', [BUS_NAME, 'State']), null,
            Gio.DBusCallFlags.NONE, 5000, this._cancellable, (conn, res) => {
                try {
                    const [v] = conn.call_finish(res).deepUnpack();
                    this._applyState(v.deepUnpack());
                } catch {}
            });
    }

    _applyState(state) {
        const was = this._state;
        this._state = state;
        if (!this._button)
            return;
        this._button.remove_style_class_name('recording');
        this._button.remove_style_class_name('transcribing');
        if (state !== 'idle')
            this._button.add_style_class_name(state);

        if (state !== 'idle')
            this._hideActions();
        this._dance(state === 'recording');
        if (state === 'recording' && was === 'idle') {
            this._removeTimeout(this._bubbleHideId);
            this._bubbleHideId = 0;
            this._showBubble('listening…', true);
        } else if (state === 'idle' && was !== 'idle') {
            this._hideBubbleSoon();
        }

        // Safety net in case we ever miss the way back to idle.
        this._removeTimeout(this._safetyId);
        this._safetyId = 0;
        if (state !== 'idle') {
            this._safetyId = this._addTimeout(SAFETY_RESET_S * 1000, () => {
                this._safetyId = 0;
                this._applyState('idle');
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // ---- position ------------------------------------------------------

    _monitorFor(x, y) {
        const monitors = Main.layoutManager.monitors;
        const cx = x + this._size / 2, cy = y + this._size / 2;
        return monitors.find(m =>
            cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) ??
            Main.layoutManager.primaryMonitor;
    }

    _clamp(x, y) {
        const m = this._monitorFor(x, y);
        return [
            Math.min(Math.max(x, m.x + EDGE_MARGIN), m.x + m.width - this._size - EDGE_MARGIN),
            Math.min(Math.max(y, m.y + EDGE_MARGIN), m.y + m.height - this._size - EDGE_MARGIN),
        ];
    }

    // Where the button belongs: on screen, snapped to the nearer left/right edge.
    _snapTarget() {
        const [x, y] = this._clamp(this._button.x, this._button.y);
        const m = this._monitorFor(x, y);
        const nx = (x + this._size / 2 < m.x + m.width / 2)
            ? m.x + EDGE_MARGIN : m.x + m.width - this._size - EDGE_MARGIN;
        return [nx, y];
    }

    _placeInBounds(animate) {
        if (!this._button)
            return;
        const [x, y] = this._snapTarget();
        this._placeActions(x, y);
        if (animate) {
            this._button.ease({x, y, duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            this._button.set_position(x, y);
        }
        this._placeBubble(x, y);
    }

    _restorePosition() {
        const m = Main.layoutManager.primaryMonitor;
        this._button.set_position(m.x + m.width - this._size - EDGE_MARGIN,
            m.y + Math.round(m.height * 0.6));
        this._placeInBounds(false);

        Gio.File.new_for_path(POS_FILE).load_contents_async(this._cancellable, (f, res) => {
            try {
                const [, contents] = f.load_contents_finish(res);
                const pos = JSON.parse(new TextDecoder().decode(contents));
                if (this._button && !this._press &&
                    Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
                    this._button.set_position(pos.x, pos.y);
                    this._placeInBounds(false);
                }
            } catch {
                // first run, or disabled meanwhile: keep the default spot
            }
        });
    }

    _savePosition() {
        // Save where the snap animation ends, not the mid-drag spot.
        const [x, y] = this._snapTarget();
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify({x, y})));
        Gio.File.new_for_path(POS_FILE).replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                } catch (e) {
                    console.warn(`skeet: could not save position: ${e.message}`);
                }
            });
    }

    // ---- the parrot ----------------------------------------------------

    // Frames of the button icon, in order. A folder of images in
    // ~/.local/share/skeet/icon/ (any names, sorted) replaces the bundled
    // parrot, so anyone can use their own emote.
    _loadFrames() {
        const dirs = [
            GLib.build_filenamev([GLib.get_user_data_dir(), 'skeet', 'icon']),
            GLib.build_filenamev([this.path, 'icons']),
        ];
        for (const dir of dirs) {
            const names = [];
            try {
                const en = Gio.File.new_for_path(dir).enumerate_children(
                    'standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = en.next_file(null)))
                    names.push(info.get_name());
                en.close(null);
            } catch {
                continue;
            }
            const frames = names.filter(n => /\.(png|svg)$/i.test(n)).sort()
                .map(n => Gio.File.new_for_path(`${dir}/${n}`).get_uri());
            if (frames.length)
                return frames;
        }
        return [];
    }

    // Where the drawing sits inside its frames: the centre of the box around
    // every non-transparent pixel of all frames, as fractions of the frame.
    // Frames often have uneven padding (the Party Parrot sits low), so this
    // is what gets centred in the circle, not the frame itself.
    _measureFrames() {
        let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
        for (const uri of this._frames) {
            try {
                const p = GdkPixbuf.Pixbuf.new_from_file(Gio.File.new_for_uri(uri).get_path());
                if (!p.get_has_alpha())
                    continue;
                const w = p.get_width(), h = p.get_height();
                const n = p.get_n_channels(), rs = p.get_rowstride();
                const px = p.get_pixels();
                for (let y = 0; y < h; y += 2) {
                    for (let x = 0; x < w; x += 2) {
                        if (px[y * rs + x * n + 3] > 40) {
                            x0 = Math.min(x0, x / w);
                            x1 = Math.max(x1, x / w);
                            y0 = Math.min(y0, y / h);
                            y1 = Math.max(y1, y / h);
                        }
                    }
                }
            } catch (e) {
                console.warn(`skeet: could not measure ${uri}: ${e.message}`);
            }
        }
        return x1 > x0 ? [(x0 + x1) / 2, (y0 + y1) / 2] : [0.5, 0.5];
    }

    // Paint the current frame filling the circle with the drawing centred
    // in it (plus the icon-offset setting, for fine-tuning by eye).
    _paintButton() {
        const big = this._size;
        let style = `border-radius: ${big / 2}px;`;
        if (this._frames.length) {
            const img = Math.round(big * PARROT_SCALE);
            const [cx, cy] = this._frameCenter;
            const nudge = this._settings.get_int('icon-offset') / 100;
            const x = Math.round((big - img) / 2 + (0.5 - cx) * img);
            const y = Math.round((big - img) / 2 + (0.5 - cy) * img + nudge * big);
            style += ` background-image: url("${this._frames[this._frame]}");` +
                ` background-size: ${img}px ${img}px;` +
                ` background-position: ${x}px ${y}px; background-repeat: no-repeat;`;
        }
        this._button.set_style(style);
    }

    // Static while idle, dancing while recording.
    _dance(on) {
        if (on && !this._danceId && this._frames.length > 1) {
            this._danceId = this._addTimeout(DANCE_MS, () => {
                this._frame = (this._frame + 1) % this._frames.length;
                this._paintButton();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on && this._danceId) {
            this._removeTimeout(this._danceId);
            this._danceId = 0;
            this._frame = 0;
            this._paintButton();
        }
    }

    // ---- size ----------------------------------------------------------

    _applySize() {
        const big = this._size, small = Math.round(big * ACTION_SCALE);
        this._button.set_size(big, big);
        this._paintButton();
        if (this._icon)
            this._icon.icon_size = Math.round(big * 0.47);
        for (const b of [this._deleteButton, this._enterButton]) {
            b.set_size(small, small);
            b.set_style(`border-radius: ${small / 2}px;`);
            b.child.icon_size = Math.round(small * 0.47);
        }
    }

    // ---- Delete / Enter ------------------------------------------------

    _makeActionButton(iconName, action) {
        const b = new St.Bin({
            style_class: 'skeet skeet-action',
            reactive: true,
            can_focus: false,
            visible: false,
            child: new St.Icon({icon_name: iconName, style_class: 'skeet-icon'}),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        b.set_pivot_point(0.5, 0.5);
        Main.layoutManager.addTopChrome(b, {trackFullscreen: false});

        // Same press tracking as the mic, minus dragging: act on release.
        let pressKey = null;
        const release = () => {
            pressKey = null;
            b.remove_style_class_name('pressed');
            b.ease({scale_x: 1, scale_y: 1, duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        };
        b.connect('event', (_a, ev) => {
            try {
                switch (ev.type()) {
                case T.BUTTON_PRESS:
                    if (ev.get_button() !== Clutter.BUTTON_PRIMARY)
                        return Clutter.EVENT_PROPAGATE;
                    // fall through
                case T.TOUCH_BEGIN:
                    pressKey = pointerKey(ev);
                    b.add_style_class_name('pressed');
                    b.ease({scale_x: 0.9, scale_y: 0.9, duration: 80,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                    return Clutter.EVENT_STOP;
                case T.BUTTON_RELEASE:
                case T.TOUCH_END:
                    if (pressKey === null || pressKey !== pointerKey(ev))
                        return Clutter.EVENT_PROPAGATE;
                    release();
                    this._hideActions();
                    action();
                    return Clutter.EVENT_STOP;
                case T.TOUCH_CANCEL:
                    release();
                    return Clutter.EVENT_STOP;
                }
            } catch (e) {
                console.error(`skeet: action button failed: ${e.message}`);
                release();
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return b;
    }

    _showActions() {
        if (!this._deleteButton || this._press)
            return;
        this._placeActions(this._button.x, this._button.y);
        for (const b of [this._deleteButton, this._enterButton]) {
            b.remove_all_transitions();
            b.opacity = 0;
            b.show();
            b.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._removeTimeout(this._actionsHideId);
        this._actionsHideId = this._addTimeout(
            this._settings.get_int('action-buttons-timeout') * 1000, () => {
                this._actionsHideId = 0;
                this._hideActions();
                return GLib.SOURCE_REMOVE;
            });
    }

    _hideActions() {
        this._removeTimeout(this._actionsHideId);
        this._actionsHideId = 0;
        for (const b of [this._deleteButton, this._enterButton]) {
            if (b?.visible) {
                b.remove_all_transitions();
                b.hide();
            }
        }
    }

    // Delete above the mic and Enter below it; if the mic is too close to
    // the top or bottom edge, both go on the side that has room, in the same
    // order (Delete always above Enter).
    _placeActions(bx, by) {
        if (!this._deleteButton)
            return;
        const m = this._monitorFor(bx, by);
        const big = this._size, small = Math.round(big * ACTION_SCALE);
        const x = Math.round(bx + (big - small) / 2);
        const top = m.y + EDGE_MARGIN, bottom = m.y + m.height - EDGE_MARGIN;
        let del = by - ACTION_GAP - small;
        let ent = by + big + ACTION_GAP;
        if (del < top) {
            del = by + big + ACTION_GAP;
            ent = del + small + ACTION_GAP;
        } else if (ent + small > bottom) {
            ent = by - ACTION_GAP - small;
            del = ent - ACTION_GAP - small;
        }
        this._deleteButton.set_position(x, Math.round(del));
        this._enterButton.set_position(x, Math.round(ent));
    }

    // ---- live caption --------------------------------------------------

    _buildBubble() {
        this._bubbleLabel = new St.Label({style_class: 'skeet-caption-text'});
        const ct = this._bubbleLabel.clutter_text;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.ellipsize = Pango.EllipsizeMode.NONE;

        // Not chrome and not reactive: it never takes input or shifts
        // windows, touches go straight through to whatever is below.
        this._bubble = new St.Bin({
            style_class: 'skeet-caption',
            reactive: false,
            can_focus: false,
            child: this._bubbleLabel,
            visible: false,
            opacity: 0,
        });
        Main.layoutManager.uiGroup.add_child(this._bubble);
    }

    _hideBubbleSoon() {
        if (!this._bubble?.visible || this._bubbleHideId)
            return;
        this._bubbleHideId = this._addTimeout(BUBBLE_LINGER_MS, () => {
            this._bubbleHideId = 0;
            this._bubble?.ease({opacity: 0, duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    if (this._bubble && this._state === 'idle')
                        this._bubble.hide();
                }});
            return GLib.SOURCE_REMOVE;
        });
    }

    _showBubble(text, placeholder) {
        if (!this._bubble || !this._settings.get_boolean('live-captions'))
            return;
        const m = this._monitorFor(this._button.x, this._button.y);
        const maxWidth = Math.min(BUBBLE_MAX_WIDTH,
            m.width - this._size - BUBBLE_GAP - 2 * EDGE_MARGIN);
        if (placeholder)
            this._bubble.add_style_class_name('placeholder');
        else
            this._bubble.remove_style_class_name('placeholder');

        // Keep only the newest words that fit in BUBBLE_LINES lines,
        // measured with the label's own (styled) text actor.
        const label = this._bubbleLabel;
        const ct = label.clutter_text;
        label.ensure_style();
        ct.text = 'Xg';
        const [, lineH] = ct.get_preferred_height(-1);
        const maxH = lineH * (BUBBLE_LINES + 0.5);
        let words = text.split(/\s+/);
        ct.text = text;
        while (words.length > 1 && ct.get_preferred_height(maxWidth)[1] > maxH) {
            words = words.slice(Math.max(1, Math.floor(words.length / 8)));
            ct.text = `…${words.join(' ')}`;
        }
        const [, natW] = ct.get_preferred_width(-1);
        label.set_width(Math.min(maxWidth, Math.ceil(natW) + 1));

        const parent = this._bubble.get_parent();
        parent?.set_child_above_sibling(this._bubble, null);
        if (!this._bubble.visible || this._bubble.opacity < 255) {
            this._bubble.remove_all_transitions();
            this._bubble.show();
            this._bubble.ease({opacity: 255, duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._placeBubble(this._button.x, this._button.y);
    }

    // Beside the button, on the side away from the edge it is snapped to.
    _placeBubble(bx, by) {
        if (!this._bubble?.visible)
            return;
        const m = this._monitorFor(bx, by);
        const [, natW] = this._bubble.get_preferred_width(-1);
        const [, natH] = this._bubble.get_preferred_height(natW);
        const onLeftHalf = bx + this._size / 2 < m.x + m.width / 2;
        let x = onLeftHalf ? bx + this._size + BUBBLE_GAP : bx - BUBBLE_GAP - natW;
        x = Math.min(Math.max(x, m.x + EDGE_MARGIN), m.x + m.width - natW - EDGE_MARGIN);
        let y = by + this._size / 2 - natH / 2;
        y = Math.min(Math.max(y, m.y + EDGE_MARGIN), m.y + m.height - natH - EDGE_MARGIN);
        this._bubble.set_position(Math.round(x), Math.round(y));
    }

    _addTimeout(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            let again = GLib.SOURCE_REMOVE;
            try {
                again = fn();
            } catch (e) {
                console.error(`skeet: timer failed: ${e.message}`);
            }
            if (again !== GLib.SOURCE_CONTINUE)
                this._timeouts.delete(id);
            return again;
        });
        this._timeouts.add(id);
        return id;
    }

    _removeTimeout(id) {
        if (id && this._timeouts.delete(id))
            GLib.source_remove(id);
    }
}
