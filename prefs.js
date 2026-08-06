// Copyright (C) 2026 Apiratchai Lakkum
// SPDX-License-Identifier: GPL-2.0-or-later
// prefs.js -- snapnine settings dialog.
//
// Lists the eleven actions with their current keybindings.  Click a key to
// capture a new one; press Escape to cancel, Backspace to clear (which
// disables the shortcut).

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {parsePreset} from './rect.js';

// [settings key, human name] -- ordered like the numpad so the list
// reads spatially: top-left, top, top-right, left, center, right, ...
const ACTIONS = [
    ['snap-top-left', 'Top-left quarter'],
    ['snap-up', 'Top half'],
    ['snap-top-right', 'Top-right quarter'],
    ['snap-left', 'Left half'],
    ['snap-maximize', 'Maximize'],
    ['snap-right', 'Right half'],
    ['snap-bottom-left', 'Bottom-left quarter'],
    ['snap-down', 'Bottom half'],
    ['snap-bottom-right', 'Bottom-right quarter'],
    ['snap-restore', 'Restore / float centered'],
    ['snap-minimize', 'Minimize'],
    ['snap-layout-1', 'Activate layout preset 1'],
    ['snap-layout-2', 'Activate layout preset 2'],
    ['snap-layout-3', 'Activate layout preset 3'],
    ['snap-capture-layout', 'Capture layout'],
];

// One row: action name + a button showing the current shortcut.
const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init(settings, key, title) {
        super._init({title});

        this._settings = settings;
        this._key = key;

        this._button = new Gtk.Button();
        this._button.add_css_class('flat');
        this._updateLabel();
        this.add_suffix(this._button);
        this._button.connect('clicked', () => this._capture());
    }

    _updateLabel() {
        const accels = this._settings.get_strv(this._key);
        if (accels.length === 0) {
            this._button.label = '—';
            this._button.tooltip_text = 'No shortcut. Click to set one.';
        } else {
            this._button.label = accels.join(', ');
            this._button.tooltip_text =
                `${accels.join(', ')} — click to add another`;
        }
    }

    // Popover that grabs the next keypress.  A status label gives
    // feedback ("Added: <key>") before the popover closes, so the
    // result of the capture is visible instead of a bare popdown.
    _capture() {
        const status = new Gtk.Label({
            label: 'Press a shortcut — Esc cancels, Backspace removes the last',
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        const popover = new Gtk.Popover({child: status});
        popover.set_parent(this._button);
        popover.popup();

        // Close after feedback; a second keypress supersedes the wait.
        let closeTimer = 0;
        const closeSoon = () => {
            if (closeTimer)
                GLib.source_remove(closeTimer);
            closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                closeTimer = 0;
                popover.popdown();
                return GLib.SOURCE_REMOVE;
            });
        };

        const controller = new Gtk.EventControllerKey();
        popover.add_controller(controller);
        controller.connect('key-pressed', (c, keyval, keycode, state) => {
            if (keyval === Gdk.KEY_Escape) {
                popover.popdown();
                return true;
            }
            if (keyval === Gdk.KEY_BackSpace) {
                // Remove the last accelerator, keep the rest.
                const accels = this._settings.get_strv(this._key);
                this._settings.set_strv(this._key, accels.slice(0, -1));
                status.label = 'Removed the last shortcut';
                closeSoon();
                return true;
            }
            // Only accept real shortcuts (a modifier or a function key).
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (Gtk.accelerator_valid(keyval, mods)) {
                // Actions accept several accelerators; add, don't replace.
                const accel = Gtk.accelerator_name(keyval, mods);
                const accels = this._settings.get_strv(this._key);
                if (!accels.includes(accel))
                    this._settings.set_strv(this._key, [...accels, accel]);
                status.label = `Added: ${accel}`;
                closeSoon();
            } else {
                status.label = 'Not a shortcut — press a modifier combo';
            }
            return true;
        });
        popover.connect('closed', () => {
            if (closeTimer) {
                GLib.source_remove(closeTimer);
                closeTimer = 0;
            }
            popover.unparent();
        });
    }
});

// Read-only row showing how many positions are saved in a preset,
// with a button to clear it.
const PresetStatusRow = GObject.registerClass(
class PresetStatusRow extends Adw.ActionRow {
    _init(settings, key, title) {
        super._init({title});
        this._settings = settings;
        this._key = key;

        this._label = new Gtk.Label({halign: Gtk.Align.START});
        this._update();
        this.add_suffix(this._label);

        const clearBtn = new Gtk.Button({
            label: 'Clear',
            css_classes: ['flat'],
            sensitive: false,
        });
        clearBtn.connect('clicked', () => {
            this._settings.set_string(this._key, '');
            this._update();
        });
        this.add_suffix(clearBtn);

        settings.connect(`changed::${key}`, () => {
            this._update();
            const json = this._settings.get_string(this._key);
            clearBtn.sensitive = json !== '';
        });

        // Set initial clear button sensitivity.
        clearBtn.sensitive = this._settings.get_string(this._key) !== '';
    }

    _update() {
        const count = parsePreset(this._settings.get_string(this._key)).length;
        this._label.label = count
            ? `${count} position${count > 1 ? 's' : ''}`
            : 'empty';
    }
});

export default class SnapninePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const group = new Adw.PreferencesGroup({
            title: 'Snap positions',
            description: 'Pressing a position key again restores the previous geometry.',
        });

        // Numpad hint: a monospace mini-numpad so the spatial layout
        // reads at a glance.  The rows below follow the same order.
        const hintRow = new Adw.ActionRow({title: 'Numpad layout'});
        const hintLabel = new Gtk.Label({
            label: '7 8 9\n4 5 6\n1 2 3',
            css_classes: ['monospace'],
            halign: Gtk.Align.START,
        });
        hintRow.add_suffix(hintLabel);
        hintRow.subtitle = 'bind any keys — the layout is just the default';
        group.add(hintRow);

        for (const [key, title] of ACTIONS) {
            const row = new ShortcutRow(settings, key, title);
            group.add(row);
            settings.connect(`changed::${key}`, () => row._updateLabel());
        }

        const presetGroup = new Adw.PreferencesGroup({
            title: 'Layout presets',
            description: 'Capture saves the window arrangement, a layout key applies it.',
        });
        for (let i = 1; i <= 3; i++) {
            const key = `layout-preset-${i}`;
            presetGroup.add(new PresetStatusRow(settings, key, `Preset ${i}`));
        }

        const page = new Adw.PreferencesPage();
        page.add(group);
        page.add(presetGroup);
        window.add(page);
    }
}
