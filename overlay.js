// overlay.js -- experimental interactive layout overlay.
//
// Shows saved window positions (or captured positions) on the focused
// window's monitor as clickable cells.  Two modes:
//
//   'pick'    — cells are clickable; clicking snaps the focused window
//               to that position.  Arrow keys navigate, Enter picks,
//               numpad 1–9 (or main keyboard 1–9) select directly.
//   'capture' — cells are visual-only; three slot buttons at the bottom
//               let the user save the positions to a preset.
//
// Escape or right-click cancels/dismisses either mode.
//
// BRANCH-ONLY PROTOTYPE.  Likely to bloat and break; the mainline
// extension does not include this.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Map numpad key symbols (both NumLock states) to 0-based cell indices.
// Numpad physical layout:
//   7 8 9
//   4 5 6
//   1 2 3
const _NUMPAD_TO_INDEX = {
    // row 3 (bottom)
    [Clutter.KEY_KP_1]: 0,          [Clutter.KEY_KP_End]: 0,
    [Clutter.KEY_KP_2]: 1,          [Clutter.KEY_KP_Down]: 1,
    [Clutter.KEY_KP_3]: 2,          [Clutter.KEY_KP_Page_Down]: 2,
    // row 2 (middle)
    [Clutter.KEY_KP_4]: 3,          [Clutter.KEY_KP_Left]: 3,
    [Clutter.KEY_KP_5]: 4,          [Clutter.KEY_KP_Begin]: 4,
    [Clutter.KEY_KP_6]: 5,          [Clutter.KEY_KP_Right]: 5,
    // row 1 (top)
    [Clutter.KEY_KP_7]: 6,          [Clutter.KEY_KP_Home]: 6,
    [Clutter.KEY_KP_8]: 7,          [Clutter.KEY_KP_Up]: 7,
    [Clutter.KEY_KP_9]: 8,          [Clutter.KEY_KP_Page_Up]: 8,
};

