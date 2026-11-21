#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="hw-monitor-widget@userpowers.local"
LIB_DIR="${HOME}/.local/lib/hw-monitor-widget"
EXT_DEST="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
CONFIG_DIR="${HOME}/.config/hw-monitor-widget"

install -d "${LIB_DIR}" "${EXT_DEST}" "${CONFIG_DIR}" \
  "${HOME}/.config/systemd/user" "${HOME}/.config/autostart"

install -m 644 "${ROOT}/extension/metadata.json" "${EXT_DEST}/"
install -m 644 "${ROOT}/extension/extension.js" "${EXT_DEST}/"
install -m 644 "${ROOT}/extension/widget.js" "${EXT_DEST}/"
install -m 644 "${ROOT}/extension/stylesheet.css" "${EXT_DEST}/"

install -m 755 "${ROOT}/scripts/collect_daemon.py" "${LIB_DIR}/collect_daemon.py"
install -m 755 "${ROOT}/scripts/nvidia-query.sh" "${LIB_DIR}/nvidia-query.sh"
install -m 755 "${ROOT}/scripts/enable-hw-monitor-widget.sh" "${LIB_DIR}/enable-hw-monitor-widget.sh"

ZIP="/tmp/hw-monitor-widget-$$.zip"
rm -f "${ZIP}"
(
  cd "${ROOT}/extension"
  zip -qr "${ZIP}" .
)
if command -v gnome-extensions >/dev/null 2>&1; then
  if ! gnome-extensions install --force "${ZIP}"; then
    echo "gnome-extensions install failed; extension files were still copied to ${EXT_DEST}." >&2
  fi
fi
rm -f "${ZIP}"

if [[ ! -f "${CONFIG_DIR}/settings.json" ]]; then
  install -m 644 "${ROOT}/config/settings.json.example" "${CONFIG_DIR}/settings.json"
fi

install -m 644 "${ROOT}/systemd/hw-monitor-collect.service" \
  "${HOME}/.config/systemd/user/hw-monitor-collect.service"

systemctl --user daemon-reload
systemctl --user enable --now hw-monitor-collect.service

cat >"${HOME}/.config/autostart/hw-monitor-widget.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=HW Monitor Widget
Comment=Enable HW Monitor Widget GNOME extension
Exec=${LIB_DIR}/enable-hw-monitor-widget.sh
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Phase=Applications
EOF

if command -v gnome-extensions >/dev/null 2>&1; then
  "${LIB_DIR}/enable-hw-monitor-widget.sh" || true
fi

echo "Installed ${UUID}."
echo "Collector: systemctl --user status hw-monitor-collect.service"
echo "On a first install, log out and back in once so GNOME Shell loads the extension."
