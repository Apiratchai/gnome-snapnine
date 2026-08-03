#!/usr/bin/env python3
# Copyright (C) 2026 Apiratchai Lakkum
# SPDX-License-Identifier: GPL-2.0-or-later
"""Window that unmaps and remaps itself after 3s.  Mutter re-places
remapped windows at the default centered position; the snap must be
re-asserted (Firefox does this during page load)."""
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib

w = Gtk.Window(title='snapnine-remap')
w.set_default_size(500, 400)
w.present()

def hide_it():
    w.hide()
    GLib.timeout_add(600, show_it)
    return False

def show_it():
    w.present()
    return False

GLib.timeout_add(3000, hide_it)
GLib.MainLoop().run()
