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
// halves).  Used by the layout overlay.
export function gridRect(wa, columns, rows, col, row) {
    // Degenerate grids (0 or negative from a D-Bus caller) would
    // divide by zero and produce NaN geometry; treat them as a 1x1.
    if (columns < 1 || rows < 1)
        return {x: wa.x, y: wa.y, width: wa.width, height: wa.height};
    const w = Math.floor(wa.width / columns);
    const h = Math.floor(wa.height / rows);
    return {
        x: wa.x + col * w,
        y: wa.y + row * h,
        width: col === columns - 1 ? wa.width - col * w : w,
        height: row === rows - 1 ? wa.height - row * h : h,
    };
}

// hitTest(point, rects) → array of indices
//
// Returns the indices of every rect that contains `point`.  A point on a
// shared edge may land in more than one rect (they can overlap in a
// saved preset).  Returns an empty array when nothing is hit.
//
// point is {x, y} in the same coordinate space as the rects.
export function hitTest(point, rects) {
    const hits = [];
    for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (point.x >= r.x && point.x < r.x + r.width &&
            point.y >= r.y && point.y < r.y + r.height)
            hits.push(i);
    }
    return hits;
}

// overlappingPairs(rects) → array of [i, j] pairs
//
// Returns every pair of indices whose rectangles overlap.  Each pair is
// [i, j] with i < j (no duplicates, no self-pairs).  Overlap includes
// shared edges so stacked windows are detected as overlapping.
export function overlappingPairs(rects) {
    const pairs = [];
    for (let i = 0; i < rects.length; i++) {
        const a = rects[i];
        for (let j = i + 1; j < rects.length; j++) {
            const b = rects[j];
            if (a.x < b.x + b.width && a.x + a.width > b.x &&
                a.y < b.y + b.height && a.y + a.height > b.y)
                pairs.push([i, j]);
        }
    }
    return pairs;
}

// parsePreset(json, currentWa) → rects[]
//
// Parses a JSON preset string into an array of work-area-relative rects,
// scaled to `currentWa` if the preset records a different work-area size.
// Returns [] for any parse failure or empty input.  Pure geometry, no
// shell imports — unit-testable with plain gjs.
//
// JSON shape: {"wa":{"width":N,"height":N},"rects":[{"x":N,...},...]}
// wa is optional (scale 1.0 when absent); rects is a mandatory array.
export function parsePreset(json, currentWa) {
    if (!json)
        return [];
    let preset;
    try {
        preset = JSON.parse(json);
    } catch (e) {
        return [];
    }
    if (!preset || !Array.isArray(preset.rects))
        return [];

    let sw = 1, sh = 1;
    if (preset.wa && preset.wa.width > 0 && preset.wa.height > 0 &&
        currentWa && currentWa.width > 0 && currentWa.height > 0) {
        sw = currentWa.width / preset.wa.width;
        sh = currentWa.height / preset.wa.height;
    }

    const out = [];
    for (const r of preset.rects) {
        if (r && r.width > 0 && r.height > 0) {
            out.push({
                x: Math.round((r.x || 0) * sw),
                y: Math.round((r.y || 0) * sh),
                width: Math.round(r.width * sw),
                height: Math.round(r.height * sh),
            });
        }
    }
    return out;
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
