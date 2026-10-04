// SPDX-License-Identifier: MIT
// Skeet preferences: speech engine, models, noise filter, button.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BUS_NAME = 'io.github.vdbxio.Skeet';
const OBJ_PATH = '/io/github/vdbxio/Skeet';
const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'skeet']);

const FILTERS = [
    ['off', 'Off'],
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
];

function exists(...parts) {
    return GLib.file_test(GLib.build_filenamev(parts), GLib.FileTest.EXISTS);
}

function megabytes(bytes) {
    return `${Math.round(bytes / 1e6)} MB`;
}

// Run a helper, calling onLine for each line of output and onExit(ok) at
// the end. Returns the Gio.Subprocess (or null if it couldn't start).
function run(argv, onLine, onExit) {
    let proc;
    try {
        proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    } catch (e) {
        onLine(`ERROR: ${e.message}`);
        onExit(false);
        return null;
    }
    // Report the exit only once every line has been read, too.
    let pending = 2;
    const settle = () => {
        if (--pending === 0)
            onExit(proc.get_successful());
    };
    const out = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
    const next = () => out.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
        let line = null;
        try {
            [line] = s.read_line_finish_utf8(res);
        } catch {}
        if (line === null) {
            settle();
            return;
        }
        onLine(line);
        next();
    });
    next();
    proc.wait_async(null, (p, res) => {
        try {
            p.wait_finish(res);
        } catch {}
        settle();
    });
    return proc;
}

function reloadService() {
    Gio.DBus.session.call(BUS_NAME, OBJ_PATH, BUS_NAME, 'Reload', null, null,
        Gio.DBusCallFlags.NO_AUTO_START, 5000, null, (c, res) => {
            try {
                c.call_finish(res);
            } catch {} // not running yet: it loads the model when it starts
        });
}

