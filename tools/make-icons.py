#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Draw Skeet's dancing parrot: an original, party-coloured parrot in 10
frames (icons/parrot-00.svg ... parrot-09.svg). Frame 0 is the idle icon.

    python3 tools/make-icons.py
"""
import colorsys
import math
import os

FRAMES = 10
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")


def hexcolor(h, s, v):
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"


def frame(i):
    t = i / FRAMES
    hue = 0.33 + t  # starts green, cycles through the rainbow
    body, belly, wing = hexcolor(hue, 0.75, 0.92), hexcolor(hue + 0.08, 0.45, 1.0), hexcolor(hue - 0.06, 0.85, 0.72)
    # The head swings in a circle while the body sways: the "party" dance.
    sway = 6 * math.sin(2 * math.pi * t)
    hx, hy = 50 + 9 * math.cos(2 * math.pi * t), 36 + 5 * math.sin(2 * math.pi * t)
    tilt = 14 * math.cos(2 * math.pi * t)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <g transform="rotate({sway:.2f} 50 92)">
    <path d="M30 92 C24 70 30 52 50 48 C70 52 76 70 70 92 Z" fill="{body}"/>
    <path d="M40 90 C37 74 42 62 50 60 C58 62 63 74 60 90 Z" fill="{belly}"/>
    <path d="M31 70 C26 80 30 88 38 90 C36 80 36 74 31 70 Z" fill="{wing}"/>
    <path d="M69 70 C74 80 70 88 62 90 C64 80 64 74 69 70 Z" fill="{wing}"/>
  </g>
  <g transform="rotate({tilt:.2f} {hx:.2f} {hy:.2f})">
    <path d="M{hx - 4:.2f} {hy - 20:.2f} q-6 -9 -2 -14 q3 6 6 9 q0 -8 5 -11 q0 8 2 13 z" fill="{wing}"/>
    <circle cx="{hx:.2f}" cy="{hy:.2f}" r="19" fill="{body}"/>
    <path d="M{hx + 12:.2f} {hy - 4:.2f} q14 2 12 14 q-5 -5 -12 -4 z" fill="#f6c343" stroke="#7a5a12" stroke-width="1.2"/>
    <circle cx="{hx + 4:.2f}" cy="{hy - 4:.2f}" r="6.2" fill="#ffffff"/>
    <circle cx="{hx + 5.5:.2f}" cy="{hy - 4:.2f}" r="3.4" fill="#111111"/>
    <circle cx="{hx + 6.5:.2f}" cy="{hy - 5.2:.2f}" r="1.1" fill="#ffffff"/>
    <circle cx="{hx - 6:.2f}" cy="{hy + 6:.2f}" r="3.5" fill="#ff7aa8" opacity="0.7"/>
  </g>
</svg>
"""


os.makedirs(OUT, exist_ok=True)
for i in range(FRAMES):
    with open(os.path.join(OUT, f"parrot-{i:02d}.svg"), "w") as f:
        f.write(frame(i))
print(f"wrote {FRAMES} frames to {os.path.normpath(OUT)}")
