#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Skeet dictation daemon.

Keeps NVIDIA Parakeet TDT 0.6B (sherpa-onnx, int8, CPU) loaded and, on
request, records the microphone, shows a live caption and types the final
text into the focused window with ydotool.

D-Bus (session): io.github.vdbxio.Skeet at /io/github/vdbxio/Skeet
  Toggle() Start() Stop() Cancel()   property State: idle|recording|transcribing
  DeleteLast()  backspace over the text it just typed
  PressEnter()  send Return
  Reload()      load the chosen model again (after a download or delete)
  signals StateChanged(s) Caption(s) Typed(s) Error(s)
          NeedsModel()  a recording was asked for but no model is installed

Settings come from the extension's GSettings schema (../schemas): model,
live-captions, noise-filter. Changing the model reloads it.

Names the model can't spell (products, people, jargon) go in the dictionary,
~/.config/skeet/dictionary.txt, applied to every caption and to the typed
text; it's re-read whenever it changes.

While recording, Silero VAD cuts the audio into utterances. Each finished
utterance is decoded once, for good; the one still being spoken is re-decoded
about once a second for the caption. On stop only that last piece is left to
decode, so the text lands quickly. Idle, nothing runs and the mic is closed.
"""

import argparse
import os
import queue
import re
import subprocess
import sys
import threading
import time
import warnings

import numpy as np
import sherpa_onnx
from gi.repository import Gio, GLib

warnings.filterwarnings("ignore", category=DeprecationWarning)

RATE = 16000
CHUNK = 1600  # 100 ms read from pw-record
VAD_WINDOW = 512
PAD = int(0.25 * RATE)  # context kept around each utterance when decoding
MAX_UTTERANCE = 25  # seconds of unbroken speech decoded as one piece
FRAME = 320  # 20 ms, for loudness
ABS_FLOOR = -55.0  # dBFS; quieter "speech" is never decoded
PRIOR_SLACK = 6.0  # dB the speaker may be quieter than in earlier recordings
FILTER_MARGINS = {"off": None, "low": 16.0, "medium": 12.5, "high": 9.0}
CAPTION_EVERY = 1.0  # seconds between live re-decodes (stretched if slow)
MAX_SECONDS = 300

BUS_NAME = "io.github.vdbxio.Skeet"
OBJ_PATH = "/io/github/vdbxio/Skeet"
IFACE_XML = f"""
<node>
  <interface name="{BUS_NAME}">
    <method name="Toggle"/>
    <method name="Start"/>
    <method name="Stop"/>
    <method name="Cancel"/>
    <method name="DeleteLast"/>
    <method name="PressEnter"/>
    <method name="Reload"/>
    <property name="State" type="s" access="read"/>
    <signal name="StateChanged"><arg type="s" name="state"/></signal>
    <signal name="Caption"><arg type="s" name="text"/></signal>
    <signal name="Typed"><arg type="s" name="text"/></signal>
    <signal name="Error"><arg type="s" name="message"/></signal>
    <signal name="NeedsModel"/>
  </interface>
</node>"""

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_DIR = os.path.join(HERE, "..", "schemas")
SCHEMA_ID = "org.gnome.shell.extensions.skeet"
DATA_DIR = os.path.join(GLib.get_user_data_dir(), "skeet")
sys.path.insert(0, HERE)
from models import MODELS  # noqa: E402  (the catalogue models.py downloads)
VAD_MODEL = os.path.join(DATA_DIR, "models", "silero_vad.onnx")
LEVEL_FILE = os.path.join(GLib.get_user_state_dir(), "skeet", "voice-level")
LAST_TAKE = os.path.join(GLib.get_user_state_dir(), "skeet", "last-take.wav")
DICT_FILE = os.path.join(GLib.get_user_config_dir(), "skeet", "dictionary.txt")
DICT_HEADER = """\
# Skeet dictionary: words the speech model doesn't spell the way you want.
#
# One entry per line:
#   Right Spelling = what Skeet types instead, another thing it types, ...
# Matching ignores case, and spaces, hyphens, apostrophes, underscores and
# dots inside a name, so "Pipe Wire", "pipewire" and "pipe-wire" are all one thing.
# An entry with nothing after it only fixes the capitals:
#   GitHub
# Lines starting with # are ignored. Changes apply to the next dictation.

