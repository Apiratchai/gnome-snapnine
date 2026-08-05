// Copyright (C) 2026 Apiratchai Lakkum
// SPDX-License-Identifier: GPL-2.0-or-later
// rect.js -- nine-position geometry for snapnine.
//
// Pure functions, no shell imports.  Every position is a rectangle
// derived from the monitor's work area, so this module can be tested
// with plain gjs(1), no compositor needed (see tests/unit.js).
//
// Positions:
//
//   left, right        -- vertical halves
//   up, down           -- horizontal halves
//   top-left ...       -- quarters
//   maximize           -- the whole work area
//
// minimize is not a rectangle; the extension handles it directly.
//
// Halves and quarters are computed so adjacent rectangles tile the
// work area exactly: no gaps, no overlap, even for odd sizes.

export const POSITIONS = [
    'left', 'right', 'up', 'down',
    'top-left', 'top-right', 'bottom-left', 'bottom-right',
    'maximize',
];

export function isPosition(p) {
    return POSITIONS.includes(p);
}

// rect(position, workArea) -> {x, y, width, height} or null
//
// workArea is {x, y, width, height}, as returned by
// Meta.Window.get_work_area_for_monitor().
export function rect(position, wa) {
    const w = wa.width / 2 | 0;          // | 0: floor, as in C
    const h = wa.height / 2 | 0;

    switch (position) {
    case 'left':
        return {x: wa.x, y: wa.y, width: w, height: wa.height};
    case 'right':
        return {x: wa.x + w, y: wa.y, width: wa.width - w, height: wa.height};
    case 'up':
        return {x: wa.x, y: wa.y, width: wa.width, height: h};
    case 'down':
        return {x: wa.x, y: wa.y + h, width: wa.width, height: wa.height - h};
    case 'top-left':
        return {x: wa.x, y: wa.y, width: w, height: h};
    case 'top-right':
        return {x: wa.x + w, y: wa.y, width: wa.width - w, height: h};
    case 'bottom-left':
        return {x: wa.x, y: wa.y + h, width: w, height: wa.height - h};
    case 'bottom-right':
        return {x: wa.x + w, y: wa.y + h, width: wa.width - w, height: wa.height - h};
    case 'maximize':
        return {x: wa.x, y: wa.y, width: wa.width, height: wa.height};
    }
    return null;
}

// eq(a, b) -- rectangle equality; used to detect "already snapped",
// which triggers the restore-previous-geometry behaviour.
export function eq(a, b) {
    return a.x === b.x && a.y === b.y &&
           a.width === b.width && a.height === b.height;
}

// gridRect(workArea, columns, rows, col, row) -- one cell of an
// N-column x M-row grid over the work area.  The last column and row
// absorb the remainder so the grid tiles exactly (same rule as the
// halves).  Used by the experimental layout overlay (branch-only).
export function gridRect(wa, columns, rows, col, row) {
    const w = Math.floor(wa.width / columns);
    const h = Math.floor(wa.height / rows);
    return {
        x: wa.x + col * w,
        y: wa.y + row * h,
        width: col === columns - 1 ? wa.width - col * w : w,
        height: row === rows - 1 ? wa.height - row * h : h,
    };
}

// floatRect(workArea) -- the "restore" rectangle: a centered floating
// window, 3/5 width by 4/5 height of the work area.  Floors keep the
// arithmetic identical to shell integer division (see tests/test.sh).
export function floatRect(wa) {
    const w = Math.floor(wa.width * 3 / 5);
    const h = Math.floor(wa.height * 4 / 5);
    return {
        x: wa.x + Math.floor((wa.width - w) / 2),
        y: wa.y + Math.floor((wa.height - h) / 2),
        width: w,
        height: h,
    };
}
