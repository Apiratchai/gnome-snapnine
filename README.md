# gnome-snapnine — nine-position window snapping for GNOME Shell

Snap the focused window to one of nine rectangles on its monitor's work
area — vertical and horizontal halves, four quarters, the full screen —
plus **restore** (float centered) and **minimize**.  Every action has
its own keybinding, and every action accepts **several accelerators**
at once.

## Designed for the numpad

The nine positions map onto the numpad as a compass:

```
  7 8 9      top-left   top-half    top-right
  4 5 6      left       maximize    right
  1 2 3      bottom-left bottom-half bottom-right
```

No numpad?  Bind anything you like — the layout is data-driven (one
array in `rect.js`), and adding new positions later is a two-line
change.

## Default keybindings

| Action            | Default         |
|-------------------|-----------------|
| left / right half | `Super+Left` / `Super+Right` |
| top / bottom half | `Super+KP_8` / `Super+KP_2` |
| quarters          | `Super+KP_7` `KP_9` `KP_1` `KP_3` |
| maximize          | `Super+Up` |
| restore (float)   | `Super+Down` |
| minimize          | `Super+h` |

Everything is rebindable in the settings dialog (Extensions → snapnine)
or with gsettings.  Add as many shortcuts per action as you like; a
binding that collides with a built-in GNOME shortcut (including the
`Super+1..9` app switcher) disables that built-in while snapnine is
enabled and restores it afterwards.

Pressing a position key a second time restores the window's previous
geometry.

## Why another tiling extension?

* **Fixes the fresh-window race.**  On Wayland, a newly opened window
  (Firefox especially) can override a snap with its own late geometry,
  leaving the window "neutral" in the middle — the bug reported as
  tiling-assistant #421, still open.  snapnine waits for the initial
  placement to settle and re-asserts the target size against late
  client resizes.
* **Small and auditable.**  ~350 lines, no adaptive layouts, no
  popups, no dependencies beyond the shell itself.
* **Tested.**  28 geometry unit tests run with plain `gjs`; a live
  suite drives real windows over D-Bus and presses real keys through
  uinput.
* **Scriptable.**  Exports `org.gnome.Shell.Extensions.Snapnine` on the
  session bus, so windows can be tiled from scripts.

## Install

    make install     # then log out and back in
    make enable
    make unit        # geometry tests, no shell needed
    make live        # full integration suite (needs the extension enabled)

or, from a zip: `gnome-extensions install snapnine.zip`.

## Environment

Tested on GNOME Shell 50.3 / mutter 50.3 (Meta 18), Wayland, Fedora.
