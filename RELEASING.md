# Releasing Skeet

Skeet is MIT-licensed, which extensions.gnome.org (EGO) accepts.
Releases are GitHub releases on [vdbxio/skeet](https://github.com/vdbxio/skeet).

## Making a release

1. Bump `version` in `metadata.json` (an integer) and pick a tag `vX.Y.Z`.
2. Build the zip (it never contains models or recordings):

       glib-compile-schemas schemas
       gnome-extensions pack --force --extra-source=helper --extra-source=icons \
           --extra-source=LICENSE --extra-source=NOTICE --extra-source=install.sh --extra-source=README.md .
       mv skeet@vdbxio.github.io.shell-extension.zip skeet-X.Y.Z.zip

3. `gh release create vX.Y.Z skeet-X.Y.Z.zip --title "Skeet X.Y.Z" --notes-file NOTES.md`

## extensions.gnome.org: what review would likely reject today

EGO reviews every upload against its
[review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html).

1. **Downloading and running code.** Setup `pip install`s sherpa-onnx (native
   ONNX Runtime libraries) and runs it. Extensions may not download or install
   executable code. (Model *data* downloaded only when the user taps Download,
   with a checksum, is much less of a problem.)
2. **A bundled Python helper.** Reviewers expect GJS. An essential helper in
   another language running as a background service is usually sent back
   with a request to ship it separately.
3. **Installing system integration.** `setup.sh` writes a systemd user unit,
   a D-Bus activation file and `~/.local/bin/skeet`.

## Options

**A. Extension on EGO, engine packaged separately.** The extension (GJS only:
`extension.js`, `prefs.js`, schemas, icons) goes to EGO and only *checks* for
the engine, linking to install instructions. The engine (`helper/`) ships as a
Fedora COPR RPM depending on `ydotool`, `pipewire-utils` and `python3-gobject`,
plus a PyPI package (`pipx install skeet-engine`) for other distributions.
Flatpak fits poorly: ydotool needs `/dev/uinput` and the host session bus.
Discoverable and auto-updating, but two installs and more packaging work.

**B. GitHub releases plus the install script.** What we do now: one zip, one
`sh install.sh`. Works today and we control the pace; users must find it,
and updates are manual.

## Recommendation

Stay on **B** while Skeet is GNOME-50-only and has few users. Once it has
worked for a few other people, split the engine into a COPR package (Fedora
first), then submit the GJS-only extension to EGO (**A**).
