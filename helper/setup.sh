#!/bin/bash
# SPDX-License-Identifier: MIT
# Skeet first-run setup: the speech engine and its user service.
# Safe to re-run. No root needed. It does not download a speech model;
# pick and download one in Skeet's settings (or: helper/models.py download ID).
#
# Progress lines start with "STEP:", problems with "ERROR:" or "WARNING:";
# the preferences window shows them as they come.
set -uo pipefail

HELPER=$(cd "$(dirname "$0")" && pwd)
EXT=$(dirname "$HELPER")
DATA=${XDG_DATA_HOME:-$HOME/.local/share}/skeet
CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}
RELEASES=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models
[ $# -eq 0 ] || { echo "usage: setup.sh" >&2; exit 2; }

step() { echo "STEP: $*"; }
fail() { echo "ERROR: $*"; exit 1; }
warn() { echo "WARNING: $*"; }

step "Checking requirements"
command -v python3 >/dev/null || fail "python3 is not installed."
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' ||
    fail "Python 3.10 or newer is needed (found $(python3 -V 2>&1))."
python3 -c 'import gi' 2>/dev/null ||
    fail "PyGObject is missing. Install it: Fedora: sudo dnf install python3-gobject · Debian/Ubuntu: sudo apt install python3-gi"
python3 -c 'import venv, ensurepip' 2>/dev/null ||
    fail "Python venv support is missing. Debian/Ubuntu: sudo apt install python3-venv"
command -v pw-record >/dev/null ||
    fail "pw-record (PipeWire) is missing. Fedora: sudo dnf install pipewire-utils · Debian/Ubuntu: sudo apt install pipewire-bin"
command -v curl >/dev/null || fail "curl is not installed."
command -v wl-copy >/dev/null ||
    warn "wl-clipboard is not installed; text with accents or symbols can't be typed. Fedora/Debian/Ubuntu: install wl-clipboard"

step "Installing the speech engine (Python venv + sherpa-onnx) in $DATA/venv"
mkdir -p "$DATA/models"
if [ ! -x "$DATA/venv/bin/python" ] || ! "$DATA/venv/bin/python" -c 'import gi' 2>/dev/null; then
    rm -rf "$DATA/venv"
    python3 -m venv --system-site-packages "$DATA/venv" || fail "Could not create the Python venv."
fi
if ! "$DATA/venv/bin/python" -c 'import sherpa_onnx, numpy' 2>/dev/null; then
    "$DATA/venv/bin/python" -m pip --version >/dev/null 2>&1 ||
        "$DATA/venv/bin/python" -m ensurepip --default-pip >/dev/null ||
        fail "Could not set up pip in the venv."
    "$DATA/venv/bin/python" -m pip install --quiet --disable-pip-version-check sherpa-onnx numpy ||
        fail "Could not install sherpa-onnx with pip (no network, or no wheel for this Python)."
fi
"$DATA/venv/bin/python" -c 'import sherpa_onnx, numpy, gi' || fail "The speech engine did not import cleanly."

if [ -t 2 ]; then PROGRESS=--progress-bar; else PROGRESS=-sS; fi
download() {  # url, file
    curl -fL $PROGRESS -o "$2.part" "$1" && mv "$2.part" "$2"
}
if [ ! -f "$DATA/models/silero_vad.onnx" ]; then
    step "Downloading the voice-activity detector (Silero VAD, 0.6 MB)"
    download "$RELEASES/silero_vad.onnx" "$DATA/models/silero_vad.onnx" ||
        fail "Download failed: silero_vad.onnx"
    echo "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6  $DATA/models/silero_vad.onnx" |
        sha256sum --check --quiet ||
        { rm -f "$DATA/models/silero_vad.onnx"; fail "silero_vad.onnx is corrupt (checksum mismatch); run Setup again."; }
fi
step "Installing the background service"
mkdir -p "$CONFIG/systemd/user" "${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services" "$HOME/.local/bin"
cat > "$CONFIG/systemd/user/skeet.service" <<UNIT
[Unit]
Description=Skeet dictation service
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=dbus
BusName=io.github.vdbxio.Skeet
ExecStart="$DATA/venv/bin/python" "$HELPER/skeetd.py"
Restart=on-failure
RestartSec=2

[Install]
WantedBy=graphical-session.target
UNIT
cat > "${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services/io.github.vdbxio.Skeet.service" <<DBUS
[D-BUS Service]
Name=io.github.vdbxio.Skeet
Exec=/bin/false
SystemdService=skeet.service
DBUS
chmod +x "$HELPER/skeet" "$HELPER/skeetd.py" "$HELPER/models.py"
ln -sf "$HELPER/skeet" "$HOME/.local/bin/skeet"
systemctl --user daemon-reload || fail "systemctl --user is not available."
systemctl --user enable skeet.service >/dev/null 2>&1
systemctl --user restart skeet.service || fail "The service did not start; see: journalctl --user -u skeet"

step "Checking ydotool (used to type the text)"
if ! command -v ydotool >/dev/null; then
    fail "ydotool is not installed, so the text can't be typed. Fedora: sudo dnf install ydotool · Debian/Ubuntu: sudo apt install ydotool. See the README for starting its service."
fi
sock=${YDOTOOL_SOCKET:-}
if [ -z "$sock" ]; then
    for s in "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/.ydotool_socket" /tmp/.ydotool_socket; do
        [ -S "$s" ] && { sock=$s; break; }
    done
fi
if [ -z "$sock" ] || [ ! -S "$sock" ]; then
    fail "ydotool is installed but its service (ydotoold) isn't running. See \"Setting up ydotool\" in the README."
fi
if [ ! -w "$sock" ]; then
    fail "The ydotool socket $sock isn't writable by you. Start ydotoold with --socket-own=$(id -u):$(id -g); see the README."
fi
if ls "$DATA/models"/sherpa-onnx-*/encoder.int8.onnx >/dev/null 2>&1; then
    step "Done. Tap the Skeet button to dictate."
else
    step "Engine ready. Now download a speech model below."
fi
