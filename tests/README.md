# snapnine tests & advanced notes

## Testing

```sh
make unit    # geometry checks, no shell needed (gjs tests/unit.js)
make live    # full suite: real windows, D-Bus, injected keypresses (tests/test.sh)
```

`make live` requires the extension enabled in a running graphical session.
It spawns test windows, drives the D-Bus interface below, and verifies
exact geometry for every position, plus toggle-restore, maximize→snap,
minimize, fullscreen/dialog guards, rebinds, real keypresses (uinput),
and the late client resize.

Files: `unit.js` (geometry unit tests), `test.sh` (live suite),
`inject.py` (uinput virtual keyboard), `race.py` / `remap.py` (helpers).

## Configuration with gsettings

The settings dialog (Extensions → snapnine) covers everything, but
gsettings works too. The schema lives with the extension, and plain
gsettings cannot see it. Pass --schemadir:

```sh
gsettings --schemadir \
    ~/.local/share/gnome-shell/extensions/snapnine@github/schemas \
    set org.gnome.shell.extensions.snapnine snap-left \
    "['<Super>Left', '<Super>KP_4']"
```

Every action accepts several accelerators. An empty array disables the
shortcut. If a shortcut is already taken by a built-in GNOME
keybinding (for example Super+2, the app switcher), snapnine leaves
it alone and tells you which app owns the key. Rebind snapnine's
shortcut or change the other one. If an action has several
accelerators and one is taken, the whole action is skipped until the
conflict is resolved. No other part of the GNOME configuration is
ever modified.

Layout preset shortcuts:

| Action | Schema key | Default |
|---|---|---|
| Capture layout | `snap-capture-layout` | `Super+Shift+g` |
| Activate preset 1 | `snap-layout-1` | `Super+Shift+1` |
| Activate preset 2 | `snap-layout-2` | `Super+Shift+2` |
| Activate preset 3 | `snap-layout-3` | `Super+Shift+3` |

## Scripting (D-Bus)

The D-Bus interface exists for the test suite: GNOME 50 has no remote
way to drive the shell (the old eval channel is gone), so the
extension exposes its operations on the session bus and tests/test.sh
drives them. A side effect is that scripts can tile windows too. For
example, open a terminal (the title must match exactly):

```sh
ptyxis -T Terminal
```

(that is Fedora's terminal. On Ubuntu, Debian, Mint use
`gnome-terminal --title Terminal`, on classic X11 setups
`xterm -title Terminal`.) Then snap it to the left half:

```sh
gdbus call --session \
    --dest org.gnome.Shell \
    --object-path /org/gnome/shell/extensions/snapnine \
    --method org.gnome.Shell.Extensions.Snapnine.SnapWindow \
    Terminal left
```

Methods:

```
SnapWindow(title, position)     -> found
MoveWindow(title, x, y, w, h)   -> found
GetWindowRect(title)            -> "x y w h" | gone
GetWindowState(title)           -> normal|minimized|maximized|fullscreen|gone
GetMonitorWorkArea(title)       -> "x y w h" | gone
SetFullscreen(title, full)      -> found
GetMonitors()                   -> count
```

Position (SnapWindow, MoveWindow uses x/y/w/h instead):

| Position | Snap to |
|---|---|
| left / right | left / right half |
| up / down | top / bottom half |
| top-left, top-right, bottom-left, bottom-right | quarters |
| maximize / restore / minimize | work area / float centered / hide |

## Limitations

- The shell scans for extensions only at session start, so a new install
  needs a log out and back in.
- Other tiling extensions (tiling-assistant, WinTile, ...) grab the
  same keys, so disable them or rebind snapnine.
- Windows tiled by drag-and-drop keep a mutter tile constraint.
  Snapping them away works, but mutter may re-assert the constraint
  on later resizes. That is mutter behaviour, not fought.
- GNOME 50 offers no API to inject key presses from outside the
  shell, so the suite drives a uinput virtual keyboard instead
  (tests/inject.py).
- Layout presets are stored as JSON strings. Old presets saved with
  earlier versions (branch prototype) use a different format and do not
  carry over — re-capture them after upgrading.

## Scope

- Tested on GNOME Shell 50.3, mutter 50.3, Wayland, Fedora.
- GNOME 51 and multi-monitor setups are not yet verified.
- Layout overlay (capture, presets, one-shot apply) tested on single-monitor
  GNOME 50.
