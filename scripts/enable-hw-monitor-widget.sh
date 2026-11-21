#!/usr/bin/env bash
# Enable HW monitor extension (run inside a GNOME session; safe at login).
set -euo pipefail

UUID="hw-monitor-widget@userpowers.local"

command -v gnome-extensions >/dev/null || exit 0

# Ubuntu sometimes sets this after updates and then blocks every user extension.
if [[ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null || true)" == "true" ]]; then
  gsettings set org.gnome.shell disable-user-extensions false
fi

if ! gnome-extensions info "$UUID" >/dev/null 2>&1; then
  exit 0
fi

gnome-extensions enable "$UUID"
