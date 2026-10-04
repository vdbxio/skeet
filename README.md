<p align="center"><img src="icons/parrot.gif" width="120" alt="Party Parrot"></p>

# Skeet

Touchscreen dictation for GNOME on Wayland. A floating parrot button sits
above your windows: tap it, talk, tap again, and the text is typed wherever
your cursor is. Speech recognition runs offline on your own computer.

- **Tap** to start and stop. **Drag** to move it; it snaps to the nearest side.
- While recording the parrot **dances** inside a **red** ring; the ring turns
  **amber** while the last words are transcribed.
- A **live caption** beside the button shows what it has heard so far.
- **Delete** (above the button) and **Enter** (below it) appear for a few
  seconds after each dictation. Delete backspaces over exactly the text that
  was just typed; Enter presses Return. They hide when you tap one, start a
  new recording, move the button, switch windows or workspaces, or change
  the screen layout.
- A **background noise filter** drops words that are much quieter than your
  own voice, like a TV or people across the room.
- Tapping never takes keyboard focus away from the text field.

Made for a tablet with no keyboard, but it works on any GNOME desktop.

## Requirements

- GNOME Shell 50 on **Wayland**
- PipeWire (`pw-record`), Python 3.10+ with PyGObject (`python3-gobject` /
  `python3-gi`) and `venv`, `curl`
- **ydotool** with its daemon running and its socket writable by you
  (see below); this is what types the text
- `wl-clipboard` (optional, for text with accents or symbols)
- About 1.5 GB of disk and RAM for a speech model. While you talk it uses
  roughly one CPU core; when idle, none, and the microphone is closed.

## Install

Download `skeet-<version>.zip` from the
[releases](https://github.com/vdbxio/skeet/releases) and unzip it, or clone
the repo, then run the install script from that folder:

    unzip skeet-0.1.0.zip -d skeet && cd skeet
    sh install.sh

Log out and back in, enable **Skeet** in the Extensions app (or
`gnome-extensions enable skeet@vdbxio.github.io`), then open its settings and
**download a speech model**:

| Model        | Languages                                    | Download |
|--------------|----------------------------------------------|----------|
| English      | English (NVIDIA Parakeet TDT 0.6B v2)        | 482 MB   |
| Multilingual | 25 European languages (Parakeet TDT 0.6B v3) | 487 MB   |

Nothing large is downloaded until you tap **Download**. Models are checked
against a SHA-256 checksum, can be cancelled and retried, and can be deleted
again from the same page.

`install.sh` links the folder as an extension and runs `helper/setup.sh`,
which needs no root and only touches your home folder:

- a Python venv with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and
  the 0.6 MB Silero voice-activity detector in `~/.local/share/skeet/`
- a user service `skeet.service` (D-Bus `io.github.vdbxio.Skeet`)
- the command `~/.local/bin/skeet`

You can also run Setup from the settings window.

### Setting up ydotool

ydotool sends key presses through `/dev/uinput`, so its daemon runs as root
and must hand you its socket. Install it (`sudo dnf install ydotool`,
`sudo apt install ydotool`), then give the daemon a socket you own:

    sudo systemctl edit ydotool

and add (use your own `id -u` / `id -g` instead of 1000):

    [Service]
    ExecStart=
    ExecStart=/usr/bin/ydotoold --socket-path=/run/user/1000/.ydotool_socket --socket-own=1000:1000

then `sudo systemctl enable --now ydotool`. Skeet looks for the socket in
`$YDOTOOL_SOCKET`, then `$XDG_RUNTIME_DIR/.ydotool_socket`, then
`/tmp/.ydotool_socket`. (Some distributions name the unit `ydotoold`.)

## Keyboard shortcut / macro pad

Add a custom shortcut (Settings → Keyboard → Keyboard Shortcuts) running

    ~/.local/bin/skeet --toggle

Also available: `--start`, `--stop`, `--cancel`, `--delete`, `--enter`.

## Background noise filter

Your mouth is much closer to the microphone than the TV, so your words are
louder. Skeet measures the loudness of every recognised word and drops runs
of words that are much quieter than your voice (which it learns over your
first few dictations). Settings → Background noise: **Medium** (default)
removes a TV that is about 13 dB or more quieter than you at the
microphone; **High** is stricter but can drop your own quiet trailing words;
**Low** keeps more. A TV as loud as your own voice can't be told apart by
loudness. Turning on your microphone's noise suppression (for example
PipeWire's WebRTC echo-cancel module) helps with steady noise like fans.

## Your own button image

Put PNG or SVG frames in `~/.local/share/skeet/icon/` (sorted by name, e.g.
`frame-00.png` …) and log out and back in: the first frame is the idle
image and the button cycles through all of them while recording.

## How it works

- `extension.js`: the button, caption bubble and Delete/Enter (GNOME Shell,
  GJS). It only talks to the service over D-Bus; nothing blocks the Shell.
- `prefs.js`: the settings window, Setup, model downloads.
- `helper/skeetd.py`: the service. Keeps the model loaded, records with
  `pw-record`, cuts speech out with Silero VAD, filters background words by
  loudness, re-decodes the current phrase about once a second for the
  caption, and on stop types the final text with `ydotool` (non-ASCII text
  is pasted via the clipboard, which is put back). Filler words (um, uh)
  are dropped.
- `helper/models.py`: model catalogue, checksummed downloads, delete.
- `helper/setup.sh`: engine setup, safe to re-run.

Logs: `journalctl --user -u skeet`. After editing `extension.js`, log out
and back in (Wayland); after editing `helper/skeetd.py`,
`systemctl --user restart skeet`. Run the recogniser on a recording with
`~/.local/share/skeet/venv/bin/python helper/skeetd.py --test-file file.wav`.

## Uninstall

    systemctl --user disable --now skeet
    rm -rf ~/.local/share/skeet ~/.local/state/skeet ~/.config/systemd/user/skeet.service \
        ~/.local/share/dbus-1/services/io.github.vdbxio.Skeet.service \
        ~/.local/bin/skeet ~/.local/share/gnome-shell/extensions/skeet@vdbxio.github.io

## Licence

MIT, see `LICENSE`, except the parrot: Party Parrot from
[cultofthepartyparrot.com](https://cultofthepartyparrot.com), based on
Sirocco the kākāpō. The parrot images in `icons/` are not covered by the MIT
licence (see `NOTICE`). Speech models are downloaded separately from the
sherpa-onnx releases under their own licences (Parakeet: CC-BY-4.0, NVIDIA;
Silero VAD: MIT).
