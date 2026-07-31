// extension.js -- snapnine: nine-position window snapping for GNOME Shell.
//
// The focused window is moved and resized to one of nine rectangles on
// its monitor's work area: halves, quarters, maximize -- plus minimize.
// Every action has its own keybinding in the GSettings schema; change
// them with the settings dialog, gsettings(1), or dconf-editor.
//
// Pressing a position key a second time restores the window's previous
// geometry.  Fullscreen windows, dialogs, and other non-normal windows
// are left alone.
//
// If a position key collides with a built-in GNOME shortcut (the stock
// Super+arrow tiling, maximize, minimize), the built-in one is disabled
// for as long as this extension is enabled, then restored.  This is the
// only other schema we ever touch.
//
// A small D-Bus interface (org.gnome.Shell.Extensions.Snapnine) exposes
// the same operations so the extension can be driven and verified from
// scripts; tests/test.sh uses it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {POSITIONS, isPosition, rect, eq, floatRect} from './rect.js';

const MINIMIZE = 'minimize';
const RESTORE = 'restore';

// Binding names are the schema keys.  They carry a 'snap-' prefix:
// mutter's builtin keybindings own the names 'maximize' and
// 'minimize', and add_keybinding() rejects duplicate names.
const KEY_TO_ACTION = Object.fromEntries([
    ...POSITIONS.map(p => [`snap-${p}`, p]),
    ['snap-minimize', MINIMIZE],
    ['snap-restore', RESTORE],
]);
const ALL_KEYS = Object.keys(KEY_TO_ACTION);

const DBUS_PATH = '/org/gnome/shell/extensions/snapnine';
// Built-in shortcuts that may collide with ours.
// [schema, key]; value is an array of accelerators.
const BUILTIN_KEYS = [
    ['org.gnome.mutter.keybindings', 'toggle-tiled-left'],
    ['org.gnome.mutter.keybindings', 'toggle-tiled-right'],
    ['org.gnome.desktop.wm.keybindings', 'maximize'],
    ['org.gnome.desktop.wm.keybindings', 'minimize'],
    ['org.gnome.desktop.wm.keybindings', 'unmaximize'],
    ['org.gnome.desktop.wm.keybindings', 'toggle-maximized'],
    // Super+1..9 switch applications; the shield must cover them too,
    // or a user-repurposed number key would lose to the builtin.
    ...Array.from({length: 9}, (_, i) =>
        ['org.gnome.shell.keybindings', `switch-to-application-${i + 1}`]),
];

const IFACE_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.Snapnine">
    <method name="SnapWindow">
      <arg type="s" name="title" direction="in"/>
      <arg type="s" name="position" direction="in"/>
      <arg type="b" name="found" direction="out"/>
    </method>
    <method name="MoveWindow">
      <arg type="s" name="title" direction="in"/>
      <arg type="i" name="x" direction="in"/>
      <arg type="i" name="y" direction="in"/>
      <arg type="i" name="w" direction="in"/>
      <arg type="i" name="h" direction="in"/>
      <arg type="b" name="found" direction="out"/>
    </method>
    <method name="GetWindowRect">
      <arg type="s" name="title" direction="in"/>
      <arg type="s" name="rect" direction="out"/>
    </method>
    <method name="GetWindowState">
      <arg type="s" name="title" direction="in"/>
      <arg type="s" name="state" direction="out"/>
    </method>
    <method name="GetMonitorWorkArea">
      <arg type="s" name="title" direction="in"/>
      <arg type="s" name="area" direction="out"/>
    </method>
    <method name="SetFullscreen">
      <arg type="s" name="title" direction="in"/>
      <arg type="b" name="full" direction="in"/>
      <arg type="b" name="found" direction="out"/>
    </method>
    <method name="GetMonitors">
      <arg type="i" name="count" direction="out"/>
    </method>
  </interface>