"""

KEY_BACKSPACE = 14
KEY_ENTER = 28


def ydotool_socket():
    """$YDOTOOL_SOCKET, else the usual places ydotoold puts it."""
    if os.environ.get("YDOTOOL_SOCKET"):
        return os.environ["YDOTOOL_SOCKET"]
    for path in (os.path.join(GLib.get_user_runtime_dir(), ".ydotool_socket"),
                 "/tmp/.ydotool_socket"):
        if os.path.exists(path):
            return path
    return "/tmp/.ydotool_socket"

FILLERS = re.compile(r"(?i),?\s*(?<![\w'])(?:um+|uh+|uhm|erm|hmm+)(?![\w']),?")
ASCII_FIX = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"',
                           "–": "-", "—": " - ", "…": "...", " ": " "})


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def clean(parts):
    """Drop filler words, then join utterances, capitalising after a
    sentence end."""
    out = ""
    for p in parts:
        p = FILLERS.sub("", p).strip().lstrip(",.!? ")
        if not p:
            continue
        if not out or out[-1] in ".?!":
            p = p[:1].upper() + p[1:]
        out = f"{out} {p}" if out else p
    out = re.sub(r"\s+([,.?!])", r"\1", out)
    out = re.sub(r"(?<!\.)\.\.(?!\.)", ".", out)  # "here. Um." -> "here."
    out = re.sub(r"([.?!])\s*,", r"\1", out)
    # A filler removed mid-utterance can leave a sentence starting lowercase.
    out = re.sub(r"([.?!]\s+)([a-z])", lambda m: m[1] + m[2].upper(), out)
    return re.sub(r"\s{2,}", " ", out).strip()


class Dictionary:
    """Right spellings for names the model gets wrong, from DICT_FILE."""

    SEP = r"[\s\-_'’.]{0,2}"

    def __init__(self, path=DICT_FILE):
        self.path = path
        self.mtime = None
        self.regex = None
        self.fixes = {}

    @staticmethod
    def key(text):
        return re.sub(r"[\W_]+", "", text.lower())

    def _load(self):
        try:
            mtime = os.stat(self.path).st_mtime_ns
        except OSError:
            if not os.path.exists(os.path.dirname(self.path)):
                os.makedirs(os.path.dirname(self.path), exist_ok=True)
            try:
                with open(self.path, "x") as f:
                    f.write(DICT_HEADER)
            except OSError:
                pass
            mtime = None
        if mtime == self.mtime:
            return
        self.mtime, self.fixes = mtime, {}
        try:
            with open(self.path, encoding="utf-8") as f:
                lines = f.read().splitlines()
        except OSError:
            lines = []
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            right, _, heard = line.partition("=")
            right = right.strip()
            for alias in [right, *heard.split(",")]:
                k = self.key(alias)
                if right and k:
                    self.fixes[k] = right
        # Longest first, so "ms visual studio" wins over "visual studio".
        alts = [self.SEP.join(map(re.escape, k))
                for k in sorted(self.fixes, key=len, reverse=True)]
        self.regex = (re.compile(r"(?<![^\W_])(?:" + "|".join(alts) + r")(?![^\W_])", re.I)
                      if alts else None)
        log(f"skeetd: dictionary: {len(set(self.fixes.values()))} entries")

    def apply(self, text):
        try:
            self._load()
        except Exception as e:  # a bad dictionary must never stop dictation
            log(f"skeetd: dictionary not loaded: {e!r}")
        if not self.regex or not text:
            return text
        return self.regex.sub(lambda m: self.fixes.get(self.key(m[0]), m[0]), text)


def load_settings():
    try:
        src = Gio.SettingsSchemaSource.new_from_directory(
            SCHEMA_DIR, Gio.SettingsSchemaSource.get_default(), False)
        schema = src.lookup(SCHEMA_ID, False)
    except GLib.Error as e:
        log(f"skeetd: no settings schema ({e.message}); using defaults")
        return None
    return Gio.Settings.new_full(schema, None, None) if schema else None


def load_recognizer(model_dir, threads):
    if not os.path.exists(f"{model_dir}/encoder.int8.onnx"):
        raise FileNotFoundError(f"model not installed: {model_dir}")
    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=f"{model_dir}/encoder.int8.onnx",
        decoder=f"{model_dir}/decoder.int8.onnx",
        joiner=f"{model_dir}/joiner.int8.onnx",
        tokens=f"{model_dir}/tokens.txt",
        num_threads=threads,
        model_type="nemo_transducer",
        decoding_method="greedy_search")


def make_vad():
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = VAD_MODEL
    cfg.silero_vad.threshold = 0.45
    # Short pauses end an utterance, so the live re-decode stays short.
    cfg.silero_vad.min_silence_duration = 0.4
    cfg.silero_vad.min_speech_duration = 0.2
    cfg.silero_vad.max_speech_duration = 10
    cfg.silero_vad.window_size = VAD_WINDOW
    cfg.sample_rate = RATE
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=MAX_SECONDS + 30)


def ydotool(*args):
    env = dict(os.environ, YDOTOOL_SOCKET=ydotool_socket())
    r = subprocess.run(["ydotool", *args], env=env, capture_output=True, check=False)
    if r.returncode != 0:
        raise RuntimeError("ydotool failed: " +
                           (r.stderr.decode(errors="replace").strip() or f"exit {r.returncode}"))


def press_keys(code, times=1):
    if times > 0:
        ydotool("key", "--key-delay", "2", *[f"{code}:{v}" for _ in range(times) for v in (1, 0)])


def type_text(text):
    """Type into the focused window and return exactly what was typed.
    ydotool types ASCII; anything else is pasted through the clipboard,
    which is put back afterwards."""
    if not text:
        return ""
    text = text.translate(ASCII_FIX)
    if text.isascii():
        ydotool("type", "--key-delay", "4", "--key-hold", "2", "--", text)
        return text
    old = subprocess.run(["wl-paste", "--no-newline", "--type", "text"],
                         capture_output=True, timeout=2, check=False)
    subprocess.run(["wl-copy", "--", text], timeout=2, check=False)
    time.sleep(0.08)
    # Ctrl+V: KEY_LEFTCTRL=29, KEY_V=47
    ydotool("key", "29:1", "47:1", "47:0", "29:0")
    time.sleep(0.3)
    if old.returncode == 0:
        subprocess.run(["wl-copy"], input=old.stdout, timeout=2, check=False)
    else:  # it was empty (or not text): don't leave the dictation behind
        subprocess.run(["wl-copy", "--clear"], timeout=2, check=False)
    return text


class Session:
    """One recording: capture thread -> worker thread (VAD + decode)."""

    def __init__(self, daemon, wav=None):
        self.d = daemon
        self.rec = daemon.rec  # a model reload mid-recording can't swap it
        self.q = queue.Queue()
        self.stopping = threading.Event()
        self.cancelled = False
        self.wav = wav
        self.proc = None
        threading.Thread(target=self._capture, daemon=True).start()
        threading.Thread(target=self._work, daemon=True).start()

    def stop(self, cancel=False):
        self.cancelled = cancel
        self.stopping.set()

    # -- audio in --

    def _capture(self):
        try:
            if self.wav:
                import wave
                with wave.open(self.wav) as w:
                    while not self.stopping.is_set():
                        buf = w.readframes(CHUNK)
                        if not buf:
                            break
                        self.q.put(buf)
                        time.sleep(CHUNK / RATE)
                self.stopping.wait()
                return
            self.proc = subprocess.Popen(
                ["pw-record", "--raw", "--rate", str(RATE), "--channels", "1",
                 "--format", "s16", "--media-role", "Communication",
                 "--latency", "50ms", "-"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + MAX_SECONDS
            while not self.stopping.is_set():
                buf = self.proc.stdout.read(CHUNK * 2)
                if not buf:
                    break
                self.q.put(buf)
                if time.monotonic() > deadline:
                    GLib.idle_add(self.d.stop)
                    break
        finally:
            if self.proc:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
            self.q.put(None)

    # -- recognition --

    def _work(self):
        try:
            self._work_inner()
        except Exception as e:  # never leave the button stuck red
            log(f"skeetd: worker failed: {e!r}")
            GLib.idle_add(self.d.finished, self, "")

    def _work_inner(self):
        pipe = Pipeline(self.rec, self.d.filter_margin(), self.d.voice_level,
                        self.d.live_captions, self.d.dictionary)
        while True:
            try:
                buf = self.q.get(timeout=0.1)
            except queue.Empty:
                buf = b""
            if buf is None or (self.stopping.is_set() and self.cancelled):
                break
            if buf:
                pipe.feed(np.frombuffer(buf, np.int16).astype(np.float32) / 32768)
            if self.stopping.is_set():
                continue  # drain what was already captured
            caption = pipe.step()
            if caption is not None:
                GLib.idle_add(self.d.caption, self, caption)

        if self.cancelled:
            GLib.idle_add(self.d.finished, self, "")
            return
        GLib.idle_add(self.d.set_state, "transcribing")
        final = pipe.finish()
        if pipe.words and final:
            self.d.remember_level(pipe.voice_level())
        log(f"skeetd: {pipe.seconds:.1f}s -> {final!r}")
        if pipe.dropped or pipe.skipped:
            log(f"skeetd: noise filter dropped {' '.join(pipe.dropped).strip()!r}"
                f" and skipped {pipe.skipped:.1f}s of quiet speech")
        save_take(pipe.audio)
        GLib.idle_add(self.d.caption, self, final)
        typed = ""
        if final:
            try:
                typed = (final.translate(ASCII_FIX) if self.d.no_type
                         else type_text(final))
            except Exception as e:
                log(f"skeetd: typing failed: {e}")
                GLib.idle_add(self.d.error, f"Could not type the text: {e}. "
                              "Is the ydotool service running?")
        GLib.idle_add(self.d.finished, self, typed)


def save_take(audio):
    """Keep the last recording (only that one) so a bad transcript can be
    looked into with --test-file."""
    import wave
    try:
        os.makedirs(os.path.dirname(LAST_TAKE), exist_ok=True)
        with wave.open(LAST_TAKE, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
    except Exception as e:
        log(f"skeetd: could not keep the last take: {e!r}")


def level_db(samples):
    """Loudness of speech in a stretch of audio: the 90th percentile of
    20 ms frame RMS, in dBFS. Pauses inside the stretch don't drag it down."""
    n = len(samples) // FRAME
    if n == 0:
        return -100.0
    frames = samples[:n * FRAME].reshape(n, FRAME)
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    return float(20 * np.log10(np.percentile(rms, 90)))


