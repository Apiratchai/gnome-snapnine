# gnome-snapnine

Window snapping for GNOME Shell, designed around the numpad.

Nine positions: halves, quarters, full screen, plus restore (float
centered) and minimize. Every action has its own shortcut, and you can
give each action several shortcuts.

## The numpad layout

```
  7 8 9      top-left     top-half     top-right
  4 5 6      left         maximize     right
  1 2 3      bottom-left  bottom-half  bottom-right
```

No numpad? Bind anything else. The layout is one array in rect.js;
adding a position is a two-line change.

## Default shortcuts

| Action            | Default                        |
|-------------------|--------------------------------|
| left / right half | Super+Left / Super+Right       |
| top / bottom half | Super+KP_8 / Super+KP_2        |
| quarters          | Super+KP_7, KP_9, KP_1, KP_3   |
| maximize          | Super+Up                       |
| restore (float)   | Super+Down                     |
| minimize          | Super+h                        |

Rebind everything in the settings dialog or with gsettings. Pressing a
position key again restores the previous geometry.

## Why this exists

Inspired by Tiling Assistant, which I used for two years. It is a good
extension. It has one bug I could not live with: snap a freshly opened
Firefox window and it lands in the middle of the screen instead of
where you pointed it, and you have to press the key two or three
times. The issue is still open in their tracker (#421).

The cause, in plain words: on Wayland the app controls its own window
size. Firefox opens a window, then loads content and resizes itself a
moment later. If the snap happens in between, the late resize wins and
the window is left in a neutral spot. GNOME's built-in tiling survives
this because mutter has an internal tile constraint, which extensions
cannot use.

gnome-snapnine works around it from the outside: it waits for the
window to settle before snapping, then watches the size and re-applies
the snap if the app overrides it. The window always ends up where you
told it to go.

## Honest notes

- The code was written with DeepSeek Flash (0731) in about one hour,
  for $0.308. I am not a maintainer and do not plan to be. Expect
  rough edges.
- There is a test suite to compensate: 28 geometry unit tests (plain
  gjs) and a live suite that drives real windows over D-Bus and
  presses real keys through uinput. Run `make unit` and `make live`.
- Tested on GNOME Shell 50.3 / mutter 50.3, Wayland, Fedora.

## Install

    make install     # then log out and back in
    make enable

or: `gnome-extensions install snapnine.zip` (make zip).
