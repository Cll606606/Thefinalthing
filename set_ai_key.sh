#!/bin/bash
# ============================================================================
#  GEMINI_API_KEY in Render eintragen — ohne den Schluessel zu uebertragen
# ============================================================================
#  Warum es diese Datei gibt:
#  Der Schluessel darf NICHT in app.py und NICHT in render.yaml stehen. Beim
#  Kopieren in app.py landet er beim naechsten "git add -A" im Repository und
#  GitHub blockt den Push. Der Schluessel gehoert in die .env (lokal) oder in
#  das Environment-Feld des Anbieters (online). Beide Orte sind nicht Teil
#  des Codes.
#
#  Aufruf:  ./set_ai_key.sh
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

if [ $# -eq 1 ]; then
    KEY="$1"
else
    # -s: unsichtbar, damit der Schluessel nicht im Terminalverlauf steht
    read -r -s -p "GEMINI_API_KEY (Eingabe bleibt unsichtbar): " KEY
    echo
fi

if [ -z "$KEY" ]; then
    echo "Kein Schluessel eingegeben. Abbruch."
    exit 1
fi

# ---- 1) lokal: .env aktualisieren -------------------------------------------
python3 - "$KEY" <<'PY'
import re, sys, os
key = sys.argv[1]
path = ".env"
text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
if re.search(r"^GEMINI_API_KEY=", text, re.M):
    text = re.sub(r"^GEMINI_API_KEY=.*$", "GEMINI_API_KEY=" + key, text, flags=re.M)
else:
    text = text.rstrip("\n") + "\nGEMINI_API_KEY=" + key + "\n"
open(path, "w", encoding="utf-8").write(text)
os.chmod(path, 0o600)
print("  .env aktualisiert (nur lokal, steht in .gitignore)")
PY

# ---- 2) Gegenprobe ----------------------------------------------------------
# certifi wird bewusst benutzt: urllib.request nutzt den Zertifikatsspeicher
# des Betriebssystems und meldet sonst SSL-Fehler, die gar keine sind.
python3 - "$KEY" <<'PYEOF'
import sys, json
try:
    import requests
    _get, _post = requests.get, None
except ImportError:
    requests = None
    import certifi, urllib.request
    def _get(url, **kw):
        kw.pop("timeout", None)
        ctx = __import__("ssl").create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(url, timeout=30, context=ctx) as r:
            return json.loads(r.read().decode())
    def _post(url, body, **kw):
        ctx = __import__("ssl").create_default_context(cafile=certifi.where())
        req = urllib.request.Request(url, data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
            return json.loads(r.read().decode())

key = sys.argv[1]
url = ("https://generativelanguage.googleapis.com/v1beta/models/"
       "gemini-3.8-flash:generateContent?key=" + key)
body = json.dumps({"contents": [{"parts": [{"text": "Antworte mit einem Wort: ok"}]}],
                   "generationConfig": {"maxOutputTokens": 200}}).encode()
try:
    if requests is not None:
        r = requests.post(url, data=body, timeout=30,
                          headers={"Content-Type": "application/json"})
        r.raise_for_status()
        data = r.json()
    else:
        data = _post(url, body)
    print("  Schluessel geprueft:", data["candidates"][0]["content"]["parts"][0]["text"].strip())
except Exception as exc:
    print("  WARNUNG: Der Schluessel hat nicht geantwortet:", str(exc)[:140])
    sys.exit(1)
PYEOF

cat <<'EOF'

  Naechster Schritt fuer die Online-Version:

    1. https://dashboard.render.com oeffnen
    2. my-style auswaehlen
    3. links "Environment"
    4. "Add Environment Variable"
         Key:    GEMINI_API_KEY
         Value:  <hier den Schluessel einfuegen>
    5. "Save Changes" — Render startet den Dienst automatisch neu

    Ohne diesen Schritt bleibt auf der gehosteten Seite die Meldung
    "This deployment has no GEMINI_API_KEY".

  LORENDE TIPPS
    - Serper-API-Schluessel (optional): SERPER_API_KEY auf die gleiche Weise
    - Beide Schluessel nach dem Eintragen im Dashboard NICHT mehr in Dateien
      schreiben. Wenn sie einmal im Chat standen, im Anbieter-Dashboard
      widerrufen und neu erzeugen.
EOF