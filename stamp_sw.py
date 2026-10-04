#!/usr/bin/env python3
"""Schreibt den Build-Stempel in den Service Worker.

Warum das noetig ist:
Die Cache-Namen des Service Workers tragen eine Versionsnummer. Steht dort
immer dieselbe, behaelt der Browser nach einem Deploy die alten Dateien.
Mit einem Stempel pro Build raeumt der Service Worker beim Start alle
Caches ab, die nicht zum aktuellen Build gehoeren — die Nutzer bekommen
also zuverlaessig den neuen Stand.

Als Quelle dient der Commit-Hash, den der Hosting-Anbieter setzt
(RENDER_GIT_COMMIT). Fehlt er, wird ein Zeitstempel genommen, damit auch
lokale Docker-Builds eindeutig bleiben.

Aufruf:  python3 stamp_sw.py
"""

import os
import re
import subprocess
import sys
from datetime import datetime, timezone

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "sw.js")


def build_stamp() -> str:
    """Commit-Hash bevorzugen, sonst Zeitstempel."""
    commit = os.environ.get("RENDER_GIT_COMMIT") or os.environ.get("GIT_COMMIT") or ""
    if not commit:
        try:
            commit = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                capture_output=True, text=True, timeout=10,
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            commit = ""
    if commit:
        # Nur Zeichen, die in einem Cache-Namen unproblematisch sind
        return "".join(c for c in commit if c.isalnum())[:12] or "local"
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def main() -> int:
    if not os.path.exists(TARGET):
        print(f"FEHLER: {TARGET} nicht gefunden", file=sys.stderr)
        return 1

    stamp = build_stamp()
    with open(TARGET, encoding="utf-8") as fh:
        text = fh.read()

    # Bewusst als Regex auf die ganze Zeile: der Befehl darf wiederholt
    # laufen, ohne dass "__BUILD__" oder ein alter Stempel stehen bleibt.
    pattern = re.compile(r"^const VERSION = '.*';.*$", re.MULTILINE)
    if not pattern.search(text):
        print("FEHLER: Keine VERSION-Zeile in static/sw.js gefunden", file=sys.stderr)
        return 1

    text = pattern.sub(f"const VERSION = '{stamp}';", text, count=1)

    with open(TARGET, "w", encoding="utf-8") as fh:
        fh.write(text)

    print(f"Service-Worker-Version auf '{stamp}' gesetzt")
    return 0


if __name__ == "__main__":
    sys.exit(main())