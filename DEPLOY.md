# Deployment — My Style / Aestra

Die App läuft lokal mit `python3 app.py` (inklusive selbstsigniertem HTTPS für
den Handy-Zugriff im WLAN). Für den öffentlichen Betrieb wird ein Webserver
**ohne** Flask-Debug benutzt.

---

## 1. Was der Betrieb braucht

| Variable | Pflicht | Zweck |
|---|---|---|
| `SECRET_KEY` | ja | Signiert die Session-Cookies. Ohne sie wird jeder Login bei jedem Neustart ungültig. |
| `DATABASE_PATH` | ja | Pfad zur SQLite-Datei, z. B. `/data/styleai.db` auf einem Plattenlauf. |
| `GEMINI_API_KEY` | für KI | Frisuren, Outfits, Produktbeschreibung. Ohne Key laufen diese Funktionen nicht, die App startet trotzdem. |
| `SERPER_API_KEY` | optional | Produktsuche und Videos. |
| `FORCE_SECURE_COOKIES` | ja | `1` — die Session-Cookies tragen dann `Secure`. |
| `AESTRA_DEBUG` | empfohlen | `0` — niemals `1` im Betrieb. |
| `AESTRA_TRUST_PROXY` | empfohlen | `1` (Vorgabe). Übernimmt `X-Forwarded-Proto`, damit Flask die Verbindung als HTTPS erkennt. |

`SECRET_KEY` erzeugen:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

---

## 2. Render.com (empfohlen)

1. Repository bei [github.com/Cll606606/Thefinalthing](https://github.com/Cll606606/Thefinalthing) (ist bereits vorhanden).
2. Render → **New +** → **Blueprint** → Repository wählen. Render liest `render.yaml`.
3. Nach dem ersten Deploy unter **Environment** eintragen:
   - `GEMINI_API_KEY`
   - `SERPER_API_KEY` (optional)
4. Fertig. Die URL steht oben im Render-Dashboard.

### Wichtig: die Datenbank

`render.yaml` enthält einen 1-GB-Plattenlauf (`my-style-data`, gemountet auf
`/data`). **Plattenläufe gibt es nur in bezahlten Plänen.** Auf dem kostenlosen
Plan startet die App, aber alle Konten, Outfits und Messungen gehen bei jedem
Neustart verloren — SQLite lebt dann nur im Container-Dateisystem.

Für echte Nutzung also ein bezahlter Plan nötig. Alternative ohne Bezahlung:
PostgreSQL (z. B. Render Free) — das setzt aber eine Umstellung von SQLite auf
`psycopg` voraus, also mehr Arbeit als ein Plattenlauf.

---

## 3. Andere Anbieter

**Railway / Fly.io:** identisch, nur `DATABASE_PATH` auf den gemounteten Pfad
setzen. Die mitgelieferte `Dockerfile` funktioniert dort direkt.

**Docker selbst:**

```bash
docker build -t my-style .
docker run -p 5001:5001 \
  -e SECRET_KEY="$(python3 -c 'import secrets;print(secrets.token_hex(32))')" \
  -e DATABASE_PATH=/data/styleai.db \
  -e FORCE_SECURE_COOKIES=1 \
  -v "$PWD/data:/data" \
  my-style
```

---

## 4. Prüfen, ob es läuft

| Prüfung | Erwartung |
|---|---|
| `/healthz` | `{"db":true,"ok":true,...}` |
| Login | Cookie trägt `Secure; HttpOnly; SameSite=Lax` |
| Kamera | Browser muss die Seite über **HTTPS** aufrufen, sonst verweigert er den Zugriff |
| Wetter | `📍 Use My Location` → Chip mit Temperatur |
| Konsole | keine CSP-Verstöße (`Refused to connect`) |

---

## 5. Fallen, die schon einmal zugeschlagen haben

- **Geolokalisierung braucht HTTPS.** Auf `localhost` geht es, über eine
  HTTP-IP-Adresse im WLAN nicht. Der Browser blockt es still; die App sagt
  jetzt „Location needs HTTPS".
- **CSP blockt Fremd-Verbindungen.** `connect-src 'self'` heißt: der Browser
  darf nur den eigenen Server ansprechen. Wetter und Klima laufen deshalb über
  die Proxy-Endpunkte `/api/weather` und `/api/climate`. Neue externe Abrufe
  aus dem Browser müssen über den Server laufen, sonst derselbe Fehler.
- **`SESSION_COOKIE_SECURE` wird beim Import gesetzt**, nicht in `__main__`.
  Unter `gunicorn app:app` läuft `__main__` nie — eine Einstellung dort hätte
  im Betrieb nicht gegriffen.
- **API-Schlüssel nie in den Code.** Beide Schlüssel standen schon einmal im
  Quelltext bzw. wurden im Chat offengelegt; sie sind zu rotieren.

---

## 6. Nach dem Deployment

Die Hauptseite steht hinter dem Login und ist daher für Suchmaschinen nicht
sichtbar. Für Auffindbarkeit fehlen noch: eine öffentliche Landingpage ohne
Login, `robots.txt`, `sitemap.xml` und Meta-Beschreibungen. Anschließend die
URL in der [Google Search Console](https://search.google.com/search-console)
anmelden.