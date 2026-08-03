# gnome-snapnine

Window snapping for GNOME Shell, designed around the numpad.

Nine positions: halves, quarters, maximize (the whole work area),
plus restore (float centered) and minimize. Every action has its own
shortcut, and you can give each action several shortcuts.

## The numpad layout

```
  7 8 9      top-left     top-half     top-right
  4 5 6      left         maximize     right
  1 2 3      bottom-left  bottom-half  bottom-right
```

No numpad? Bind anything else. The layout is one array in rect.js.
Adding a position means touching rect.js, the schema, and the
prefs dialog; the tests then cover it.

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

Inspired by [Tiling Assistant](https://github.com/ubuntu/Tiling-Assistant),
which I used for two years. It is a good extension. It has one bug I
could not live with: snap a freshly opened Firefox window and it lands
in the middle of the screen instead of where you pointed it, and you
have to press the key two or three times.

The symptom was reported against Tiling Assistant as
[issue #421](https://github.com/ubuntu/Tiling-Assistant/issues/421),
filed by their user jumbled00r. That user is not me. I only suspect we
share the same issue. The issue was still open when this extension was
written. A similar report exists for KWin
([KDE bug 473594](https://bugs.kde.org/show_bug.cgi?id=473594)), so
the cause is not specific to GNOME.

The cause, in plain words: on Wayland the app controls its own window
size. Firefox opens a window, then loads content and resizes itself a
moment later. If the snap happens in between, the late resize wins and
the window is left in a neutral spot. GNOME's built-in tiling survives
this because mutter has an internal tile constraint, which extensions
cannot use.

gnome-snapnine works around it from the outside: it waits for the
window to settle before snapping, then watches the geometry and
re-applies the snap if the app overrides it, including when a window
unmaps and remaps (mutter re-places remapped windows at the center).
The window always ends up where you told it to go.

## Honest notes

- The code was written with DeepSeek Flash (0731) in about one hour,
  for $0.361. I am not a maintainer and do not plan to be. Expect
  rough edges.
- There is a test suite to compensate: 28 geometry unit tests (plain
  gjs) and a live suite that drives real windows over D-Bus and
  presses real keys through uinput. Run `make unit` and `make live`.
- Tested on GNOME Shell 50.3 / mutter 50.3, Wayland, Fedora.

## Install

Two ways. The zip is easier. The git way is for people who want the
source.

### Way 1: release zip (recommended)

1. Download the zip:
   https://github.com/Apiratchai/gnome-snapnine/releases/download/v11/snapnine.zip
2. Install it:

       gnome-extensions install snapnine.zip

3. Log out and back in. The GNOME shell only looks for new extensions
   at login, so this step is required the first time.
4. Done. Press Super+Left on any window to test.

### Way 2: from git

    git clone https://github.com/Apiratchai/gnome-snapnine.git
    cd gnome-snapnine
    make install    # installs to ~/.local/share/gnome-shell/extensions, no sudo

Then log out and back in once (the shell only scans extensions at
startup). After login, enable it if it did not enable itself:

    make enable

To remove: `gnome-extensions disable snapnine@github`, then delete
the folder ~/.local/share/gnome-shell/extensions/snapnine@github.

## Configuration with gsettings

The settings dialog (Extensions → snapnine) covers everything, but
gsettings works too. The schema lives with the extension, and plain
gsettings cannot see it. Pass --schemadir:

    gsettings --schemadir \
        ~/.local/share/gnome-shell/extensions/snapnine@github/schemas \
        set org.gnome.shell.extensions.snapnine snap-left \
        "['<Super>Left', '<Super>KP_4']"

Every action accepts several accelerators. An empty array disables the
shortcut. If a shortcut is already taken by a built-in GNOME
keybinding (for example Super+2, the app switcher), snapnine leaves
it alone and tells you which app owns the key. Rebind snapnine's
shortcut or change the other one. If an action has several
accelerators and one is taken, the whole action is skipped until the
conflict is resolved. No other part of the GNOME configuration is
ever modified.

## Scripting (D-Bus)

The D-Bus interface exists for the test suite: GNOME 50 has no remote
way to drive the shell (the old eval channel is gone), so the
extension exposes its operations on the session bus and tests/test.sh
drives them. A side effect is that scripts can tile windows too. For
example, open a terminal (the title must match exactly):

    ptyxis -T Terminal

(that is Fedora's terminal. On Ubuntu, Debian, Mint use
`gnome-terminal --title Terminal`, on classic X11 setups
`xterm -title Terminal`.) Then snap it to the left half:

    gdbus call --session \
        --dest org.gnome.Shell \
        --object-path /org/gnome/shell/extensions/snapnine \
        --method org.gnome.Shell.Extensions.Snapnine.SnapWindow \
        Terminal left

Methods:

    SnapWindow(title, position)     -> found
    MoveWindow(title, x, y, w, h)   -> found
    GetWindowRect(title)            -> "x y w h" | gone
    GetWindowState(title)           -> normal|minimized|maximized|fullscreen|gone
    GetMonitorWorkArea(title)       -> "x y w h" | gone
    SetFullscreen(title, full)      -> found
    GetMonitors()                   -> count

Position (SnapWindow, MoveWindow uses x/y/w/h instead):

| Position | Snap to |
|---|---|
| left / right | left / right half |
| up / down | top / bottom half |
| top-left, top-right, bottom-left, bottom-right | quarters |
| maximize / restore / minimize | work area / float centered / hide |

The live test suite (tests/test.sh) drives the same interface.

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

## Testing

    make unit    # geometry checks, no shell needed
    make live    # full suite: real windows, D-Bus, injected keypresses

## License

GPL-2.0-or-later (see LICENSE).  This project was developed with
reference to tiling-assistant by Leleat (GPL-2.0-or-later); the
specific borrowings are credited in the code comments and in NOTICE.
SPDX headers mark all source and build files; metadata.json is the
one exception because JSON cannot carry comments.

## Adopted from tiling-assistant

- **Ignore-move workaround.** Some windows do not follow
  move_resize_frame(user_op=true) at all. tiling-assistant hit this
  with GNOME Terminal; we reproduced it with zenity dialogs. Their
  current workaround (upstream main) is used here: move_frame first,
  then move_resize_frame, with user_op=true to avoid multi-monitor
  clamping (their issue #137). On top of that we keep a
  verify-and-retry-once safety net for windows that ignore the
  request entirely. The live suite asserts dialogs obey MoveWindow.
- **Unmaximize-first ordering.** snap() unmaximizes before the resize
  gate, so the gate needs no maximized-window exception. Their
  ordering is subtler than the explicit escape hatch we had; we use
  theirs.

Both are credited to tiling-assistant by Leleat; see NOTICE.

## Scope

- Tested on GNOME Shell 50.3, mutter 50.3, Wayland, Fedora, single
  monitor.
- GNOME 51 and multi-monitor setups are not yet verified.
