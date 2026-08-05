// overlay.js -- experimental interactive layout grid.
//
// Shows a grid on the focused window's monitor; clicking a cell snaps
// the focused window into that cell.  Escape or right-click cancels.
// Pressing the layout key again also cancels.
//
// BRANCH-ONLY PROTOTYPE.  Likely to bloat and break; the mainline
// extension does not include this.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gridRect} from './rect.js';

export class LayoutOverlay {
    constructor(columns, rows, onPick) {
        this._columns = columns;
        this._rows = rows;
        this._onPick = onPick;
        this._destroyed = false;

        const window = global.display.focus_window;
        if (!window)
            return;
        this._wa = window.get_work_area_for_monitor(window.get_monitor());

        this._container = new St.Widget({
            x: this._wa.x,
            y: this._wa.y,
            width: this._wa.width,
            height: this._wa.height,
            style_class: 'snapnine-layout-overlay',
        });
        this._container.set_layout_manager(new Clutter.BinLayout());

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < columns; col++) {
                const r = gridRect(this._wa, columns, rows, col, row);
                const cell = new St.Button({
                    x: r.x - this._wa.x,
                    y: r.y - this._wa.y,
                    width: r.width,
                    height: r.height,
                    style_class: 'snapnine-layout-cell',
                    can_focus: false,
                });
                cell.connect('clicked', () => this._pick(col, row));
                this._container.add_child(cell);
            }
        }

        // Escape cancels; right-click cancels too.
        this._container.connect('key-press-event', (w, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.destroy();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._container.connect('button-press-event', (w, event) => {
            if (event.get_button() === 3) {
                this.destroy();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        Main.uiGroup.add_child(this._container);
        this._container.grab_key_focus();
    }

    _pick(col, row) {
        const target = gridRect(this._wa, this._columns, this._rows, col, row);
        const onPick = this._onPick;
        this.destroy();
        if (onPick)
            onPick(target);
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._container) {
            this._container.destroy();
            this._container = null;
        }
    }
}
