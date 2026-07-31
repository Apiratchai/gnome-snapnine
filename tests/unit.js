// unit.js -- geometry tests for snapnine.  Plain gjs, no compositor:
//
//     gjs tests/unit.js
//
// Exits non-zero on any failure.

import {POSITIONS, isPosition, rect, eq, floatRect} from '../rect.js';
import system from 'system';

let pass = 0;
let fail = 0;

function check(name, condition) {
    if (condition) {
        pass++;
        print(`PASS  ${name}`);
    } else {
        fail++;
        print(`FAIL  ${name}`);
    }
}

function r(position, wa) {
    return rect(position, wa);
}

// A typical work area below a top panel: 1920x1080 screen, 28px panel.
const WA = {x: 0, y: 28, width: 1920, height: 1052};

check('left', eq(r('left', WA), {x: 0, y: 28, width: 960, height: 1052}));
check('right', eq(r('right', WA), {x: 960, y: 28, width: 960, height: 1052}));
check('up', eq(r('up', WA), {x: 0, y: 28, width: 1920, height: 526}));
check('down', eq(r('down', WA), {x: 0, y: 554, width: 1920, height: 526}));
check('top-left', eq(r('top-left', WA), {x: 0, y: 28, width: 960, height: 526}));
check('top-right', eq(r('top-right', WA), {x: 960, y: 28, width: 960, height: 526}));
check('bottom-left', eq(r('bottom-left', WA), {x: 0, y: 554, width: 960, height: 526}));
check('bottom-right', eq(r('bottom-right', WA), {x: 960, y: 554, width: 960, height: 526}));
check('maximize', eq(r('maximize', WA), WA));

// Odd sizes: halves and quarters must tile without gaps or overlap.
const ODD = {x: 0, y: 0, width: 1921, height: 1053};
const ol = r('left', ODD);
const orr = r('right', ODD);
check('odd halves tile exactly', ol.width + orr.width === 1921 && ol.x + ol.width === orr.x);
const ou = r('up', ODD);
const od = r('down', ODD);
check('odd vertical halves tile exactly', ou.height + od.height === 1053 && ou.y + ou.height === od.y);

// Quarters cover the work area exactly.
const tl = r('top-left', WA);
const tr = r('top-right', WA);
const bl = r('bottom-left', WA);
const br = r('bottom-right', WA);
check('quarters cover work area',
    tl.width + tr.width === WA.width &&
    bl.width + br.width === WA.width &&
    tl.height + bl.height === WA.height &&
    tr.height + br.height === WA.height);
check('quarters meet in the middle',
    tl.x + tl.width === tr.x && tl.y + tl.height === bl.y &&
    bl.x + bl.width === br.x && tr.y + tr.height === br.y);

// Offset work areas (side panel on the left).
const OFF = {x: 100, y: 50, width: 800, height: 600};
check('offset right', eq(r('right', OFF), {x: 500, y: 50, width: 400, height: 600}));
check('offset bottom-right', eq(r('bottom-right', OFF), {x: 500, y: 350, width: 400, height: 300}));
check('offset maximize', eq(r('maximize', OFF), OFF));

// Degenerate work area: no NaN, no crash.
const ZERO = {x: 0, y: 0, width: 0, height: 0};
check('zero left', eq(r('left', ZERO), {x: 0, y: 0, width: 0, height: 0}));
check('zero has no NaN', [r('left', ZERO), r('bottom-right', ZERO)].every(v =>
    [v.x, v.y, v.width, v.height].every(n => Number.isFinite(n))));

// Position validation.
check('isPosition left', isPosition('left') === true);
check('isPosition maximize', isPosition('maximize') === true);
check('isPosition bogus', isPosition('bogus') === false);
check('isPosition minimize false', isPosition('minimize') === false);
check('unknown position -> null', rect('bogus', WA) === null);
check('POSITIONS has 9 entries', POSITIONS.length === 9);

// eq() itself.
check('eq true', eq({x: 1, y: 2, width: 3, height: 4}, {x: 1, y: 2, width: 3, height: 4}));
check('eq false', eq({x: 1, y: 2, width: 3, height: 4}, {x: 1, y: 2, width: 3, height: 5}) === false);

// floatRect: centered, 3/5 x 4/5, floors mirror sh arithmetic.
check('floatRect', eq(floatRect(WA),
    {x: 384, y: 133, width: 1152, height: 841}));
check('floatRect odd work area', eq(floatRect({x: 0, y: 0, width: 1921, height: 1053}),
    {x: 384, y: 105, width: 1152, height: 842}));

print('');
print(`${pass} passed, ${fail} failed`);
if (fail > 0)
    print('UNIT TESTS FAILED');
else
    print('unit tests ok');
system.exit(fail > 0 ? 1 : 0);
