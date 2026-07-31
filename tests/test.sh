#!/bin/sh
# test.sh -- live integration tests for snapnine.
#
# Requires:
#   - the extension enabled in the running GNOME Shell
#   - a graphical session (spawns kitty and zenity windows)
#
# Drives the extension over its D-Bus interface and verifies exact
# geometry for every position, plus the edge cases:
#   toggle-restore, maximize->snap, minimize, fullscreen guard,
#   dialog guard, unknown window, builtin-shortcut shield, rebind.
#
# Exit status: 0 if all tests pass, 1 otherwise.

set -u

DEST=org.gnome.Shell
IFACE=org.gnome.Shell.Extensions.Snapnine
PATH_=/org/gnome/shell/extensions/snapnine
EXT=snapnine@github
EXTDIR=$HOME/.local/share/gnome-shell/extensions/$EXT
# our schema lives with the extension; the shell finds it, plain gsettings does not
GS="gsettings --schemadir $EXTDIR/schemas"

pass=0
fail=0

ok()  { pass=$((pass + 1)); echo "PASS  $1"; }
bad() { fail=$((fail + 1)); echo "FAIL  $1"; }

check() { # check <description> <expected> <actual>
    if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi
}

call() { # call <method> <args...> -- print raw D-Bus reply
    method=$1
    shift
    gdbus call --session --dest "$DEST" --object-path "$PATH_" \
        --method "$IFACE.$method" "$@" 2>/dev/null
}

# value -- strip the gdbus reply wrapper: ('value',) -> value
value() {
    sed -e 's/^(//' -e 's/)$//' -e 's/,$//' -e "s/^'//" -e "s/'$//"
}

window_state() { # window_state <id>
    call GetWindowState "snapnine-test-$1" | value
}

# wait_window <id> -- poll until the test window exists and its
# geometry is stable (10s max).  Snapping a still-animating window
# races the map animation and gives flaky results.
wait_window() {
    n=0
    prev=""
    while [ $n -lt 50 ]; do
        state=$(window_state "$1")
        if [ "$state" != gone ] && [ -n "$state" ]; then
            cur=$(call GetWindowRect "snapnine-test-$1" | value)
            if [ -n "$prev" ] && [ "$cur" = "$prev" ]; then
                return 0
            fi
            prev=$cur
        fi
        n=$((n + 1))
        sleep 0.2
    done
    return 1
}

# spawn_window <id> -- a fresh terminal titled snapnine-test-<id>
spawn_window() {
    if command -v kitty >/dev/null 2>&1; then
        kitty --title "snapnine-test-$1" >/dev/null 2>&1 &
    else
        ptyxis -T "snapnine-test-$1" >/dev/null 2>&1 &
    fi
}

kill_window() {
    pkill -f "snapnine-test-$1" 2>/dev/null
    sleep 0.3
}

# expected rects from the window's own work area
expect_rects() { # expect_rects <id> -- sets expect_* and wa_*
    wa=$(call GetMonitorWorkArea "snapnine-test-$1" | value)
    set -- $wa
    wx=$1; wy=$2; ww=$3; wh=$4
    hw=$((ww / 2))
    hh=$((wh / 2))
    expect_left="$wx $wy $hw $wh"
    expect_right="$((wx + hw)) $wy $((ww - hw)) $wh"
    expect_up="$wx $wy $ww $hh"
    expect_down="$wx $((wy + hh)) $ww $((wh - hh))"
    expect_tl="$wx $wy $hw $hh"
    expect_tr="$((wx + hw)) $wy $((ww - hw)) $hh"
    expect_bl="$wx $((wy + hh)) $hw $((wh - hh))"
    expect_br="$((wx + hw)) $((wy + hh)) $((ww - hw)) $((wh - hh))"
    expect_maximize="$wa"
}

# want_var <position> -- echo the expect_* variable name for a position
want_var() {
    case $1 in
        top-left)    echo expect_tl ;;
        top-right)   echo expect_tr ;;
        bottom-left) echo expect_bl ;;
        bottom-right) echo expect_br ;;
        *)           echo "expect_$1" ;;
    esac
}

# test_position <position> -- fresh window, move, snap, verify, kill
test_position() {
    id=$((id + 1))
    spawn_window "$id"
    if ! wait_window "$id"; then
        bad "window $id never appeared"
        return
    fi
    sleep 0.5
    call MoveWindow "snapnine-test-$id" 200 200 600 400 >/dev/null
    sleep 0.3
    call SnapWindow "snapnine-test-$id" "$1" >/dev/null
    sleep 0.5
    actual=$(call GetWindowRect "snapnine-test-$id" | value)
    eval "want=\$expect_$1"
    check "snap $1" "$want" "$actual"
    kill_window "$id"
}

# ---------------------------------------------------------------- setup

echo "== snapnine live tests =="

