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

## 2. Render.com — kostenloser Testweg

`render.yaml` ist auf den kostenlosen Plan eingestellt.

1. Konto bei [render.com](https://render.com) anlegen.
2. **New +** → **Blueprint** → das Repository
   [Cll606606/Thefinalthing](https://github.com/Cll606606/Thefinalthing) wählen.
   Render liest `render.yaml` und trägt alles selbst ein.
3. Render fragt nach den beiden API-Schlüsseln — dort die eigenen Werte
   eintragen (sie erscheinen als *Secret*, nicht im Klartext).
4. Nach dem Build steht die URL im Dashboard, etwa
   `https://my-style.onrender.com`.

### Was der kostenlose Plan bedeutet

| | |
|---|---|
| Preis | 0 € |
| App erreichbar | ja |
| `fastuser` und eigene Konten | **nach jedem Neustart weg** |
| Kamera, Wetter, KI | vollständig funktionsfähig |

Die SQLite-Datei liegt im Container-Dateisystem. Render fährt die Instanz
nach Inaktivität herunter und löscht sie beim nächsten Build — die Daten
sind dann weg. Das ist der einzige Unterschied zum bezahlten Betrieb.

Fällt `/data` nicht anlegbar aus, weicht die App automatisch auf einen
beschreibbaren Pfad aus und startet trotzdem (`_resolve_db_path()`).

### Später auf Dauerbetrieb umstellen

Erst wenn der Test überzeugt:

1. `plan: starter` in `render.yaml` — nur dafür sind Plattenläufe erlaubt.
2. Den Block `disk:` unten in `render.yaml` auskommentieren.
3. Neu deployen. Render hängt den Plattenlauf ein, die Daten bleiben
   danach erhalten.

Kosten: Starter-Instanz (etwa 7 $/Monat) + 1 GB Platte (0,25 $/Monat).

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