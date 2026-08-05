// Copyright (C) 2026 Apiratchai Lakkum
// SPDX-License-Identifier: GPL-2.0-or-later
// extension.js -- snapnine: nine-position window snapping for GNOME Shell.
//
// The focused window is moved and resized to one of nine rectangles on
// its monitor's work area: halves, quarters, maximize -- plus minimize.
// Every action has its own keybinding in the GSettings schema; change
// them with the settings dialog, gsettings(1), or dconf-editor.
//
// Pressing a position key a second time restores the window's previous
// geometry.  Position snaps leave fullscreen windows, dialogs, and
// other non-normal windows alone; maximize, restore, and minimize act
// on whatever window is focused.
//
// If a shortcut is already taken by a built-in GNOME keybinding, the
// key is left alone and the conflict is reported instead.  No other
// schema is ever touched.
//
// A D-Bus interface (org.gnome.Shell.Extensions.Snapnine) exposes the
// same operations.  It exists for the test suite (tests/test.sh drives
// it) and happens to let scripts tile windows too.

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
// [schema, key, human name]; value is an array of accelerators.
const BUILTIN_KEYS = [
    ['org.gnome.mutter.keybindings', 'toggle-tiled-left', 'Tiled left'],
    ['org.gnome.mutter.keybindings', 'toggle-tiled-right', 'Tiled right'],
    ['org.gnome.desktop.wm.keybindings', 'maximize', 'Maximize'],
    ['org.gnome.desktop.wm.keybindings', 'minimize', 'Minimize'],
    ['org.gnome.desktop.wm.keybindings', 'unmaximize', 'Unmaximize'],
    ['org.gnome.desktop.wm.keybindings', 'toggle-maximized', 'Toggle maximized'],
    // Super+1..9 switch applications; they count as conflicts too.
    ...Array.from({length: 9}, (_, i) =>
        ['org.gnome.shell.keybindings',
         `switch-to-application-${i + 1}`, `Switch to application ${i + 1}`]),
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
        this._exported = false;
        this._settleTimers = new Map();   // window -> pending settle timer id
        this._watchers = new Map();       // window -> size watcher id
        this._createdAt = new WeakMap();  // window -> creation time
        this._createdId = global.display.connect('window-created',
            (_display, window) => this._createdAt.set(window, Date.now()));

        this._rebind();
        this._exportDbus();

        // A changed shortcut is re-grabbed by mutter itself; we only
        // re-check conflicts and re-bind the keys that were skipped.
        this._changedId = this._settings.connect('changed', () => this._rebind());

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
        for (const id of this._settleTimers.values())
            GLib.source_remove(id);
        this._settleTimers.clear();
        for (const id of this._watchers.values())
            GLib.source_remove(id);
        this._watchers.clear();
        this._unbind();
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
    // the shell's key filter drops the binding.  Mutter's
    // meta_prefs_add_keybinding() re-grabs automatically when the
    // settings key changes.

    // -- key conflicts ------------------------------------------------

    // map our key -> [conflicting accelerator, human name of its owner]
    _conflicts() {
        const conflicts = new Map();
        const settingsBySchema = new Map();
        for (const key of ALL_KEYS) {
            for (const accel of this._settings.get_strv(key)) {
                for (const [schemaId, builtinKey, name] of BUILTIN_KEYS) {
                    let settings = settingsBySchema.get(schemaId);
                    if (!settings) {
                        try {
                            settings = new Gio.Settings({schema_id: schemaId});
                        } catch (e) {
                            log(`snapnine: schema ${schemaId} not available, ` +
                                `skipping conflict check: ${e.message}`);
                            continue;
                        }
                        settingsBySchema.set(schemaId, settings);
                    }
                    if (settings.get_strv(builtinKey).includes(accel) &&
                        !conflicts.has(key))
                        conflicts.set(key, [accel, name]);
                }
            }
        }
        return conflicts;
    }

    // Tell the user which key is taken and by what.  The builtin is
    // never touched; the user decides which side to rebind.
    _notifyConflicts(conflicts) {
        const taken = [...conflicts.entries()]
            .map(([key, [accel, name]]) => `${accel} (${name})`)
            .join(', ');
        log(`snapnine: not bound, key already in use: ${taken}`);
        Main.notify('snapnine',
            `Not bound, key already in use: ${taken}. ` +
            'Rebind in Extensions → snapnine or in Settings → Keyboard.');
    }

    // Bind what is not already taken by a builtin, and report the
    // rest.  Builtins are never modified.
    _rebind() {
        this._unbind();
        const conflicts = this._conflicts();
        for (const key of ALL_KEYS) {
            if (conflicts.has(key))
                continue;
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
        if (conflicts.size)
            this._notifyConflicts(conflicts);
    }

    _unbind() {
        for (const key of this._bindings) {
            if (global.display.remove_keybinding(key))
                Main.wm.allowKeybinding(key, Shell.ActionMode.NONE);
        }
        this._bindings = [];
    }

    // snap(window, position) -- apply an action to a window.
    // A null window (nothing focused) is a no-op.  The body is
    // wrapped because a window can be disposed mid-call through
    // signal re-entrancy (e.g. during move_resize_frame); an
    // uncaught throw would break the keybinding handler.
    snap(window, position) {
        try {
            this._snap(window, position);
        } catch (e) {
            log(`snapnine: snap failed: ${e.message}`);
        }
    }

    _snap(window, position) {
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
            // Note: maximize bypasses _applySnap, so a fresh window
            // gets no settle-wait and no watcher.  Native maximize is
            // robust against late client geometry; this is accepted.
            return;
        }

        // Restore: float the window centered, 3/5 x 4/5 of the work
        // area.  Not back to the pre-snap geometry: after a snap that
        // is half a screen.
        if (position === RESTORE) {
            // Also fire for mutter-tiled windows (builtin Super+arrow):
            // they hold a tile constraint, which may re-assert on
            // later resizes, but the float attempt is better than a
            // silent no-op.
            if (window.is_maximized() || this._previous.has(window) ||
                window.get_tile_match()) {
                const workArea =
                    window.get_work_area_for_monitor(window.get_monitor());
                window.unmaximize();
                this._applySnap(window, floatRect(workArea));
                this._previous.delete(window);
            }
            return;
        }

        if (!isPosition(position))
            return;

        // Unmaximize first, tiling-assistant's ordering (their tile(),
        // by Leleat): allows_resize()
        // is false while a window is maximized (mutter source,
        // meta_window_allows_resize), so unmaximizing before the gate
        // lets the plain check pass instead of needing an exception.
        window.unmaximize();

        if (!this._tilable(window))
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
    // snap even after it applied cleanly.  And a client that unmaps
    // and remaps (Firefox during page load) is re-placed by mutter at
    // the default centered position, wiping our geometry.  Stock
    // tiling survives both via a mutter tile constraint that is not
    // exposed to extensions, so we emulate it: watch the window and
    // re-assert the target rect until it holds, then stand down.
    _applySnap(window, target) {
        const apply = () => {
            // A window mid-unmap/remap has no monitor; moving a
            // window in that state crashes mutter (mutter #1600,
            // meta_window_update_monitor).  Skip and let the watcher
            // retry once the window is mapped again.
            if (!window.mapped || window.get_monitor() === -1)
                return;
            const move = () => {
                // tiling-assistant's current workaround (their tile(),
                // by Leleat, upstream main): some terminals only
                // resize but do not move with
                // move_resize_frame(user_op=true), so move first, then
                // resize.  user_op=true also avoids multi-monitor
                // clamping (their issue #137).
                window.move_frame(true, target.x, target.y);
                window.move_resize_frame(true, target.x, target.y,
                                         target.width, target.height);
            };
            move();
            // Verify and retry once: catches windows that ignore the
            // request entirely (reproduced here with zenity dialogs)
            // and the partial resize their older code saw with CSD
            // clients.  Same target, so a retry is harmless.
            const r = window.get_frame_rect();
            if (r.x !== target.x || r.y !== target.y ||
                r.width !== target.width || r.height !== target.height)
                move();
        };
        const safe = callback => () => {
            try {
                return callback();
            } catch (e) {
                log(`snapnine: watcher error: ${e.message}`);
                return GLib.SOURCE_REMOVE;
            }
        };

        // A new snap supersedes any watcher and pending settle timer
        // on this window.  Rapid alternation (left, right, left...)
        // otherwise leaves stale settle timers alive; each applies
        // its old target when it fires, flipping the window back and
        // forth on its own.
        const oldWatcher = this._watchers.get(window);
        if (oldWatcher)
            GLib.source_remove(oldWatcher);
        const oldSettle = this._settleTimers.get(window);
        if (oldSettle)
            GLib.source_remove(oldSettle);

        const fresh = (Date.now() - (this._createdAt.get(window) ?? 0)) < 3000;

        // Re-assert the geometry until it holds for three consecutive
        // checks.  The whole rect is watched, not just the size: a
        // client that unmaps and remaps (Firefox during page load)
        // gets re-placed by mutter at the default centered position,
        // and only a full-rect check catches that.  If the user grabs
        // the window, their intent wins and we stand down.
        const giveUp = why => {
            const r = window.get_frame_rect();
            if (r.x !== target.x || r.y !== target.y ||
                r.width !== target.width || r.height !== target.height)
                log(`snapnine: watcher gave up (${why}) on ` +
                    `${window.get_title()}: at ${r.x},${r.y} ${r.width}x${r.height}, ` +
                    `target ${target.x},${target.y} ${target.width}x${target.height}`);
            this._watchers.delete(window);
        };

        const watch = () => {
            let stable = 0;
            let ticks = 0;
            const cap = 40;     // 300 ms per tick, 12 s total
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, safe(() => {
                const r = window.get_frame_rect();
                ticks++;
                if (global.display.is_grabbed()) {
                    // Display-wide check: a grab on any window (user
                    // drag, another extension, a modal) stands this
                    // watcher down.  Mutter exposes no per-window grab
                    // query, so user intent wins conservatively.
                    giveUp('user grabbed the display');
                    return GLib.SOURCE_REMOVE;
                }
                // Mid-unmap/remap: wait, do not count stability, and
                // do not apply (that is what crashed mutter).
                if (!window.mapped || window.get_monitor() === -1) {
                    stable = 0;
                    if (ticks >= cap) {
                        giveUp('window never remapped in time');
                        return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                }
                if (r.x === target.x && r.y === target.y &&
                    r.width === target.width && r.height === target.height) {
                    if (++stable >= 3) {
                        this._watchers.delete(window);
                        return GLib.SOURCE_REMOVE;
                    }
                    if (ticks >= cap) {
                        giveUp('timeout');
                        return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                }
                stable = 0;
                if (ticks >= cap) {
                    giveUp('timeout');
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
                this._settleTimers.delete(window);
                apply();
                watch();
                return GLib.SOURCE_REMOVE;
            }
            previous = current;
            return GLib.SOURCE_CONTINUE;
        }));
        this._settleTimers.set(window, id);
    }

    _tilable(window) {
        return window.get_window_type() === Meta.WindowType.NORMAL &&
               !window.is_attached_dialog() &&
               window.allows_resize();
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
        if (window && (window.mapped && window.get_monitor() !== -1)) {
            window.unmaximize();
            // move_frame first, tiling-assistant's workaround (see
            // apply() in snap), then verify and retry once.
            window.move_frame(true, x, y);
            window.move_resize_frame(true, x, y, w, h);
            const r = window.get_frame_rect();
            if (r.x !== x || r.y !== y || r.width !== w || r.height !== h)
                window.move_resize_frame(true, x, y, w, h);
        } else if (window) {
            // Not a silent no-op: the test suite must see the skip.
            log(`snapnine: MoveWindow skipped, ${title} not mapped`);
        }
        return window !== null;
    }

    GetWindowRect(title) {
        const window = this._findByTitle(title);
        if (!window)
            return 'gone';
        try {
            return this._rectString(window);
        } catch (e) {
            log(`snapnine: GetWindowRect failed: ${e.message}`);
            return 'gone';
        }
    }

    GetWindowState(title) {
        const window = this._findByTitle(title);
        if (!window)
            return 'gone';
        try {
            if (window.is_fullscreen())
                return 'fullscreen';
            if (window.minimized)
                return 'minimized';
            if (window.is_maximized())
                return 'maximized';
            return 'normal';
        } catch (e) {
            log(`snapnine: GetWindowState failed: ${e.message}`);
            return 'gone';
        }
    }

    GetMonitorWorkArea(title) {
        const window = this._findByTitle(title);
        if (!window)
            return 'gone';
        try {
            const wa = window.get_work_area_for_monitor(window.get_monitor());
            return `${wa.x} ${wa.y} ${wa.width} ${wa.height}`;
        } catch (e) {
            log(`snapnine: GetMonitorWorkArea failed: ${e.message}`);
            return 'gone';
        }
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
