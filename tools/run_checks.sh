#!/bin/sh
# ============================================================
# Aestra-Checks ausfuehren (statisch + echter Browser).
#
#   ./tools/run_checks.sh
#
# Benoetigt: python3 mit esprima (pip3 install esprima) und Google Chrome.
# Kein Node, kein npm.
#
# Schritte:
#   1. statisch      — Syntax, i18n-Paritaet, Messkarten-Schluessel
#   2. Browser       — echtes camera.js mit synthetischen Landmarks
#   3. CDN           — echte MediaPipe-Konstanten
#   4. E2E           — echtes CDN + echte Kamera + echte Landmarks
#                      (wird uebersprungen, wenn das Netz fehlt)
#
# Exit-Code 0 = alles gruen, 1 = mindestens ein FAIL.
# ============================================================
set -e
cd "$(dirname "$0")/.."

echo "== 1. Statische Pruefungen =="
STATIC_FAILED=0
python3 tools/check_syntax.py || STATIC_FAILED=1

echo
echo "== 2. Browser-Pruefungen (echtes camera.js) =="
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
    echo "SKIP - Chrome nicht gefunden unter: $CHROME"
    exit 1
fi

PORT=8931
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
sleep 1

# Seite in Chrome laden und das <pre id="out"> auswerten.
# $1 = Pfad, $2 = virtual-time-budget, $3 = Timeout-Sekunden
run_page() {
    OUT="/tmp/aestra_browser_$$.html"
    PROF="/tmp/aestra_chrome_$$"
    # perl-alarm schuetzt davor, dass ein haengender Chrome das Skript blockiert.
    perl -e 'alarm shift; exec @ARGV' "$3" \
        "$CHROME" --headless=new --disable-gpu --no-sandbox \
            --virtual-time-budget="$2" --hide-scrollbars \
            --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
            --user-data-dir="$PROF" \
            --dump-dom "http://127.0.0.1:$PORT$1" \
            > "$OUT" 2>/dev/null || true
    python3 - "$OUT" <<'PY' || return 1
import html, re, sys

src = open(sys.argv[1], encoding="utf-8", errors="replace").read()
m = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', src, re.S)
if not m:
    print('FAIL Browser-Check | Ausgabefeld <pre id="out"> nicht gefunden '
          '(Chrome-Ausgabe leer oder Seite nicht geladen)')
    sys.exit(1)

body = html.unescape(m.group(1)).strip()
print(body)
lines = [l for l in body.splitlines() if l.startswith(("PASS ", "FAIL "))]
fails = [l for l in lines if l.startswith("FAIL")]
print(f"\n{len(lines)} Pruefungen: {len(lines) - len(fails)} PASS, {len(fails)} FAIL")
sys.exit(1 if fails else 0)
PY
}

BROWSER_FAILED=0
run_page "/tools/check_browser.html" 2500 45 || BROWSER_FAILED=1

echo
echo "== 3. MediaPipe-Bibliothek (echtes CDN) =="
CDN_FAILED=0
python3 tools/check_mediapipe_cdn.py || CDN_FAILED=1

echo
echo "== 4. End-to-End (echtes CDN + echte Kamera) =="
E2E_FAILED=0
run_page "/tools/check_browser.html?e2e=1" 40000 120 || E2E_FAILED=1

kill "$SERVER_PID" 2>/dev/null || true
rm -rf "/tmp/aestra_chrome_$$"

if [ "$STATIC_FAILED" -ne 0 ] || [ "$BROWSER_FAILED" -ne 0 ] || \
   [ "$CDN_FAILED" -ne 0 ] || [ "$E2E_FAILED" -ne 0 ]; then
    echo
    echo "=> mindestens eine Pruefung fehlgeschlagen."
    exit 1
fi
echo
echo "=> alles gruen."
