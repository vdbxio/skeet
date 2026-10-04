#!/bin/sh
# SPDX-License-Identifier: MIT
# Install Skeet from a git checkout or an unpacked release.
# Links this folder as the GNOME Shell extension, then runs the speech
# engine setup (helper/setup.sh). No root needed; see README for ydotool.
set -e
here=$(cd "$(dirname "$0")" && pwd)
uuid=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' "$here/metadata.json")
ext=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid

glib-compile-schemas "$here/schemas"
mkdir -p "$(dirname "$ext")"
if [ "$(readlink -f "$ext")" != "$here" ]; then
    rm -rf "$ext"
    ln -s "$here" "$ext"
fi
bash "$here/helper/setup.sh" "$@"

echo
echo "Now log out and back in, then enable it:  gnome-extensions enable $uuid"
