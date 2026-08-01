// Copyright (C) 2026 Apiratchai Lakkum
// SPDX-License-Identifier: GPL-2.0-or-later
// prefs.js -- snapnine settings dialog.
//
// Lists the eleven actions with their current keybindings.  Click a key to
// capture a new one; press Escape to cancel, Backspace to clear (which
// disables the shortcut).

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// [settings key, human name]
const ACTIONS = [
    ['snap-left', 'Snap to left half'],
    ['snap-right', 'Snap to right half'],
    ['snap-up', 'Snap to top half'],
    ['snap-down', 'Snap to bottom half'],
    ['snap-top-left', 'Snap to top-left quarter'],
    ['snap-top-right', 'Snap to top-right quarter'],
    ['snap-bottom-left', 'Snap to bottom-left quarter'],
    ['snap-bottom-right', 'Snap to bottom-right quarter'],
    ['snap-maximize', 'Maximize'],
    ['snap-restore', 'Restore / float centered'],
    ['snap-minimize', 'Minimize'],
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

    // Popover that grabs the next keypress.
    _capture() {
        const popover = new Gtk.Popover({
            child: new Gtk.Label({
                label: 'Press new shortcut — Esc cancels, Backspace removes the last one',
                margin_top: 12,
                margin_bottom: 12,
                margin_start: 12,
                margin_end: 12,
            }),
        });
        popover.set_parent(this._button);
        popover.popup();

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
                popover.popdown();
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
                popover.popdown();
            }
            return true;
        });
        popover.connect('closed', () => popover.unparent());
    }
});

export default class SnapninePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const group = new Adw.PreferencesGroup({
            title: 'Snap positions',
            description: 'Each action has its own shortcut. ' +
                'Pressing a position key again restores the previous geometry.',
        });

        for (const [key, title] of ACTIONS) {
            const row = new ShortcutRow(settings, key, title);
            group.add(row);
            settings.connect(`changed::${key}`, () => row._updateLabel());
        }

        const page = new Adw.PreferencesPage();
        page.add(group);
        window.add(page);
    }
}