class Pipeline:
    """Audio in, text out, for one recording; no threads or D-Bus, so it can
    also be run on a file (--test-file).

    1. Silero VAD cuts the audio into speech segments; only those are ever
       decoded, so silence, hum and clatter never reach the recogniser.
    2. Near-field filter. The speaker is much closer to the mic than a TV or
       other people, so their words are louder. Every recognised word gets a
       loudness from its own stretch of audio, and is compared with the
       speaker's level (the loud end of this recording's words, but never
       far below what earlier recordings established). Runs of two or more
       words more than `margin` dB quieter are dropped; a single quiet word
       between loud ones is kept, since people drop their voice on short
       words. Whole segments that quiet aren't even decoded.
    """

    def __init__(self, rec, margin, prior_level, live_captions, dictionary=None):
        self.rec = rec
        self.dictionary = dictionary
        self.margin = margin  # dB, or None for no near-field filter
        self.prior = prior_level  # dBFS from earlier recordings, or None
        self.live_captions = live_captions
        self.vad = make_vad()
        self.audio = np.zeros(0, np.float32)
        self.pending = np.zeros(0, np.float32)  # not yet fed to the VAD
        self.words = []  # (text, level dB) of finished segments, in order
        self.done_to = 0  # audio index up to which segments are final
        self.open_start = self.open_end = None  # speech held across VAD splits
        self.last_caption = 0.0
        self.caption_cost = 0.0
        self.shown = None
        self.dropped = []  # words the near-field filter took out
        self.skipped = 0  # seconds of speech too quiet to decode

    @property
    def seconds(self):
        return len(self.audio) / RATE

    def voice_level(self, extra=()):
        levels = [lv for _, lv in self.words] + [lv for _, lv in extra]
        here = float(np.percentile(levels, 90)) if levels else None
        if self.prior is None:
            return here
        floor = self.prior - PRIOR_SLACK
        return floor if here is None else max(here, floor)

    def _decode(self, start, end):
        """Words in audio[start:end] as (text, level dB)."""
        samples = self.audio[start:end]
        s = self.rec.create_stream()
        s.accept_waveform(RATE, samples)
        self.rec.decode_stream(s)
        r = s.result
        spans = []
        for tok, t, d in zip(r.tokens, r.timestamps, r.durations):
            if tok.startswith(" ") or not spans:
                spans.append([tok, t, t + d])
            else:  # word piece or punctuation: same word
                spans[-1][0] += tok
                spans[-1][2] = t + d
        return [(w, level_db(samples[max(0, int((a - 0.04) * RATE)):int((b + 0.04) * RATE)]))
                for w, a, b in spans]

    def _quiet(self, level, ref):
        return self.margin is not None and ref is not None and level < ref - self.margin

    def _filter(self, words):
        ref = self.voice_level(words[len(self.words):] if words is not self.words else ())
        quiet = [self._quiet(lv, ref) or lv < ABS_FLOOR for _, lv in words]
        keep, self.dropped = [], []
        for i, (w, _) in enumerate(words):
            run = quiet[i] and ((i > 0 and quiet[i - 1]) or (i + 1 < len(words) and quiet[i + 1]))
            if not run and not (quiet[i] and len(words) == 1):
                keep.append(w)
            else:
                self.dropped.append(w)
        text = clean(["".join(keep)])
        return self.dictionary.apply(text) if self.dictionary else text

    def feed(self, x):
        if not len(x):
            return
        self.audio = np.concatenate([self.audio, x])
        self.pending = np.concatenate([self.pending, x])
        while len(self.pending) >= VAD_WINDOW:
            self.vad.accept_waveform(self.pending[:VAD_WINDOW])
            self.pending = self.pending[VAD_WINDOW:]

    def _finish_segments(self, flush=False):
        while not self.vad.empty():
            seg = self.vad.front
            seg_start, seg_end = seg.start, seg.start + len(seg.samples)
            self.vad.pop()
            if self.open_start is None:
                self.open_start = seg_start
            self.open_end = seg_end
            # The VAD splits long speech without a pause, often mid-word;
            # keep such pieces together (up to MAX_UTTERANCE) so words
            # aren't cut in half.
            if (not flush and self.vad.is_speech_detected() and
                    seg_end - self.open_start < MAX_UTTERANCE * RATE):
                continue
            self._finalize()
        if flush and self.open_start is not None:
            self._finalize()

    def _speech_start(self, seg_start, level):
        """Silero can notice speech a second late when someone starts
        talking fast; walk back while the audio is still loud enough to be
        part of the same speech (until 0.2 s of quiet, at most 2 s)."""
        floor = level - 25.0
        lo = max(self.done_to, seg_start - 2 * RATE)
        i, quiet = seg_start, 0
        while i - FRAME >= lo and quiet < 10:
            frame = self.audio[i - FRAME:i]
            db = 20 * np.log10(np.sqrt(np.mean(frame ** 2)) + 1e-9)
            quiet = quiet + 1 if db < floor else 0
            i -= FRAME
        return i + quiet * FRAME

    def _finalize(self):
        seg_start, seg_end = self.open_start, self.open_end
        self.open_start = self.open_end = None
        level = level_db(self.audio[seg_start:seg_end])
        start = max(self._speech_start(seg_start, level) - PAD, self.done_to)
        end = min(seg_end + PAD, len(self.audio))
        # Don't spend a decode on a segment that is clearly background.
        if level > ABS_FLOOR and not self._quiet(level, self.voice_level()):
            self.words += self._decode(start, end)
        else:
            self.skipped += (end - start) / RATE
        self.done_to = end

    def step(self):
        """Process what has arrived; returns a new caption, or None."""
        self._finish_segments()
        now = time.monotonic()
        text = None
        if (self.live_captions() and self.vad.is_speech_detected() and
                now - self.last_caption >= max(CAPTION_EVERY, 2 * self.caption_cost)):
            self.last_caption = now
            live = self._decode(self.done_to, len(self.audio))
            self.caption_cost = time.monotonic() - now
            text = self._filter(self.words + live)
        elif self.words:
            text = self._filter(self.words)
        if text is None or text == self.shown:
            return None
        self.shown = text
        return text

    def finish(self):
        if len(self.pending):
            self.vad.accept_waveform(np.concatenate(
                [self.pending, np.zeros(VAD_WINDOW - len(self.pending), np.float32)]))
        self.vad.flush()
        self._finish_segments(flush=True)
        # A very short take the VAD never confirmed: decode it anyway.
        if not self.words and len(self.audio) - self.done_to > 0.3 * RATE:
            self.words = self._decode(self.done_to, len(self.audio))
        return self._filter(self.words)