export class LayoutOverlay {
    // rects     — array of {x, y, width, height} relative to the work area
    // mode      — 'pick' | 'capture'
    // title     — optional label shown at the top (e.g., "Preset 2")
    // onPick    — called with absolute target rect when cell selected (pick mode)
    // onSlot    — called with index (0/1/2) when save slot chosen (capture mode)
    // onDestroy — called after the overlay is cleaned up
    constructor(rects, mode, title, onPick, onSlot, onDestroy) {
        this._mode = mode;
        this._onPick = onPick;
        this._onSlot = onSlot;
        this._onDestroy = onDestroy;
        this._destroyed = false;
        this._cells = [];
        this._focusIndex = -1;

        if (!rects || rects.length === 0)
            return;

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
            reactive: true,
        });
        this._container.set_layout_manager(new Clutter.BinLayout());

        if (title) {
            const label = new St.Label({
                text: title,
                x: 12,
                y: 8,
                style_class: 'snapnine-layout-title',
            });
            this._container.add_child(label);
        }

        const cellClass = mode === 'capture'
            ? 'snapnine-layout-capture-cell'
            : 'snapnine-layout-cell';

        let i = 0;
        for (const r of rects) {
            // Cells are positioned relative to the container (container sits
            // at wa.x, wa.y); rects are work-area-relative so no offset needed.
            const cell = new St.Button({
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                label: i < 9 ? String(i + 1) : '',
                style_class: cellClass,
                can_focus: false,
            });
            const target = {x: r.x, y: r.y, width: r.width, height: r.height};

            if (mode === 'pick') {
                cell.connect('clicked', () => this._pick(target));
            }
            cell.connect('button-press-event', (w, event) => {
                if (event.get_button() === 3) {
                    this.destroy();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._container.add_child(cell);
            this._cells.push({button: cell, target});
            i++;
        }

        // Initial focus highlight on the first cell (pick mode only).
        if (mode === 'pick' && this._cells.length > 0)
            this._setFocus(0);

        // In capture mode, add save-slot buttons at the bottom.
        if (mode === 'capture')
            this._addSlotButtons();

        // Keyboard handling.
        this._container.connect('key-press-event', (w, event) => {
            const sym = event.get_key_symbol();

            // Escape always cancels.
            if (sym === Clutter.KEY_Escape) {
                this.destroy();
                return Clutter.EVENT_STOP;
            }

            if (mode === 'capture') {
                // Capture mode: 1/2/3 (both main and numpad) pick slots.
                if (sym === Clutter.KEY_1 || sym === Clutter.KEY_KP_1 ||
                    sym === Clutter.KEY_KP_End) {
                    this._saveSlot(0);
                    return Clutter.EVENT_STOP;
                }
                if (sym === Clutter.KEY_2 || sym === Clutter.KEY_KP_2 ||
                    sym === Clutter.KEY_KP_Down) {
                    this._saveSlot(1);
                    return Clutter.EVENT_STOP;
                }
                if (sym === Clutter.KEY_3 || sym === Clutter.KEY_KP_3 ||
                    sym === Clutter.KEY_KP_Page_Down) {
                    this._saveSlot(2);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            }

            // --- pick mode keyboard handling ---

            // Numpad: direct cell selection (1–9, either NumLock state).
            const npIdx = _NUMPAD_TO_INDEX[sym];
            if (npIdx !== undefined && npIdx < this._cells.length) {
                this._pick(this._cells[npIdx].target);
                return Clutter.EVENT_STOP;
            }

            // Main keyboard 1–9: direct cell selection.
            if (sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
                const idx = sym - Clutter.KEY_1;
                if (idx < this._cells.length) {
                    this._pick(this._cells[idx].target);
                    return Clutter.EVENT_STOP;
                }
            }

            // Arrow keys: move focus.
            if (sym === Clutter.KEY_Right || sym === Clutter.KEY_KP_Right) {
                this._moveFocus(1, 0);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Left || sym === Clutter.KEY_KP_Left) {
                this._moveFocus(-1, 0);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Down || sym === Clutter.KEY_KP_Down) {
                this._moveFocus(0, 1);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Up || sym === Clutter.KEY_KP_Up) {
                this._moveFocus(0, -1);
                return Clutter.EVENT_STOP;
            }

            // Enter / KP_Enter: pick the focused cell.
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                if (this._focusIndex >= 0) {
                    this._pick(this._cells[this._focusIndex].target);
                    return Clutter.EVENT_STOP;
                }
            }

            return Clutter.EVENT_PROPAGATE;
        });

        // Right-click on the container background also cancels.
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

    // -- focus navigation (pick mode) ------------------------------------

    _setFocus(index) {
        if (this._focusIndex >= 0 && this._focusIndex < this._cells.length) {
            const old = this._cells[this._focusIndex].button;
            old.style_class = old.style_class.replace(
                ' snapnine-layout-cell-focused', '');
        }
        this._focusIndex = index;
        if (index >= 0 && index < this._cells.length) {
            const btn = this._cells[index].button;
            if (!btn.style_class.includes('snapnine-layout-cell-focused'))
                btn.style_class += ' snapnine-layout-cell-focused';
        }
    }

    // Find the nearest cell in direction (dx, dy).  dx = 1 means right,
    // dx = -1 means left, dy = 1 means down, dy = -1 means up.
    _moveFocus(dx, dy) {
        if (this._cells.length === 0)
            return;
        const from = this._focusIndex >= 0 ? this._focusIndex : 0;
        const fromBtn = this._cells[from].button;
        const cx = fromBtn.x + fromBtn.width / 2;
        const cy = fromBtn.y + fromBtn.height / 2;

        let best = from;
        let bestDist = Infinity;

        for (let i = 0; i < this._cells.length; i++) {
            if (i === from)
                continue;
            const b = this._cells[i].button;
            const diffX = (b.x + b.width / 2) - cx;
            const diffY = (b.y + b.height / 2) - cy;

            // Must be in the target direction on at least one axis.
            if (dx > 0 && diffX <= 0)
                continue;
            if (dx < 0 && diffX >= 0)
                continue;
            if (dy > 0 && diffY <= 0)
                continue;
            if (dy < 0 && diffY >= 0)
                continue;

            const dist = diffX * diffX + diffY * diffY;
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        }

        this._setFocus(best);
    }

    // -- slot buttons (capture mode) --------------------------------------

    _addSlotButtons() {
        const btnW = 120;
        const gap = 10;
        const barW = 3 * btnW + 2 * gap;
        const barX = Math.floor((this._wa.width - barW) / 2);
        const barY = this._wa.height - 52;

        for (let i = 0; i < 3; i++) {
            const btn = new St.Button({
                x: barX + i * (btnW + gap),
                y: barY,
                width: btnW,
                height: 36,
                label: `Preset ${i + 1}`,
                style_class: 'snapnine-layout-slot-btn',
                can_focus: false,
            });
            const slot = i;
            btn.connect('clicked', () => this._saveSlot(slot));
            this._container.add_child(btn);
        }
    }

    _saveSlot(index) {
        // Save first; if the callback throws, the overlay stays up.
        if (this._onSlot)
            this._onSlot(index);
        this.destroy();
    }

    // -- pick mode --------------------------------------------------------

    _pick(target) {
        // target is relative to the work area; convert to absolute
        // screen coordinates for move_resize_frame.
        const abs = {
            x: target.x + this._wa.x,
            y: target.y + this._wa.y,
            width: target.width,
            height: target.height,
        };
        const onPick = this._onPick;
        this.destroy();
        if (onPick)
            onPick(abs);
    }

    // -- cleanup ----------------------------------------------------------

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._container) {
            this._container.destroy();
            this._container = null;
        }
        this._cells = [];
        this._focusIndex = -1;
        if (this._onDestroy)
            this._onDestroy();
    }
}
