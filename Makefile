# SPDX-License-Identifier: GPL-2.0-or-later
# gnome-snapnine -- nine-position window snapping for GNOME Shell
#
#	make install	install for the current user
#	make uninstall	remove
#	make enable	enable in the running session
#	make disable	disable
#	make unit	geometry unit tests (no shell needed)
#	make live	live integration tests (extension must be enabled)
#	make zip	build snapnine.zip for manual install
#	make help	this text

UUID    = snapnine@github
EXTDIR  = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA  = org.gnome.shell.extensions.snapnine

FILES   = metadata.json extension.js rect.js prefs.js LICENSE NOTICE

.PHONY: install uninstall enable disable unit live zip help

zip:
	rm -f snapnine.zip
	rm -rf /tmp/snapnine-zip
	mkdir -p /tmp/snapnine-zip/schemas
	cp $(FILES) /tmp/snapnine-zip/
	cp schemas/$(SCHEMA).gschema.xml /tmp/snapnine-zip/schemas/
	(cd /tmp/snapnine-zip && zip -qr - .) > snapnine.zip
	rm -rf /tmp/snapnine-zip
	@echo "snapnine.zip ready: gnome-extensions install snapnine.zip"

install:
	mkdir -p $(EXTDIR)/schemas
	cp $(FILES) $(EXTDIR)/
	cp schemas/$(SCHEMA).gschema.xml $(EXTDIR)/schemas/
	glib-compile-schemas $(EXTDIR)/schemas
	@echo "installed in $(EXTDIR)"
	@echo "the shell only scans extensions at startup."
	@echo "log out and back in, then run: make enable (if not enabled already)"

uninstall:
	gnome-extensions disable $(UUID) 2>/dev/null || true
	rm -rf $(EXTDIR)
	@echo "removed"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

unit:
	gjs -m tests/unit.js

live:
	sh tests/test.sh

help:
	@sed -n '2,11p' Makefile