class Daemon:
    def __init__(self, args):
        self.no_type = args.no_type
        self.wav = args.wav
        self.threads = args.threads
        self.state = "idle"
        self.session = None
        self.conn = None
        self.rec = None
        self.model = None
        self.last_typed = ""
        self.loading = False
        self.settings = load_settings()
        self.dictionary = Dictionary()
        self.voice_level = self._read_level()
        if self.settings:
            self.settings.connect("changed::model", lambda *_: self.load_model())
        self.load_model(block=True)

    def filter_margin(self):
        nick = self.settings.get_string("noise-filter") if self.settings else "medium"
        return FILTER_MARGINS.get(nick, FILTER_MARGINS["medium"])

    def _read_level(self):
        try:
            with open(LEVEL_FILE) as f:
                return float(f.read())
        except (OSError, ValueError):
            return None

    def remember_level(self, level):
        """Keep a slow average of the speaker's level across recordings, so
        the filter works from the first word next time."""
        if level is None:
            return
        old = self.voice_level
        self.voice_level = level if old is None else 0.7 * old + 0.3 * level
        try:
            os.makedirs(os.path.dirname(LEVEL_FILE), exist_ok=True)
            with open(LEVEL_FILE, "w") as f:
                f.write(f"{self.voice_level:.1f}\n")
        except OSError as e:
            log(f"skeetd: could not save voice level: {e}")

    def live_captions(self):
        return self.settings.get_boolean("live-captions") if self.settings else True

    def load_model(self, block=False, force=False):
        """(Re)load the model chosen in settings, in a thread unless block."""
        nick = self.settings.get_string("model") if self.settings else "parakeet-v2-en"
        if (nick == self.model and not force) or self.loading:
            return
        model_dir = os.path.join(DATA_DIR, "models",
                                 MODELS.get(nick, MODELS["parakeet-v2-en"])["dir"])

        def work():
            t = time.monotonic()
            try:
                rec = load_recognizer(model_dir, self.threads)
                s = rec.create_stream()  # warm up
                s.accept_waveform(RATE, np.zeros(RATE, np.float32))
                rec.decode_stream(s)
            except Exception as e:
                log(f"skeetd: could not load {nick}: {e}")
                GLib.idle_add(self._loaded, None, nick, str(e))
                return
            log(f"skeetd: {nick} ready in {time.monotonic() - t:.1f}s")
            GLib.idle_add(self._loaded, rec, nick, None)

        self.loading = True
        if block:
            work()  # _loaded runs once the main loop starts
        else:
            threading.Thread(target=work, daemon=True).start()

    def _loaded(self, rec, nick, err):
        self.loading = False
        if rec:
            self.rec, self.model = rec, nick
        else:
            self.rec = self.model = None  # e.g. it was just deleted
        # The choice may have changed again while this one was loading.
        if self.settings and self.settings.get_string("model") != self.model and rec:
            self.load_model()

    # -- state --

    def set_state(self, state):
        if state == self.state:
            return
        self.state = state
        log(f"skeetd: {state}")
        if self.conn:
            self.conn.emit_signal(None, OBJ_PATH, BUS_NAME, "StateChanged",
                                  GLib.Variant("(s)", (state,)))
            self.conn.emit_signal(None, OBJ_PATH, "org.freedesktop.DBus.Properties",
                                  "PropertiesChanged", GLib.Variant(
                                      "(sa{sv}as)",
                                      (BUS_NAME, {"State": GLib.Variant("s", state)}, [])))

    def caption(self, session, text):
        if session is self.session and self.conn:
            self.conn.emit_signal(None, OBJ_PATH, BUS_NAME, "Caption",
                                  GLib.Variant("(s)", (text,)))

    def error(self, message):
        log(f"skeetd: error: {message}")
        if self.conn:
            self.conn.emit_signal(None, OBJ_PATH, BUS_NAME, "Error",
                                  GLib.Variant("(s)", (message,)))

    def finished(self, session, typed):
        if session is self.session:
            self.session = None
            self.last_typed = typed
            self.set_state("idle")
            if typed and self.conn:
                self.conn.emit_signal(None, OBJ_PATH, BUS_NAME, "Typed",
                                      GLib.Variant("(s)", (typed,)))

    def start(self):
        if self.state != "idle":
            return
        if not self.rec:
            if self.loading:
                self.error("The speech model is still loading; try again in a moment.")
            elif self.conn:
                self.conn.emit_signal(None, OBJ_PATH, BUS_NAME, "NeedsModel", None)
            return
        self.last_typed = ""
        self.session = Session(self, self.wav)
        self.set_state("recording")

    def _keys(self, code, times):
        """Send keys off the main loop; only while idle."""
        if self.state != "idle" or times <= 0:
            return
        if self.no_type:
            log(f"skeetd: (no-type) key {code} x{times}")
            return

        def work():
            try:
                press_keys(code, times)
            except Exception as e:
                GLib.idle_add(self.error, f"Could not send keys: {e}")
        threading.Thread(target=work, daemon=True).start()

    def delete_last(self):
        n, self.last_typed = len(self.last_typed), ""
        self._keys(KEY_BACKSPACE, n)

    def press_enter(self):
        self.last_typed = ""
        self._keys(KEY_ENTER, 1)

    def stop(self, cancel=False):
        if self.state == "recording" and self.session:
            self.session.stop(cancel)

    def toggle(self):
        if self.state == "idle":
            self.start()
        elif self.state == "recording":
            self.stop()
        # transcribing: ignore; it's about to type

    # -- D-Bus --

    def _on_call(self, conn, sender, path, iface, method, params, inv):
        {"Toggle": self.toggle, "Start": self.start, "Stop": self.stop,
         "Cancel": lambda: self.stop(cancel=True),
         "DeleteLast": self.delete_last, "PressEnter": self.press_enter,
         "Reload": lambda: self.load_model(force=True)}[method]()
        inv.return_value(None)

    def _on_get(self, conn, sender, path, iface, prop):
        return GLib.Variant("s", self.state)

    def run(self):
        node = Gio.DBusNodeInfo.new_for_xml(IFACE_XML)
        loop = GLib.MainLoop()

        def acquired(conn, _name):
            self.conn = conn
            log("skeetd: on the bus")

        def bus(conn, _name):
            conn.register_object(OBJ_PATH, node.interfaces[0],
                                 self._on_call, self._on_get, None)

        Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
                         bus, acquired, lambda *_: loop.quit())
        for sig in (2, 15):
            GLib.unix_signal_add(GLib.PRIORITY_HIGH, sig, loop.quit)
        loop.run()
        if self.session:
            self.session.stop(cancel=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=3)
    ap.add_argument("--no-type", action="store_true", help="don't type the result (testing)")
    ap.add_argument("--wav", help="use this 16 kHz mono WAV instead of the mic (testing)")
    ap.add_argument("--test-file", nargs="+", metavar="WAV",
                    help="transcribe WAVs through the full pipeline and exit")
    ap.add_argument("--filter", choices=list(FILTER_MARGINS),
                    help="with --test-file: noise filter strength")
    ap.add_argument("--level", type=float, help="with --test-file: prior voice level")
    args = ap.parse_args()
    if args.test_file:
        return test_files(args)
    Daemon(args).run()


def test_files(args):
    import wave
    rec = load_recognizer(os.path.join(DATA_DIR, "models", MODELS["parakeet-v2-en"]["dir"]),
                          args.threads)
    margin = FILTER_MARGINS[args.filter or "medium"]
    for path in args.test_file:
        with wave.open(path) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        pipe = Pipeline(rec, margin, args.level, lambda: False, Dictionary())
        for i in range(0, len(x), CHUNK):
            pipe.feed(x[i:i + CHUNK])
            pipe.step()
        text = pipe.finish()
        lvl = pipe.voice_level()
        print(f"{os.path.basename(path)} [voice {lvl if lvl is None else round(lvl, 1)} dB]"
              f"\n  {text}", flush=True)
        if pipe.dropped or pipe.skipped:
            print(f"  dropped {' '.join(pipe.dropped).strip()!r},"
                  f" skipped {pipe.skipped:.1f}s", flush=True)


if __name__ == "__main__":
    main()
