#!/usr/bin/env python3
"""Prueft die echte MediaPipe-Bibliothek gegen die Annahmen in camera.js.

camera.js verlaesst sich beim Zeichnen der Maschen auf Globale aus dem
MediaPipe-Bundle:

    window.FACEMESH_TESSELATION   etc.  ->  Zeichnen der Kanten
    window.FaceMesh               ->  Modell-Fabrik

Diese Datei laedt das Bundle einmal und prueft, ob die Namen wirklich als
Globale existieren, ob sie Paare [a, b] tragen und ob die Indizes in den
468 Landmarks liegen. Faellt der Download aus (kein Netz), wird SKIP
gemeldet und der Lauf nicht als Fehler gewertet — die restlichen Pruefungen
laufen offline weiter.
"""

import json
import re
import ssl
import subprocess
import sys
import urllib.request

URL = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js"
CONSTANTS = [
    "FACEMESH_TESSELATION",
    "FACEMESH_CONTOURS",
    "FACEMESH_FACE_OVAL",
    "FACEMESH_LIPS",
    "FACEMESH_LEFT_EYE",
    "FACEMESH_RIGHT_EYE",
    "FACEMESH_LEFT_EYEBROW",
    "FACEMESH_RIGHT_EYEBROW",
    "FACEMESH_LEFT_IRIS",
    "FACEMESH_RIGHT_IRIS",
]


def fail(msg):
    print(f"FAIL MediaPipe-CDN | {msg}")
    sys.exit(1)


def skip(msg):
    print(f"SKIP MediaPipe-CDN | {msg}")
    sys.exit(0)


def download():
    """zuerst curl (System-Zertifikate), sonst urllib mit macOS-CA-Datei."""
    try:
        out = subprocess.run(
            ["curl", "-fsSL", "--max-time", "20", URL],
            capture_output=True, check=True,
        )
        return out.stdout.decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 - Fallback unten
        pass
    ctx = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    with urllib.request.urlopen(URL, timeout=20, context=ctx) as res:
        return res.read().decode("utf-8", "replace")


try:
    src = download()
except Exception as exc:  # noqa: BLE001 - jede Netzstrecke ist ein SKIP
    skip(f"Bibliothek nicht ladbar ({exc})")

if len(src) < 10000:
    fail(f"unerwartet kleine Datei ({len(src)} Zeichen)")

# 1. Landen die Namen auf window? "var wa = this || self" + P(name, wert)
if not re.search(r"\bthis\s*\|\|\s*self", src):
    fail("Bundle benutzt kein this||self als Zielobjekt — Globale unsicher")
if not re.search(r"function P\(a,b\)", src):
    fail("Zuweisungsfunktion P() nicht gefunden")

missing = [c for c in CONSTANTS if f'P("{c}"' not in src]
if missing:
    fail("Konstanten fehlen im Bundle: " + ", ".join(missing))
if 'P("FaceMesh"' not in src and not re.search(r'P\("FaceMesh"', src):
    fail("FaceMesh wird nicht exportiert")

# 2. Form und Reichweite der Kantenlisten
def pairs_of(name, depth=0):
    """P("NAME", [[..]]) bzw. P("NAME", variable) aufloesen — auch wenn die
    Variable ihrerseits aus anderen Listen concat() wird (FACEMESH_CONTOURS)."""
    if depth > 4:
        fail(f"{name}: zu viele Verschachtelungen")
    m_arg = re.search(r'P\("%s"\s*,\s*(\[\[|\$?[A-Za-z_][\w$]*)' % re.escape(name), src)
    if m_arg:
        arg = m_arg.group(1)
        if arg == "[[":
            m = re.search(r"\[\[.*?\]\]", src[m_arg.start():], re.S)
            if not m:
                fail(f"{name}: Paarliste nicht gefunden")
            return _load(name, m.group(0))
        return _from_var(name, arg, depth)
    # Nicht direkt exportiert (Hilfsvariable) -> ueber Zuweisung suchen
    m_def = re.search(r"(?<![\w$])%s\s*=" % re.escape(name), src)
    if not m_def:
        fail(f"{name}: weder Export noch Zuweisung gefunden")
    return _from_var(name, name, depth)


def _load(name, text):
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        fail(f"{name}: Paarliste nicht lesbar ({exc})")
    if not isinstance(value, list) or not value:
        fail(f"{name}: leere Paarliste")
    return value


def _from_var(name, var, depth):
    var = var.lstrip("$")
    m_lit = re.search(r"(?<![\w$])%s\s*=\s*(\[\[.*?\]\])" % re.escape(var), src, re.S)
    if m_lit:
        return _load(name, m_lit.group(1))
    m_cat = re.search(
        r"(?<![\w$])%s\s*=\s*\[\]\.concat\("
        r"(\s*L\(\w+\)(?:\s*,\s*L\(\w+\))*\s*)\)" % re.escape(var),
        src,
    )
    if m_cat:
        parts = re.findall(r"L\((\w+)\)", m_cat.group(1))
        if not parts:
            fail(f"{name}: concat ohne erkennbare Teillisten")
        out = []
        for part in parts:
            out.extend(pairs_of(part, depth + 1))
        return out
    fail(f"{name}: Zuweisung von {var!r} ist weder Literal noch concat()")


report = []
for name in CONSTANTS:
    pairs = pairs_of(name)
    if not pairs:
        fail(f"{name}: leer")
    for pair in pairs[:50]:
        if not (isinstance(pair, list) and len(pair) == 2
                and all(isinstance(v, int) for v in pair)):
            fail(f"{name}: Eintrag ist kein [a, b]-Paar: {pair!r}")
    top = max(max(p) for p in pairs)
    report.append(f"{name}={len(pairs)}Paare/max{top}")
    if name.endswith("IRIS"):
        if top >= 478:
            fail(f"{name}: Index {top} liegt ausserhalb der Iris-Punkte (468..477)")
    elif top >= 468:
        fail(f"{name}: Index {top} liegt ausserhalb der 468 Landmarks")

print("PASS MediaPipe-CDN | " + ", ".join(report[:4]) + " …")
