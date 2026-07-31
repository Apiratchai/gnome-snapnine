#!/usr/bin/env python3
"""inject.py -- press a key combo on a virtual uinput keyboard."""
import sys, time
from evdev import UInput, ecodes as e

KEYS = {
    'super': e.KEY_LEFTMETA, 'ctrl': e.KEY_LEFTCTRL, 'shift': e.KEY_LEFTSHIFT,
    'alt': e.KEY_LEFTALT, 'left': e.KEY_LEFT, 'right': e.KEY_RIGHT,
    'up': e.KEY_UP, 'down': e.KEY_DOWN, 'm': e.KEY_M, 'h': e.KEY_H,
    'f8': e.KEY_F8, 'tab': e.KEY_TAB, 'enter': e.KEY_ENTER, 'q': e.KEY_Q,
    'kp7': e.KEY_KP7, 'kp9': e.KEY_KP9,
    '1': e.KEY_1, '2': e.KEY_2, '3': e.KEY_3, '4': e.KEY_4, '5': e.KEY_5,
    '6': e.KEY_6, '7': e.KEY_7, '8': e.KEY_8, '9': e.KEY_9, '0': e.KEY_0,
    'kp1': e.KEY_KP1, 'kp3': e.KEY_KP3,
}

def main():
    combo = sys.argv[1:]
    ui = UInput({e.EV_KEY: [e.KEY_LEFTMETA, e.KEY_LEFTCTRL, e.KEY_LEFTSHIFT,
                            e.KEY_LEFTALT, e.KEY_LEFT, e.KEY_RIGHT, e.KEY_UP,
                            e.KEY_DOWN, e.KEY_M, e.KEY_H, e.KEY_F8,
                            e.KEY_KP1, e.KEY_KP3, e.KEY_KP7, e.KEY_KP9,
                            e.KEY_1, e.KEY_2, e.KEY_3, e.KEY_4, e.KEY_5,
                            e.KEY_6, e.KEY_7, e.KEY_8, e.KEY_9, e.KEY_0,
                            e.KEY_TAB, e.KEY_ENTER, e.KEY_Q]},
                name='snapnine-injector')
    codes = [KEYS[k] for k in combo]
    for c in codes:
        ui.write(e.EV_KEY, c, 1)
    ui.syn()
    time.sleep(0.08)
    for c in codes:
        ui.write(e.EV_KEY, c, 0)
    ui.syn()
    time.sleep(0.1)
    ui.close()

if __name__ == '__main__':
    main()
