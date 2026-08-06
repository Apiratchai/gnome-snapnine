// overlay.js -- interactive layout overlay.
//
// Shows saved window positions (or captured positions) on the focused
// window's monitor as clickable cells.  Two modes:
//
//   'pick'    — batch mode: Tab cycles the target window, click / numpad
//               1–9 / arrows+Enter snap the target into a cell.  The
//               overlay stays open; auto-closes after every window on the
//               monitor has a cell.  Overlapping cells show a popup menu.
//               A hint bar at the bottom lists the shortcuts.
//   'capture' — cells are visual-only; three slot buttons at the bottom
//               let the user save the positions to a preset.
//
// Escape / right-click cancels/dismisses either mode.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {hitTest, overlappingPairs} from './rect.js';

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
    // onPick    — called with (window, absTarget) when a cell is picked (pick mode)
    // onSlot    — called with index (0/1/2) when save slot chosen (capture mode)
    // onDestroy — called after the overlay is cleaned up
    // slotInfo  — optional [3] of strings shown on the save buttons
    //             (capture mode), e.g. "empty" or "4 windows"
    constructor(rects, mode, title, onPick, onSlot, onDestroy, slotInfo) {
        this._mode = mode;
        this._onPick = onPick;
        this._onSlot = onSlot;
        this._onDestroy = onDestroy;
        this._slotInfo = slotInfo;
        this._destroyed = false;
        this._grab = null;
        this._cells = [];
        this._focusIndex = -1;
        this._outline = null;

        if (!rects || rects.length === 0)
            return;

        const window = global.display.focus_window;
        if (!window) {
            log('snapnine: overlay cannot show without a focused window');
            return;
        }
        this._wa = window.get_work_area_for_monitor(window.get_monitor());

        // Pick mode: enumerate windows for Tab-cycling and auto-close.
        this._windows = [];
        this._targetIndex = 0;
        this._snapCount = 0;
        this._maxSnaps = 0;
        if (mode === 'pick') {
            const monitor = window.get_monitor();
            const activeWs = global.workspace_manager.get_active_workspace_index();
            const wins = [];
            for (const actor of global.get_window_actors()) {
                const w = actor.meta_window;
                if (!w || !w.mapped || w.minimized || w.get_monitor() !== monitor)
                    continue;
                if (w.get_workspace().index() !== activeWs)
                    continue;
                if (w.get_window_type() !== Meta.WindowType.NORMAL)
                    continue;
                if (w.is_skip_taskbar())
                    continue;
                if (w === window)
                    continue;
                wins.push(w);
            }
            // Focused window first.
            this._windows = [window, ...wins];
            this._targetIndex = 0;
            this._maxSnaps = Math.min(this._windows.length, rects.length);
        }

        this._container = new St.Widget({
            x: this._wa.x,
            y: this._wa.y,
            width: this._wa.width,
            height: this._wa.height,
            style_class: 'snapnine-layout-overlay',
            reactive: true,
        });
        // The overlay colors are tuned for a dark shell theme; mark
        // the container when the theme background is light so the CSS
        // can switch to dark-on-light colors.
        const {colorScheme} = St.Settings.get();
        if (colorScheme === St.SystemColorScheme.PREFER_LIGHT)
            this._container.add_style_class_name('snapnine-light');
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
                style_class: cellClass,
                can_focus: false,
            });
            const target = {x: r.x, y: r.y, width: r.width, height: r.height};

            cell.connect('button-press-event', (w, event) => {
                const btn = event.get_button();
                if (btn === 3) {
                    this.destroy();
                    return Clutter.EVENT_STOP;
                }
                // Left-click in pick mode: hit-test against all cells
                // so overlapping slots show a popup.
                if (btn === 1 && mode === 'pick') {
                    const [sx, sy] = event.get_coords();
                    const cx = sx - this._wa.x;
                    const cy = sy - this._wa.y;
                    const targets = this._cells.map(c => c.target);
                    const hits = hitTest({x: cx, y: cy}, targets);
                    if (hits.length === 1) {
                        this._pick(targets[hits[0]]);
                    } else if (hits.length > 1) {
                        this._showOverlapPopup(hits, sx, sy);
                    }
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

        // Hint bar visible in pick mode at the bottom of the overlay.
        if (mode === 'pick') {
            const hint = new St.Label({
                text: 'Tab: next window · 1-9/click: place · Esc: close',
                x: 12,
                y: this._wa.height - 36,
                style_class: 'snapnine-layout-hint',
            });
            this._container.add_child(hint);
        } else if (mode === 'capture') {
            const hint = new St.Label({
                text: '1/2/3: save preset · Esc: cancel',
                x: 12,
                y: this._wa.height - 100,
                style_class: 'snapnine-layout-hint',
            });
            this._container.add_child(hint);
        }

        // In capture mode, add save-slot buttons at the bottom.
        if (mode === 'capture')
            this._addSlotButtons();

        // Outline around the current target window (pick mode only).
        // Tab cycles the target; the outline follows it so the user can
        // see which window the next pick will move.  Added last so it
        // stacks above the cells.
        if (mode === 'pick') {
            this._outline = new St.Widget({
                style_class: 'snapnine-layout-target-outline',
                reactive: false,
            });
            this._container.add_child(this._outline);
            this._updateOutline();
        }

        // Keyboard handling.
        this._container.connect('key-press-event', (w, event) => {
            const sym = event.get_key_symbol();

            // Escape: dismiss popup if open, otherwise cancel overlay.
            if (sym === Clutter.KEY_Escape) {
                if (this._popup) {
                    this._dismissPopup();
                    return Clutter.EVENT_STOP;
                }
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

            // Tab: cycle the target window.
            if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
                this._cycleWindow();
                return Clutter.EVENT_STOP;
            }

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

        // Clicks on the container background: dismiss popup or cancel.
        this._container.connect('button-press-event', (w, event) => {
            if (event.get_button() === 3) {
                this.destroy();
                return Clutter.EVENT_STOP;
            }
            // Left-click on background (not a cell): dismiss popup if open.
            if (event.get_button() === 1 && this._popup) {
                this._dismissPopup();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        Main.uiGroup.add_child(this._container);

        // Position numbers on their own top layer, added after the outline
        // so nothing (cell borders, focus highlights, target outline) is
        // drawn over them.  Each number is sized to its content and
        // centered on its cell; St.Label's x/y alignment does not work in
        // this shell, so centering is done by positioning.  Not reactive,
        // so clicks still reach the cells below.
        // Overlap groups: numbers on stacked cells all land near the same
        // cell center, so within a group each number gets its own slot and
        // the column spreads upward instead of piling.
        const targets = this._cells.map(c => c.target);
        const parent = targets.map((_, i) => i);
        const find = i => {
            let r = i;
            while (parent[r] !== r)
                r = parent[r];
            while (parent[i] !== r) {
                const next = parent[i];
                parent[i] = r;
                i = next;
            }
            return r;
        };
        const union = (a, b) => {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb)
                parent[ra] = rb;
        };
        for (const [a, b] of overlappingPairs(targets))
            union(a, b);
        const nextSlot = new Map();
        const slotOf = new Map();
        for (let i = 0; i < targets.length; i++) {
            const r = find(i);
            slotOf.set(i, nextSlot.get(r) ?? 0);
            nextSlot.set(r, (nextSlot.get(r) ?? 0) + 1);
        }

        for (let n = 0; n < this._cells.length && n < 9; n++) {
            const t = this._cells[n].target;
            const num = new St.Label({
                text: String(n + 1),
                style_class: 'snapnine-layout-cell-num',
                reactive: false,
            });
            this._container.add_child(num);
            const [, nw, , nh] = num.get_preferred_size();
            num.set_size(nw, nh);
            const slot = slotOf.get(n) ?? 0;
            const y = Math.round(t.y + (t.height - nh) / 2) - 10 - slot * (nh + 6);
            num.set_position(
                Math.round(t.x + (t.width - nw) / 2),
                Math.max(Math.round(t.y) + 2, y));
        }

        // Modal grab: keyboard events go to the overlay only, not to the
        // focused application.  Without it, Tab / digits / Escape are both
        // handled here and delivered to the app below (reported bug).
        this._grab = Main.pushModal(this._container);
    }

    // -- focus navigation (pick mode) ------------------------------------

    _setFocus(index) {
        if (this._focusIndex >= 0 && this._focusIndex < this._cells.length) {
            this._cells[this._focusIndex].button
                .remove_style_class_name('snapnine-layout-cell-focused');
        }
        this._focusIndex = index;
        if (index >= 0 && index < this._cells.length)
            this._cells[index].button
                .add_style_class_name('snapnine-layout-cell-focused');
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
        const btnW = 160;
        const gap = 10;
        const barW = 3 * btnW + 2 * gap;
        const barX = Math.floor((this._wa.width - barW) / 2);
        const barY = this._wa.height - 52;

        for (let i = 0; i < 3; i++) {
            const info = this._slotInfo?.[i];
            const btn = new St.Button({
                x: barX + i * (btnW + gap),
                y: barY,
                width: btnW,
                height: 36,
                label: info ? `Preset ${i + 1} (${info})` : `Preset ${i + 1}`,
                style_class: 'snapnine-layout-slot-btn',
                can_focus: false,
            });
            const slot = i;
            btn.connect('clicked', () => this._saveSlot(slot));
            this._container.add_child(btn);
        }
    }

    _saveSlot(index) {
        // Save first; if the callback throws, the overlay stays up so
        // the user can retry.  The error is logged, not silent.
        try {
            if (this._onSlot)
                this._onSlot(index);
        } catch (e) {
            log(`snapnine: save preset ${index + 1} failed: ${e.message}`);
            return;
        }
        this.destroy();
    }

    // -- overlap popup (pick mode) ---------------------------------------

    // When a click hits several overlapping cells, show a small vertical
    // menu listing them so the user can pick one.  Escape / right-click
    // dismisses the popup (overlay stays open).
    _showOverlapPopup(indices, sx, sy) {
        if (this._popup)
            this._popup.destroy();

        // Plain reactive labels, not St.Button: a popup item only needs a
        // numbered, clickable label, and St.Button adds its own press/
        // release semantics that are easy to fight with.  St.Label is a
        // StWidget, so the same CSS (background, border, padding, :hover)
        // applies.
        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'snapnine-layout-popup',
        });

        for (const idx of indices) {
            const item = new St.Label({
                text: idx < 9 ? String(idx + 1) : `Cell ${idx + 1}`,
                reactive: true,
                track_hover: true,
                can_focus: false,
                style_class: 'snapnine-layout-popup-btn',
            });
            item.connect('button-press-event', (w, event) => {
                if (event.get_button() === 1) {
                    this._pick(this._cells[idx].target);
                    this._dismissPopup();
                }
                return Clutter.EVENT_STOP;
            });
            // Hovering an item highlights its cell so it is obvious which
            // overlapping slot the number refers to.
            item.connect('enter-event', () => {
                this._cells[idx].button
                    .add_style_class_name('snapnine-layout-popup-hl');
            });
            item.connect('leave-event', () => {
                this._cells[idx].button
                    .remove_style_class_name('snapnine-layout-popup-hl');
            });
            box.add_child(item);
        }

        // Clamp to container bounds.
        const px = Math.max(4, Math.min(sx - this._wa.x, this._wa.width - 120));
        const py = Math.max(4, Math.min(sy - this._wa.y, this._wa.height - 120));

        this._container.add_child(box);
        this._popup = box;

        // The container uses a BinLayout, which only allocates its first
        // child, so the popup needs an explicit size or it renders at 0x0.
        // Size it after it is in the stage: before that, fonts and styles
        // are not loaded, so the natural width can come out too small and
        // clip the item numbers (leaving only the padding clickable).
        const [, natW, , natH] = box.get_preferred_size();
        box.set_size(Math.max(natW, 48), natH);
        box.set_position(px, py);

        // Clicking outside the popup dismisses it.
        box.connect('button-press-event', (w, event) => {
            if (event.get_button() === 3) {
                this._dismissPopup();
                return Clutter.EVENT_STOP;
            }
            // Left-click on a popup item is handled and stopped by the
            // item's press handler (above), so this only runs for clicks
            // on the box background itself.
            this._dismissPopup();
            return Clutter.EVENT_STOP;
        });
    }

    _dismissPopup() {
        for (const cell of this._cells)
            cell.button.remove_style_class_name('snapnine-layout-popup-hl');
        if (this._popup) {
            this._popup.destroy();
            this._popup = null;
        }
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
        const window = this._windows[this._targetIndex];
        if (this._onPick && window)
            this._onPick(window, abs);
        this._updateOutline();

        this._snapCount++;
        if (this._snapCount >= this._maxSnaps)
            this.destroy();
    }

    // -- batch mode (pick mode) ------------------------------------------

    // Reposition the outline around the current target window.
    _updateOutline() {
        if (!this._outline)
            return;
        const w = this._windows[this._targetIndex];
        if (!w || !w.mapped || w.get_monitor() === -1) {
            this._outline.hide();
            return;
        }
        const r = w.get_frame_rect();
        this._outline.set_position(r.x - this._wa.x, r.y - this._wa.y);
        this._outline.set_size(r.width, r.height);
        this._outline.show();
    }

    // Cycle the target window forward (Tab) or backward (Shift+Tab).
    _cycleWindow() {
        if (this._windows.length <= 1)
            return;
        this._targetIndex = (this._targetIndex + 1) % this._windows.length;
        // Skip windows that disappeared since enumeration.
        for (let tries = 0; tries < this._windows.length; tries++) {
            const w = this._windows[this._targetIndex];
            if (w && w.mapped && !w.minimized) {
                w.activate(global.get_current_time());
                this._updateOutline();
                return;
            }
            this._targetIndex = (this._targetIndex + 1) % this._windows.length;
        }
    }

    // -- cleanup ----------------------------------------------------------

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._dismissPopup();
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._container) {
            this._container.destroy();
            this._container = null;
        }
        this._cells = [];
        this._focusIndex = -1;
        this._outline = null;
        if (this._onDestroy)
            this._onDestroy();
    }
}
