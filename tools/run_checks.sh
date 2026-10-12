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
#   2b. Preview      — echtes recommender.js mit synthetischen Looks
#   2c. Kamera       — Kamera-Start ohne camera_utils (Fallback-Loop)
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
echo "== 2b. Eigenes Empfehlungsmodell (recommender.js, ohne Server) =="
run_page "/tools/check_reco.html" 3000 45 || BROWSER_FAILED=1

echo
echo "== 2c. Kamera ohne camera_utils (Fallback-Loop) =="
run_page "/tools/check_ownloop.html" 6000 45 || BROWSER_FAILED=1

echo
echo "== 3. MediaPipe-Bibliothek (echtes CDN) =="
CDN_FAILED=0
python3 tools/check_mediapipe_cdn.py || CDN_FAILED=1

echo
echo "== 4. End-to-End (echtes CDN + echtes Gesichtsfoto) =="
# Laeuft NICHT ueber --dump-dom: die Seite braucht das echte Modell
# (WASM + tflite vom CDN) und meldet sich deshalb selbst per POST
# beim Pruef-Server tools/check_server.py.
E2E_FAILED=0
E2E_PORT=8932
E2E_RESULT="$(pwd)/tools/.e2e-result.txt"
E2E_PROF="/tmp/aestra_e2e_$$"
rm -f "$E2E_RESULT"

python3 tools/check_server.py "$E2E_PORT" >/dev/null 2>&1 &
E2E_SERVER_PID=$!
sleep 1

# WICHTIG: KEIN --disable-gpu hier. MediaPipe rechnet ueber WebGL und
# haengt sonst ewig im send() — es kommt nie ein Ergebnis vom Browser.
perl -e 'alarm shift; exec @ARGV' 150 \
    "$CHROME" --headless=new --no-sandbox \
        --hide-scrollbars \
        --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
        --user-data-dir="$E2E_PROF" \
        "http://127.0.0.1:$E2E_PORT/tools/check_e2e.html" \
        >/dev/null 2>&1 || true &
CHROME_PID=$!

# Auf das Endergebnis warten (hoechstens 120 s), statt Chrome
# durchzublockieren: die Seite schickt ihr TOTAL selbst per POST.
i=0
while ! grep -q '^TOTAL ' "$E2E_RESULT" 2>/dev/null && [ "$i" -lt 120 ]; do
    sleep 1
    i=$((i + 1))
done

kill "$CHROME_PID" 2>/dev/null || true
kill "$E2E_SERVER_PID" 2>/dev/null || true
rm -rf "$E2E_PROF"

if [ ! -s "$E2E_RESULT" ] || ! grep -q '^TOTAL ' "$E2E_RESULT"; then
    echo "FAIL E2E-Check | kein Ergebnis vom Browser (Netz oder CDN nicht erreichbar?)"
    E2E_FAILED=1
else
    # Vom letzten TOTAL an ausgeben (daeventuelle LOG-Zeilen davor).
    E2E_TEXT=$(awk '/^TOTAL /{n=NR} {a[NR]=$0} END{for(i=n;i<=NR;i++) print a[i]}' "$E2E_RESULT")
    echo "$E2E_TEXT"
    printf '%s\n' "$E2E_TEXT" | grep -q '^FAIL ' && E2E_FAILED=1
fi
rm -f "$E2E_RESULT"

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