if [ -z "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]; then
    echo "no display; run from inside the graphical session"
    exit 1
fi

if ! gnome-extensions info "$EXT" 2>/dev/null | grep -q 'State: ACTIVE'; then
    echo "extension $EXT is not enabled; run: make enable"
    exit 1
fi

if ! gdbus introspect --session --dest "$DEST" --object-path "$PATH_" \
    >/dev/null 2>&1; then
    echo "D-Bus interface $IFACE not found; is the extension loaded?"
    exit 1
fi

echo "monitors: $(call GetMonitors | value)"

# ------------------------------------------------------- nine positions

id=0
for pos in left right up down top-left top-right bottom-left bottom-right maximize; do
    id=$((id + 1))
    spawn_window "$id"
    if ! wait_window "$id"; then
        bad "window $id never appeared"
        continue
    fi
    sleep 0.5
    expect_rects "$id"
    call MoveWindow "snapnine-test-$id" 200 200 600 400 >/dev/null
    sleep 0.3
    call SnapWindow "snapnine-test-$id" "$pos" >/dev/null
    sleep 0.5
    actual=$(call GetWindowRect "snapnine-test-$id" | value)
    eval "want=\$$(want_var "$pos")"
    check "snap $pos" "$want" "$actual"
    kill_window "$id"
done

# ------------------------------------------------------- edge cases

# toggle: second press restores previous geometry
id=$((id + 1))
spawn_window "$id"
if wait_window "$id"; then
    sleep 0.5
    call MoveWindow "snapnine-test-$id" 200 200 600 400 >/dev/null
    sleep 0.3
    call SnapWindow "snapnine-test-$id" left >/dev/null
    sleep 0.5
    call SnapWindow "snapnine-test-$id" left >/dev/null
    sleep 0.5
    check "toggle restores geometry" "200 200 600 400" \
        "$(call GetWindowRect "snapnine-test-$id" | value)"
    kill_window "$id"
else
    bad "toggle window never appeared"
fi

# maximize then snap left: unmaximize path
id=$((id + 1))
spawn_window "$id"
if wait_window "$id"; then
    sleep 0.5
    call SnapWindow "snapnine-test-$id" maximize >/dev/null
    sleep 0.5
    check "maximize state" "maximized" "$(window_state "$id")"
    expect_rects "$id"
    call SnapWindow "snapnine-test-$id" left >/dev/null
    sleep 0.5
    check "maximize -> snap left" "$expect_left" \
        "$(call GetWindowRect "snapnine-test-$id" | value)"
    kill_window "$id"
else
    bad "maximize window never appeared"
fi

# restore: separate action -- float the window centered
id=$((id + 1))
spawn_window "$id"
if wait_window "$id"; then
    sleep 0.3
    expect_rects "$id"
    rw=$((ww * 3 / 5)); rh=$((wh * 4 / 5))
    expect_restore="$((wx + (ww - rw) / 2)) $((wy + (wh - rh) / 2)) $rw $rh"
    call MoveWindow "snapnine-test-$id" 200 200 600 400 >/dev/null
    sleep 0.3
    call SnapWindow "snapnine-test-$id" maximize >/dev/null
    sleep 0.5
    call SnapWindow "snapnine-test-$id" restore >/dev/null
    sleep 0.5
    check "restore from maximized floats centered" "$expect_restore" \
        "$(call GetWindowRect "snapnine-test-$id" | value)"
    call SnapWindow "snapnine-test-$id" left >/dev/null
    sleep 0.5
    call SnapWindow "snapnine-test-$id" restore >/dev/null
    sleep 0.5
    check "restore after snap floats centered" "$expect_restore" \
        "$(call GetWindowRect "snapnine-test-$id" | value)"
    kill_window "$id"
else
    bad "restore window never appeared"
fi

# minimize
id=$((id + 1))
spawn_window "$id"
if wait_window "$id"; then
    sleep 0.5
    call SnapWindow "snapnine-test-$id" minimize >/dev/null
    sleep 0.5
    check "minimize state" "minimized" "$(window_state "$id")"
    kill_window "$id"
else
    bad "minimize window never appeared"
fi

# fullscreen guard: snap must not touch a fullscreen window
id=$((id + 1))
spawn_window "$id"
if wait_window "$id"; then
    sleep 0.5
    call SetFullscreen "snapnine-test-$id" true >/dev/null
    sleep 0.5
    before=$(call GetWindowRect "snapnine-test-$id" | value)
    call SnapWindow "snapnine-test-$id" left >/dev/null
    sleep 0.5
    check "fullscreen state kept" "fullscreen" "$(window_state "$id")"
    check "fullscreen geometry kept" "$before" \
        "$(call GetWindowRect "snapnine-test-$id" | value)"
    call SetFullscreen "snapnine-test-$id" false >/dev/null
    kill_window "$id"
else
    bad "fullscreen window never appeared"
fi

# dialog guard: a zenity dialog must be left alone
zenity --question --title=snapnine-dialog >/dev/null 2>&1 &
sleep 1
if call GetWindowState snapnine-dialog | value >/dev/null 2>&1 \
   && [ "$(call GetWindowState snapnine-dialog | value)" != gone ]; then
    before=$(call GetWindowRect snapnine-dialog | value)
    call SnapWindow snapnine-dialog left >/dev/null
    sleep 0.3
    check "dialog geometry kept" "$before" \
        "$(call GetWindowRect snapnine-dialog | value)"
    pkill -f snapnine-dialog 2>/dev/null
else
    bad "dialog window never appeared"
    pkill -f snapnine-dialog 2>/dev/null
fi

# unknown window: SnapWindow reports not found, no crash
found=$(call SnapWindow snapnine-no-such-window left | value)
check "unknown window reports false" "false" "$found"

# ------------------------------------------------------- configuration

# multi-binding: two accelerators for one action; the second must work
# (and the builtin app-switcher Super+2 must be shielded away)
orig_down=$($GS get org.gnome.shell.extensions.snapnine snap-down)
$GS set org.gnome.shell.extensions.snapnine snap-down "['<Super>Down', '<Super>2']"
sleep 0.5
id=$((id + 1))
spawn_window "$id"
if wait_window "$id"; then
    sleep 0.3
    expect_rects "$id"
    python3 "$(dirname "$0")/inject.py" super 2
    sleep 0.8
    check "second accelerator (<Super>2) snaps down" "$expect_down" \
        "$(call GetWindowRect "snapnine-test-$id" | value)"
    kill_window "$id"
else
    bad "multi-binding window never appeared"
fi
$GS set org.gnome.shell.extensions.snapnine snap-down "$orig_down"
sleep 0.5

# rebind: changing a shortcut must not break the extension
orig_left=$($GS get org.gnome.shell.extensions.snapnine snap-left)
$GS set org.gnome.shell.extensions.snapnine snap-left "['<Super><Ctrl>Left']"
sleep 0.5
if gdbus introspect --session --dest "$DEST" --object-path "$PATH_" \
    >/dev/null 2>&1; then
    ok "rebind keeps extension alive"
else
    bad "rebind killed the D-Bus interface"
fi
$GS set org.gnome.shell.extensions.snapnine snap-left "$orig_left"
sleep 0.5

# shield: a colliding built-in shortcut is disabled, then restored
orig_builtin=$(gsettings get org.gnome.mutter.keybindings toggle-tiled-left)
gsettings set org.gnome.mutter.keybindings toggle-tiled-left "['<Super>Left']"
gnome-extensions disable "$EXT" >/dev/null 2>&1
sleep 1
gnome-extensions enable "$EXT" >/dev/null 2>&1
sleep 1
check "builtin shortcut shielded" "@as []" \
    "$(gsettings get org.gnome.mutter.keybindings toggle-tiled-left)"
gnome-extensions disable "$EXT" >/dev/null 2>&1
sleep 1
check "builtin shortcut restored" "['<Super>Left']" \
    "$(gsettings get org.gnome.mutter.keybindings toggle-tiled-left)"
gsettings set org.gnome.mutter.keybindings toggle-tiled-left "$orig_builtin"
gnome-extensions enable "$EXT" >/dev/null 2>&1
sleep 1

# ---------------------------------------------------------------- done

pkill -f "snapnine-test-" 2>/dev/null
pkill -f snapnine-dialog 2>/dev/null

echo ""
echo "$pass passed, $fail failed"
if [ $fail -gt 0 ]; then
    echo "LIVE TESTS FAILED"
    exit 1
fi
echo "live tests ok"
exit 0

# ------------------------------------------------- key delivery (real keys)

# Press Super+Left on a virtual uinput keyboard; the focused window
# must snap to the left half.  Needs python3-evdev; skipped otherwise.
if python3 -c 'import evdev' >/dev/null 2>&1; then
    id=$((id + 1))
    spawn_window "$id"
    if wait_window "$id"; then
        sleep 0.5
        expect_rects "$id"
        python3 "$(dirname "$0")/inject.py" super left
        sleep 0.8
        check "keypress Super+Left snaps focused window" "$expect_left" \
            "$(call GetWindowRect "snapnine-test-$id" | value)"
        kill_window "$id"
    else
        bad "keypress test window never appeared"
    fi
else
    echo "SKIP  keypress test (python3-evdev not installed)"
fi

# ------------------------------------------------- late client resize

# The Wayland client is authoritative for its own size: a window that
# resizes itself after being snapped must be re-asserted (the
# Firefox-on-Wayland bug, tiling-assistant #421).  race.py maps at
# 500x400, then resizes to 640x1048 after 1.5s.
if python3 -c 'import gi; gi.require_version("Gtk", "4.0")' >/dev/null 2>&1; then
    python3 "$(dirname "$0")/race.py" >/dev/null 2>&1 &
    sleep 1.2
    id=$((id + 1))
    if [ "$(call GetWindowState snapnine-race | value)" != gone ]; then
        expect_rects race
        call SnapWindow snapnine-race left >/dev/null
        sleep 3.5     # past the late resize at t+1.5s
        check "late client resize re-asserted" "$expect_left" \
            "$(call GetWindowRect snapnine-race | value)"
    else
        bad "race window never appeared"
    fi
    pkill -f "tests/race.p[y]" 2>/dev/null
    pkill -f "/tmp/race.p[y]" 2>/dev/null
else
    echo "SKIP  late-resize test (python3-gi not installed)"
fi