</node>`;

export default class SnapnineExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._bindings = [];
        this._previous = new WeakMap();   // window -> geometry before last snap
        this._shielded = [];              // built-in shortcuts we disabled
        this._exported = false;
        this._freshTimers = new Set();    // pending settle timers
        this._watchers = new Map();       // window -> size watcher id
        this._createdAt = new WeakMap();  // window -> creation time
        this._createdId = global.display.connect('window-created',
            (_display, window) => this._createdAt.set(window, Date.now()));

        this._bind();
        this._shield();
        this._exportDbus();

        // mutter re-grabs each binding itself when its settings key
        // changes; we only need to re-evaluate the shield.
        this._changedId = this._settings.connect('changed', () => {
            this._unshield();
            this._shield();
        });

        log('snapnine: enabled');
    }

    disable() {
        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = 0;
        }
        if (this._createdId) {
            global.display.disconnect(this._createdId);
            this._createdId = 0;
        }
        for (const id of this._freshTimers)
            GLib.source_remove(id);
        this._freshTimers.clear();
        for (const id of this._watchers.values())
            GLib.source_remove(id);
        this._watchers.clear();
        this._unbind();
        this._unshield();
        if (this._exported) {
            this._dbusImpl.unexport();
            this._exported = false;
        }
        log('snapnine: disabled');
    }

    // -- keybindings ---------------------------------------------------

    // The public API, per gnome-shell source (ui/windowManager.js):
    //   global.display.add_keybinding(name, settings, flags, handler)
    // followed by Main.wm.allowKeybinding(name, modes), without which
    // the shell's key filter drops the binding.  Mutters's
    // meta_prefs_add_keybinding() re-grabs automatically when the
    // settings key changes.
    _bind() {
        for (const key of ALL_KEYS) {
            const action = global.display.add_keybinding(
                key, this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                () => this.snap(global.display.focus_window,
                                KEY_TO_ACTION[key]));
            if (action === Meta.KeyBindingAction.NONE) {
                log(`snapnine: cannot bind ${key}`);
                continue;
            }
            Main.wm.allowKeybinding(key, Shell.ActionMode.NORMAL);
            this._bindings.push(key);
        }
    }

    _unbind() {
        for (const key of this._bindings) {
            if (global.display.remove_keybinding(key))
                Main.wm.allowKeybinding(key, Shell.ActionMode.NONE);
        }
        this._bindings = [];
    }

    // -- built-in shortcut shield --------------------------------------

    // Disable any built-in shortcut that uses one of our accelerators.
    // Remember the original values; disable() restores them.
    _shield() {
        const ours = ALL_KEYS.flatMap(k => this._settings.get_strv(k));
        for (const [schemaId, key] of BUILTIN_KEYS) {
            const settings = new Gio.Settings({schema_id: schemaId});
            const accels = settings.get_strv(key);
            if (!accels.some(a => ours.includes(a)))
                continue;
            this._shielded.push([schemaId, key, accels]);
            settings.set_strv(key, []);
            log(`snapnine: disabled built-in shortcut ${schemaId} ${key}`);
        }
    }

    _unshield() {
        for (const [schemaId, key, original] of this._shielded) {
            const settings = new Gio.Settings({schema_id: schemaId});
            // Only restore if the user hasn't changed it meanwhile.
            if (settings.get_strv(key).length === 0)
                settings.set_strv(key, original);
        }
        this._shielded = [];
    }

    // -- snapping ------------------------------------------------------

    // snap(window, position) -- apply an action to a window.
    // A null window (nothing focused) is a no-op.
    snap(window, position) {
        if (!window || window.is_fullscreen())
            return;

        if (position === MINIMIZE) {
            if (window.can_minimize())
                window.minimize();
            return;
        }

        if (position === 'maximize') {
            if (!window.can_maximize())
                return;
            if (!window.is_maximized())
                window.maximize();
            return;
        }

        // Restore: float the window centered, 3/5 x 4/5 of the work
        // area.  Deliberately not back to the pre-snap geometry: after
        // a snap that geometry is half a screen.
        if (position === RESTORE) {
            if (window.is_maximized() || this._previous.has(window)) {
                const workArea =
                    window.get_work_area_for_monitor(window.get_monitor());
                window.unmaximize();
                this._applySnap(window, floatRect(workArea));
                this._previous.delete(window);
            }
            return;
        }

        if (!isPosition(position) || !this._tilable(window))
            return;

        const workArea = window.get_work_area_for_monitor(window.get_monitor());
        const target = rect(position, workArea);
        const current = window.get_frame_rect();

        // Already there: restore the geometry saved on the first snap.
        if (eq(current, target)) {
            const previous = this._previous.get(window);
            if (previous) {
                window.unmaximize();
                this._applySnap(window, previous);
            }
            return;
        }

        this._previous.set(window, {
            x: current.x, y: current.y,
            width: current.width, height: current.height,
        });
        window.unmaximize();
        this._applySnap(window, target);
    }

    // Freshly created windows race their initial placement: mutter
    // applies the client's first geometry on the first frame, and any
    // move we apply before that is overridden -- the window ends up
    // "neutral" in the center.  Same symptom reported against
    // tiling-assistant (https://github.com/ubuntu/Tiling-Assistant,
    // issue #421: https://github.com/ubuntu/Tiling-Assistant/issues/421,
    // filed by their user jumbled00r; that user is not us, we only
    // suspect the same issue).  Also a known Firefox-on-Wayland
    // behaviour.  For fresh windows, wait for the geometry to settle,
    // then move.
    //
    // On Wayland the client is authoritative for its own size: a late
    // client resize (session restore, content load) can override our
    // snap even after it applied cleanly.  Stock tiling survives this
    // via a mutter tile constraint that is not exposed to extensions,
    // so we emulate it: watch the window and re-assert the target
    // size until it holds, then stand down.
    _applySnap(window, target) {
        const apply = () => {
            window.move_resize_frame(true, target.x, target.y,
                                     target.width, target.height);
        };
        const safe = callback => () => {
            try {
                return callback();
            } catch (e) {
                return GLib.SOURCE_REMOVE;   // window destroyed mid-wait
            }
        };

        // A new snap supersedes any watcher on this window.
        const old = this._watchers.get(window);
        if (old)
            GLib.source_remove(old);

        const fresh = (Date.now() - (this._createdAt.get(window) ?? 0)) < 3000;

        // Re-assert the size until it holds for three consecutive
        // checks; give up after a few seconds so a deliberate user
        // resize is never fought for long.  Position changes are not
        // watched: only the client can fight us on size.
        const watch = () => {
            let stable = 0;
            let ticks = 0;
            const cap = fresh ? 20 : 5;     // 300 ms per tick
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, safe(() => {
                const r = window.get_frame_rect();
                ticks++;
                if (r.width === target.width && r.height === target.height) {
                    if (++stable >= 3 || ticks >= cap) {
                        this._watchers.delete(window);
                        return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                }
                stable = 0;
                if (ticks >= cap) {
                    this._watchers.delete(window);
                    return GLib.SOURCE_REMOVE;
                }
                apply();
                return GLib.SOURCE_CONTINUE;
            }));
            this._watchers.set(window, id);
        };

        if (!fresh) {
            apply();
            watch();
            return;
        }

        // Fresh window: wait for the initial placement to settle
        // (two stable reads), then move and watch.
        let previous = null;
        let ticks = 0;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, safe(() => {
            const r = window.get_frame_rect();
            const current = `${r.x},${r.y},${r.width},${r.height}`;
            if (previous === current || ++ticks >= 15) {
                this._freshTimers.delete(id);
                apply();
                watch();
                return GLib.SOURCE_REMOVE;
            }
            previous = current;
            return GLib.SOURCE_CONTINUE;
        }));
        this._freshTimers.add(id);
    }

    // allows_resize() is false for maximized windows (mutter source:
    // meta_window_allows_resize), so maximized windows get an explicit
    // pass here: they can be unmaximized and then resized.
    _tilable(window) {
        return window.get_window_type() === Meta.WindowType.NORMAL &&
               !window.is_attached_dialog() &&
               (window.allows_resize() || window.is_maximized());
    }

    // -- D-Bus (scripts and the test suite) ----------------------------

    // Export on the shell's own session-bus connection (the same way
    // the shell exports org.gnome.Shell), so the interface is reachable
    // at org.gnome.Shell + DBUS_PATH without owning a bus name.
    _exportDbus() {
        const info = Gio.DBusNodeInfo.new_for_xml(IFACE_XML);
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(info.interfaces[0], this);
        this._dbusImpl.export(Gio.DBus.session, DBUS_PATH);
        this._exported = true;
    }

    _findByTitle(title) {
        for (const actor of global.get_window_actors()) {
            const window = actor.meta_window;
            if (window.get_title() === title)
                return window;
        }
        return null;
    }

    _rectString(window) {
        const r = window.get_frame_rect();
        return `${r.x} ${r.y} ${r.width} ${r.height}`;
    }

    // D-Bus methods: plain (non-Async) methods are called with the
    // in-arguments only; the return value is marshalled as the reply.
    SnapWindow(title, position) {
        const window = this._findByTitle(title);
        if (window)
            this.snap(window, position);
        return window !== null;
    }

    MoveWindow(title, x, y, w, h) {
        const window = this._findByTitle(title);
        if (window) {
            window.unmaximize();
            window.move_resize_frame(true, x, y, w, h);
        }
        return window !== null;
    }

    GetWindowRect(title) {
        const window = this._findByTitle(title);
        return window ? this._rectString(window) : 'gone';
    }

    GetWindowState(title) {
        const window = this._findByTitle(title);
        if (!window)
            return 'gone';
        if (window.is_fullscreen())
            return 'fullscreen';
        if (window.minimized)
            return 'minimized';
        if (window.is_maximized())
            return 'maximized';
        return 'normal';
    }

    GetMonitorWorkArea(title) {
        const window = this._findByTitle(title);
        if (!window)
            return 'gone';
        const wa = window.get_work_area_for_monitor(window.get_monitor());
        return `${wa.x} ${wa.y} ${wa.width} ${wa.height}`;
    }

    SetFullscreen(title, full) {
        const window = this._findByTitle(title);
        if (window) {
            if (full)
                window.make_fullscreen();
            else
                window.unmake_fullscreen();
        }
        return window !== null;
    }

    GetMonitors() {
        return global.display.get_n_monitors();
    }
}
