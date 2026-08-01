# Copyright (C) 2026 Apiratchai Lakkum
# SPDX-License-Identifier: GPL-2.0-or-later
#!/usr/bin/env python3
"""A window that maps, then resizes itself late -- mimics Firefox's
late-geometry behaviour on Wayland."""
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib

w = Gtk.Window(title='snapnine-race')
w.set_default_size(500, 400)
w.present()

def later():
    w.set_default_size(640, 1048)
    print('late resize applied', flush=True)
    return False

GLib.timeout_add(1500, later)
GLib.MainLoop().run()