export default class SkeetPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive with the window
        window.set_default_size(660, 780);
        const helper = name => GLib.build_filenamev([this.path, 'helper', name]);
        const running = new Set(); // downloads to cancel if the window closes
        window.connect('close-request', () => {
            for (const p of running)
                p.send_signal(15);
            return false;
        });

        const page = new Adw.PreferencesPage();
        window.add(page);

        // ---- speech engine ----
        const engine = new Adw.PreferencesGroup({
            title: 'Speech engine',
            description: 'Speech recognition runs offline on this computer. Setup ' +
                'installs the engine (Python + sherpa-onnx) in ~/.local/share/skeet ' +
                'and a small background service. It does not download a speech ' +
                'model; choose one below.',
        });
        page.add(engine);

        const statusRow = new Adw.ActionRow({title: 'Engine'});
        const setupButton = new Gtk.Button({label: 'Set up', valign: Gtk.Align.CENTER});
        const setupSpinner = new Adw.Spinner({visible: false, valign: Gtk.Align.CENTER});
        statusRow.add_suffix(setupSpinner);
        statusRow.add_suffix(setupButton);
        engine.add(statusRow);

        const logBuffer = new Gtk.TextBuffer();
        const logView = new Gtk.TextView({
            buffer: logBuffer, editable: false, cursor_visible: false, monospace: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR, top_margin: 8, bottom_margin: 8,
            left_margin: 8, right_margin: 8,
        });
        const logFrame = new Gtk.ScrolledWindow({
            child: logView, min_content_height: 120, visible: false, margin_top: 12,
        });
        logFrame.add_css_class('card');
        engine.add(logFrame);

        const engineReady = () =>
            exists(DATA_DIR, 'venv', 'bin', 'python') &&
            exists(GLib.get_user_config_dir(), 'systemd', 'user', 'skeet.service');
        const updateEngine = () => {
            const ready = engineReady();
            statusRow.subtitle = ready ? 'Installed.' : 'Not installed yet.';
            setupButton.label = ready ? 'Re-run setup' : 'Set up';
            if (ready)
                setupButton.remove_css_class('suggested-action');
            else
                setupButton.add_css_class('suggested-action');
        };
        updateEngine();

        setupButton.connect('clicked', () => {
            logBuffer.text = '';
            logFrame.visible = true;
            setupButton.sensitive = false;
            setupSpinner.visible = true;
            statusRow.subtitle = 'Setting up…';
            run(['bash', helper('setup.sh')], line => {
                logBuffer.insert(logBuffer.get_end_iter(), `${line}\n`, -1);
                logView.scroll_to_iter(logBuffer.get_end_iter(), 0, false, 0, 0);
            }, ok => {
                setupButton.sensitive = true;
                setupSpinner.visible = false;
                updateEngine();
                if (!ok)
                    statusRow.subtitle = 'Setup stopped with an error; see the log below.';
            });
        });

        // ---- models ----
        const models = new Adw.PreferencesGroup({
            title: 'Speech model',
            description: 'Download a model, then pick the one to use. Models come from ' +
                'the sherpa-onnx project (NVIDIA Parakeet, CC-BY-4.0) and are checked ' +
                'against a checksum before use.',
        });
        page.add(models);
        let radioGroup = null;
        const rows = [];

        const addModelRow = m => {
            const row = new Adw.ActionRow({title: m.name});
            const radio = new Gtk.CheckButton({valign: Gtk.Align.CENTER, group: radioGroup});
            radioGroup ??= radio;
            row.add_prefix(radio);
            row.activatable_widget = radio;

            const progress = new Gtk.ProgressBar({
                valign: Gtk.Align.CENTER, width_request: 140, visible: false,
            });
            const download = new Gtk.Button({label: 'Download', valign: Gtk.Align.CENTER});
            const cancel = new Gtk.Button({label: 'Cancel', valign: Gtk.Align.CENTER, visible: false});
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
                tooltip_text: 'Delete this model', visible: false,
            });
            remove.add_css_class('flat');
            for (const w of [progress, download, cancel, remove])
                row.add_suffix(w);

            let proc = null;
            let error = null;
            const refresh = () => {
                const busy = proc !== null;
                radio.sensitive = m.installed && !busy;
                radio.active = m.installed && settings.get_string('model') === m.id;
                download.visible = !m.installed && !busy;
                download.label = error ? 'Retry' : 'Download';
                cancel.visible = progress.visible = busy;
                remove.visible = m.installed && !busy;
                if (!busy) {
                    row.subtitle = error ? `Download failed: ${error}`
                        : m.installed ? `${m.description} Installed.`
                            : `${m.description} ${megabytes(m.bytes)} download.`;
                }
            };

            radio.connect('toggled', () => {
                if (radio.active && settings.get_string('model') !== m.id)
                    settings.set_string('model', m.id); // the service reloads on change
            });

            download.connect('clicked', () => {
                error = null;
                progress.fraction = 0;
                row.subtitle = `Starting download (${megabytes(m.bytes)})…`;
                proc = run(['python3', helper('models.py'), 'download', m.id], line => {
                    const [kind, ...rest] = line.split(' ');
                    if (kind === 'PROGRESS') {
                        const [done, total] = rest.map(Number);
                        progress.fraction = total ? done / total : 0;
                        row.subtitle = `Downloading… ${megabytes(done)} of ${megabytes(total)}`;
                    } else if (kind === 'UNPACKING') {
                        progress.pulse();
                        row.subtitle = 'Checking and unpacking…';
                    } else if (kind === 'ERROR:') {
                        error = rest.join(' ');
                    }
                }, ok => {
                    if (proc)
                        running.delete(proc);
                    proc = null;
                    m.installed = ok;
                    if (ok) {
                        error = null;
                        // First model: use it straight away.
                        const current = rows.find(r => r.m.id === settings.get_string('model'));
                        if (!current?.m.installed)
                            settings.set_string('model', m.id);
                        reloadService();
                    } else if (error === 'cancelled') {
                        error = null;
                    } else {
                        error ??= 'unknown error';
                    }
                    refresh();
                });
                if (proc)
                    running.add(proc);
                refresh();
            });

            cancel.connect('clicked', () => proc?.send_signal(15));

            remove.connect('clicked', () => {
                const dialog = new Adw.AlertDialog({
                    heading: `Delete the ${m.name} model?`,
                    body: `This frees about ${megabytes(m.bytes * 1.35)}. You can download it again later.`,
                });
                dialog.add_response('cancel', 'Cancel');
                dialog.add_response('delete', 'Delete');
                dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
                dialog.connect('response', (_d, response) => {
                    if (response !== 'delete')
                        return;
                    run(['python3', helper('models.py'), 'delete', m.id], () => {}, () => {
                        m.installed = false;
                        // Deleted the one in use: switch to another installed one.
                        const other = rows.find(r => r.m.installed);
                        if (settings.get_string('model') === m.id && other)
                            settings.set_string('model', other.m.id);
                        else
                            reloadService();
                        rows.forEach(r => r.refresh());
                    });
                });
                dialog.present(window);
            });

            rows.push({m, refresh});
            models.add(row);
            refresh();
        };

        const loading = new Adw.ActionRow({title: 'Loading models…'});
        models.add(loading);
        const catalogue = [];
        run(['python3', helper('models.py'), 'list'], line => {
            try {
                catalogue.push(JSON.parse(line));
            } catch {}
        }, () => {
            models.remove(loading);
            if (!catalogue.length)
                models.add(new Adw.ActionRow({title: 'Could not list models (is python3 installed?)'}));
            catalogue.forEach(addModelRow);
        });
        settings.connect('changed::model', () => rows.forEach(r => r.refresh()));

        // ---- background noise ----
        const noise = new Adw.PreferencesGroup({title: 'Background noise'});
        page.add(noise);
        const filterRow = new Adw.ComboRow({
            title: 'Background noise filter',
            subtitle: 'Drops words much quieter than your own voice, like a TV or people ' +
                'across the room. Use High if the TV still gets typed, Low if your own ' +
                'quiet words go missing.',
            model: Gtk.StringList.new(FILTERS.map(f => f[1])),
        });
        const syncFilter = () => {
            filterRow.selected = Math.max(0,
                FILTERS.findIndex(f => f[0] === settings.get_string('noise-filter')));
        };
        syncFilter();
        filterRow.connect('notify::selected', () => {
            const nick = FILTERS[filterRow.selected][0];
            if (settings.get_string('noise-filter') !== nick)
                settings.set_string('noise-filter', nick);
        });
        settings.connect('changed::noise-filter', syncFilter);
        noise.add(filterRow);

        // ---- button ----
        const look = new Adw.PreferencesGroup({title: 'Button'});
        page.add(look);
        const sizeRow = new Adw.SpinRow({
            title: 'Button size',
            subtitle: 'Pixels. Delete and Enter are three quarters of this.',
            adjustment: new Gtk.Adjustment({lower: 40, upper: 120, step_increment: 4}),
        });
        settings.bind('button-size', sizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(sizeRow);

        const captionRow = new Adw.SwitchRow({
            title: 'Live caption while recording',
            subtitle: 'Shows what it has heard so far. Off saves CPU while you talk.',
        });
        settings.bind('live-captions', captionRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(captionRow);

        // ---- delete / enter ----
        const actions = new Adw.PreferencesGroup({
            title: 'Delete and Enter',
            description: 'After text is typed, Delete (above the button) removes exactly ' +
                'that text and Enter (below) presses Return. They hide when you tap ' +
                'one, start a new recording, move the button, or switch windows.',
        });
        page.add(actions);
        const actionsRow = new Adw.SwitchRow({title: 'Show Delete and Enter buttons'});
        settings.bind('action-buttons', actionsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        actions.add(actionsRow);
        const timeoutRow = new Adw.SpinRow({
            title: 'Hide after',
            subtitle: 'Seconds',
            adjustment: new Gtk.Adjustment({lower: 3, upper: 120, step_increment: 1}),
        });
        settings.bind('action-buttons-timeout', timeoutRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        settings.bind('action-buttons', timeoutRow, 'sensitive', Gio.SettingsBindFlags.GET);
        actions.add(timeoutRow);

        // ---- shortcut ----
        const keys = new Adw.PreferencesGroup({
            title: 'Keyboard shortcut',
            description: 'To dictate from a key or macro pad, add a custom shortcut in ' +
                'Settings → Keyboard → Keyboard Shortcuts with the command below ' +
                '(also: --delete, --enter, --cancel).',
        });
        page.add(keys);
        const cmd = `${GLib.get_home_dir()}/.local/bin/skeet --toggle`;
        const cmdRow = new Adw.ActionRow({title: cmd});
        cmdRow.add_css_class('monospace');
        const copy = new Gtk.Button({
            icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Copy',
        });
        copy.add_css_class('flat');
        copy.connect('clicked', () => copy.get_clipboard().set(cmd));
        cmdRow.add_suffix(copy);
        keys.add(cmdRow);
    }
}
