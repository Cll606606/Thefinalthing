import base64
import io
import json
import os
import sys
import re
import secrets
import socket
import sqlite3
import time
from datetime import datetime, timedelta
from functools import wraps
from urllib.parse import urlparse

import requests
from flask import (Flask, Response, jsonify, redirect, render_template,
                   request, send_from_directory, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

from PIL import Image

# macOS Python is notorious for "unable to get local issuer certificate".
# Pin HTTPS verification to the bundled certifi CA store so the Gemini calls
# can't fail on system certificate lookup.
try:
    import certifi as _certifi
    _VERIFY = _certifi.where()
except Exception:  # noqa: BLE001 - certifi missing: fall back to requests default
    _VERIFY = True


def _load_dotenv(path=".env"):
    """Tiny .env loader: fills os.environ only for keys not already set."""
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key, value = key.strip(), value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except FileNotFoundError:
        pass


_load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Lokal: styleai.db neben der App. Auf einem Hosting-Anbieter liegt das
# Dateisystem meist in einem fluechtigen Container — dort zeigt
# DATABASE_PATH auf einen persistenten Plattenlauf, sonst waeren
# Kleiderschrank und Profil nach jedem Neustart leer.
def _resolve_db_path():
    """Wo die SQLite-Datei liegen soll — mit Rueckfalloption.

    Das ist wichtig fuer den Betrieb: render.yaml setzt DATABASE_PATH auf
    /data/styleai.db, weil dort auf bezahlten Plaenen der Plattenlauf
    haengt. Im kostenlosen Plan gibt es keinen Plattenlauf, und /data
    laesst sich dort auch nicht anlegen (keine Schreibrechte im
    Dateisystem-Wurzelverzeichnis). Ohne diese Rueckfalloption wuerde
    sqlite3.connect() beim Start scheitern und die App in einer
    Neustartschleife hängen bleiben.
    """
    wanted = os.environ.get("DATABASE_PATH") or os.path.join(BASE_DIR, "styleai.db")

    def usable(path):
        folder = os.path.dirname(path) or "."
        try:
            os.makedirs(folder, exist_ok=True)
            probe = os.path.join(folder, ".write_test")
            with open(probe, "w"):
                pass
            os.remove(probe)
            return True
        except OSError:
            return False

    if usable(wanted):
        return wanted

    fallback = os.path.join(BASE_DIR, "styleai.db")
    print(f"  ⚠️  {os.path.dirname(wanted)} ist nicht beschreibbar — "
          f"SQLite wandert nach {fallback}. Auf einem Plattenlauf bleiben "
          f"die Daten erhalten, sonst nicht.", file=sys.stderr)
    return fallback


DB_PATH = _resolve_db_path()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024  # allow big image payloads
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)  # "remember me"
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_HTTPONLY"] = True


def _secret_key():
    # Geheimer Schlüssel für die Session-Kekse. Wenn es noch keinen gibt,
    # legen wir einen an — mit Rechten 0600, damit nur der eigene User ihn
    # lesen kann (andernfalls könnte ein Mitbenutzer die Sessions fälschen).
    key = os.environ.get("SECRET_KEY")
    if key:
        return key
    f = os.path.join(BASE_DIR, ".secret_key")
    if os.path.exists(f):
        with open(f) as fh:
            return fh.read().strip()
    key = secrets.token_hex(32)
    fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(key)
    os.chmod(f, 0o600)
    return key


app.secret_key = _secret_key()

# Free-tier Gemini key: https://aistudio.google.com/apikey
# Set it either as an environment variable or in a local .env file
# (GEMINI_API_KEY=your_key_here) so it is NOT committed to git.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
# Der Schluessel gehoert hier NICHT hin. Ein Schluessel als Standardwert
# im Code landet beim naechsten git add -A im Repository — genau das ist
# passiert, und GitHub hat den Push deshalb blockiert. Richtig sind:
#   lokal:  Zeile GEMINI_API_KEY=... in der .env (steht in .gitignore)
#   online: Environment Variable im Dashboard des Anbieters
# WICHTIG: Der Modellname muss exakt zu einem Modell passen, das der Key
# tatsaechlich nutzen darf. "gemini-3.6-flash" existiert nicht (404/503),
# und aeltere Modelle wie gemini-2.5-flash sind fuer neue Keys gesperrt
# ("no longer available to new users"). Deshalb: Liste von alt nach neu,
# der erste funktionierende Eintrag gewinnt (siehe _gemini_call).
GEMINI_MODELS = [
    m.strip() for m in os.environ.get(
        "GEMINI_MODEL", "gemini-3.8-flash,gemini-3.5-flash,gemini-3-flash-preview"
    ).split(",") if m.strip()
]
GEMINI_MODEL = GEMINI_MODELS[0]

# Serper-Schlüssel für Produkt-/Video-/Bildsuche. Lebt NUR auf dem Server
# (aus .env), damit er nicht im Browser-Code gestohlen werden kann. Im
# schlimmsten Fall greift der Standard-Schlüssel für den eigenen Gebrauch.
# Ohne gesetzten Schluessel laeuft die Suche einfach aus; es gibt keinen
# eingebauten Fallback mehr, weil ein im Quelltext hinterlegter Schluessel
# beim oeffentlichen Repository mitveroeffentlicht waere.
SERPER_API_KEY = os.environ.get("SERPER_API_KEY", "")

# ---- Session-Kekse härten ----
# HttpOnly: das JavaScript kann den Cookie nicht auslesen (schützt vor
# XSS-Diebstahl). SameSite=Lax verhindert, dass eine fremde Seite bei uns
# eine Aktion auslöst. Secure wird aktiv, sobald über HTTPS geservt wird.

# WICHTIG: Diese Entscheidung muss beim *Import* fallen, nicht erst in
# __main__. Unter "gunicorn app:app" läuft der __main__-Block nämlich
# überhaupt nicht — die Konfiguration wäre dort spurlos verschwunden und
# der Login hätte über eine HTTPS-Adresse nicht mehr funktioniert
# (der Browser hätte das Secure-Cookie nicht geschickt).
_force = os.environ.get("FORCE_SECURE_COOKIES", "")
_https_env = os.environ.get("AESTRA_HTTPS", "")
if _force == "1":
    _secure_cookies = True
elif _https_env in ("0", "1"):
    _secure_cookies = (_https_env == "1")
else:
    # Keine Aussage: nur der Startblock im eigenen Betrieb entscheidet dann,
    # anhand der tatsächlich erkannten Zertifikate.
    _secure_cookies = False

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=_secure_cookies,
)

if _secure_cookies and os.environ.get("AESTRA_TRUST_PROXY", "1") == "1":
    # Hinter Render/Railway beendet der Anbieter das TLS. Flask sieht
    # deshalb nur "http" und hält sich für eine unsichere Verbindung.
    # ProxyFix reicht die echten Werte aus X-Forwarded-* durch, damit
    # request.is_secure, url_for und Weiterleitungen stimmen.
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

if not os.environ.get("SECRET_KEY") and os.environ.get("RENDER"):
    # Das ist eine Warnung, kein Fehler: die App startet auch ohne sie.
    # Ohne SECRET_KEY legt aber jeder Container-Start einen neuen
    # Zufallsschluessel an — alle Logins waeren beim Neustart ungueltig,
    # und das ist auf einem Free-Plan bei jedem Deploy der Fall.
    app.logger.warning(
        "SECRET_KEY fehlt (nur eine Warnung, der Dienst startet). "
        "Die App erzeugt dann pro Start einen neuen Zufallsschluessel, "
        "wodurch alle Logins beim Neustart ungueltig werden. Abhilfe: "
        "Environment -> Add Environment Variable -> SECRET_KEY. "
        "Wert erzeugen mit: python3 -c \"import secrets;"
        "print(secrets.token_hex(32))\" — und nicht hier eintragen."
    )

# ------------------------------------------------------------
# HTTPS-Entscheidung (wird tatsächlich erst beim Starten in
# __main__ getroffen — hier nur die Zertifikat-Erkennung):
#
#   • Am eigenen Computer (127.0.0.1/localhost) brauchen wir KEIN
#     HTTPS: Browser behandeln Loopback als sicheren Kontext, die
#     Kamera funktioniert dort also auch ohne Zertifikat — und es
#     erscheint keine gruselige Browser-Warnung.
#
#   • Fürs Handy im WLAN (LAN-IP) starten wir automatisch HTTPS,
#     sonst blockiert die Kamera. Zertifikate: ./make_cert.sh
#
#   • Fest erzwingen mit AESTRA_HTTPS=1 bzw. AESTRA_HTTPS=0.
# ------------------------------------------------------------
_SSL_CERT = os.path.join(BASE_DIR, "certs", "cert.pem")
_SSL_KEY = os.path.join(BASE_DIR, "certs", "key.pem")
_SSL_PRESENT = os.path.exists(_SSL_CERT) and os.path.exists(_SSL_KEY)

# ============================================================
#   DATABASE
# ============================================================

def _get_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def _init_db():
    db = _get_db()
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            -- COLLATE NOCASE: "Anna" und "anna" sind DERSELBE Name.
            -- So kann niemand mit vertauschter Groß-/Kleinschreibung
            -- den Namen eines anderen klauen oder verwirren.
            username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            email TEXT UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            sec_q TEXT,
            sec_a_hash TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS wardrobe (
            user_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (user_id, item_id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS profile (
            user_id INTEGER PRIMARY KEY,
            data TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS capsule (
            user_id INTEGER PRIMARY KEY,
            data TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        """
    )
    # Upgrade legacy databases: add security-question columns if missing.
    cols = {row[1] for row in db.execute("PRAGMA table_info(users)").fetchall()}
    for column in ("sec_q TEXT", "sec_a_hash TEXT"):
        name = column.split()[0]
        if name not in cols:
            db.execute(f"ALTER TABLE users ADD COLUMN {column}")

    # Wichtig: Ältere Datenbanken wurden VOR COLLATE NOCASE angelegt.
    # Hier legen wir zusätzlich einen case-insensitiven Unique-Index an,
    # damit auch bestehende DBs keine Duplikate wie "Anna"/"anna" zulassen.
    # Falls die DB schon Duplikate enthält, ignorieren wir den Fehler
    # (die neue Signup-Logik verhindert solche Fälle ab sofort ohnehin).
    try:
        db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci "
            "ON users (username COLLATE NOCASE)"
        )
    except sqlite3.IntegrityError:
        pass

    db.commit()
    db.close()


_init_db()


# ============================================================
#   SECURITY MIDDLEWARE
#   ------------------------------------------------------------
#   - Rate-Limit: begrenzt Login-/Such-Versuche, damit niemand
#     Passwörter durchprobieren oder die Such-Quota abräumen kann.
#   - Header: erschweren XSS, Clickjacking und MIME-Sniffing und
#     verhindern, dass fremde Seiten unsere Kekse/Daten mitlesen.
# ============================================================

_RATE_HITS = {}


def _client_ip():
    # Wir serven die App direkt (ohne Reverse-Proxy), deshalb nehmen wir nur
    # die echte Verbindungs-IP. X-Forwarded-For wird bewusst IGNORIERT —
    # sonst könnte man das Rate-Limit einfach durch gefälschte Headers
    # umgehen. Läuft die App später hinter einem Proxy, hier umstellen.
    return request.remote_addr or "?"


def _rate_check(key, limit=6, window_s=300):
    """Erlaubt höchstens `limit` Aktionen pro Zeitfenster pro Schlüssel."""
    now = time.time()
    hits = [t for t in _RATE_HITS.get(key, []) if now - t < window_s]
    if len(hits) >= limit:
        _RATE_HITS[key] = hits
        return False
    hits.append(now)
    _RATE_HITS[key] = hits
    return True


@app.after_request
def _security_headers(resp):
    # Strengere Browser-Einstellungen für jede Antwort.
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' "
        "https://cdn.jsdelivr.net https://www.youtube.com https://www.youtube-nocookie.com; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src * data: blob:; "
        "font-src 'self' data:; "
        "connect-src 'self' https://cdn.jsdelivr.net; "
        "media-src 'self' blob:; "
        "frame-src https://www.youtube.com https://www.youtube-nocookie.com; "
        "worker-src 'self' blob: https://cdn.jsdelivr.net; "
        "manifest-src 'self'; "
        "object-src 'none'; base-uri 'self'; form-action 'self'"
    )
    # Persönliche Daten (Wardrobe, Profil, Analysen) nie im Browser-Cache
    # lassen — sonst könnte sie auf geteilten Geräten jemand nachlesen.
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp


# ============================================================
#   AUTH HELPERS
# ============================================================

def login_required(f):
    @wraps(f)
    def wrap(*args, **kwargs):
        if "uid" not in session:
            return redirect(url_for("login_page"))
        return f(*args, **kwargs)
    return wrap


def api_login_required(f):
    @wraps(f)
    def wrap(*args, **kwargs):
        if "uid" not in session:
            return jsonify({"ok": False, "error": "Not logged in."}), 401
        return f(*args, **kwargs)
    return wrap


# ============================================================
#   PAGES
# ============================================================

# ============================================================
#   WETTER & KLIMA (Server-Proxy)
# ============================================================
#   Warum ueber den Server statt direkt aus dem Browser?
#   1) Die Content-Security-Policy erlaubt dem Browser nur eigene
#      Ziele ("connect-src 'self'"). Ein direkter Aufruf von
#      api.open-meteo.com aus der Seite wurde deshalb blockiert —
#      im Browser stand danach nur ein leerer Fehler.
#   2) Der Standort des Nutzers geht damit nur an den eigenen
#      Server und nicht an einen Drittanbieter im Browser. Das ist
#      genau die Haltung, die die App sonst auch vertritt.
#   Open-Meteo braucht keinen API-Schluessel.

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_CLIMATE = "https://climate-api.open-meteo.com/v1/climate"


def _clean_coord(raw, limit):
    try:
        v = float(raw)
    except (TypeError, ValueError):
        raise ValueError("unreadable coordinate")
    if v != v or abs(v) > limit:      # NaN ausschliessen, Grenzen pruefen
        raise ValueError("coordinate out of range")
    return v


@app.route("/api/weather")
@api_login_required
def api_weather():
    """Aktuelles Wetter fuer Koordinaten. Ohne Schluessel, ueber den Proxy."""
    try:
        lat = _clean_coord(request.args.get("lat"), 90)
        lon = _clean_coord(request.args.get("lon"), 180)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    url = (f"{OPEN_METEO}?latitude={lat}&longitude={lon}"
           "&current=temperature_2m,apparent_temperature,weather_code,precipitation"
           "&forecast_days=1&timezone=auto")
    try:
        resp = requests.get(url, timeout=15, verify=_VERIFY)
        resp.raise_for_status()
        return jsonify({"ok": True, "data": resp.json()})
    except requests.RequestException as exc:
        app.logger.warning("weather failed: %s", _scrub(exc))
        return jsonify({
            "ok": False,
            "error": "weather_unreachable",
            "message": "Weather service did not answer."
        }), 502


@app.route("/api/climate")
@api_login_required
def api_climate():
    """Klimanormalen (Monatsmittel) fuer die Kapsel."""
    try:
        lat = _clean_coord(request.args.get("lat"), 90)
        lon = _clean_coord(request.args.get("lon"), 180)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    # Ohne start_date/end_date liefert die Klimadaten-API nur 7 Tage. Die
    # Kapsel rechnet aber "waermster Monat" und "Regen pro Jahr" aus —
    # dafuer wird ein vollstaendiges Referenzjahr gebraucht.
    year = datetime.now().year - 1        # letztes abgeschlossenes Jahr
    url = (f"{OPEN_METEO_CLIMATE}?latitude={lat}&longitude={lon}"
           "&models=EC_Earth3P_HR"
           f"&start_date={year}-01-01&end_date={year}-12-31"
           "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum")
    try:
        resp = requests.get(url, timeout=25, verify=_VERIFY)
        resp.raise_for_status()
        return jsonify({"ok": True, "data": resp.json()})
    except requests.RequestException as exc:
        app.logger.warning("climate failed: %s", _scrub(exc))
        return jsonify({
            "ok": False,
            "error": "climate_unreachable",
            "message": "Climate service did not answer."
        }), 502


@app.route("/healthz")
def healthz():
    """Gesundheitscheck: der Hosting-Anbieter prueft hier, ob die App lebt."""
    try:
        _get_db().close()
        db_ok = True
    except Exception:  # noqa: BLE001
        db_ok = False
    return jsonify({
        "ok": True,
        "db": db_ok,
        "service": "my-style",
        "version": "1.0"
    }), (200 if db_ok else 503)


@app.route("/sw.js")
def service_worker():
    """Service Worker bewusst im ROOT ausliefern.

    Ein Worker unter /static/ bekommt automatisch nur den Scope /static/
    und die Registrierung mit scope="/" wuerde mit einem SecurityError
    abbrechen. Deshalb diese Route.
    """
    resp = send_from_directory(app.static_folder, "sw.js",
                               mimetype="application/javascript")
    # Erlaubt den vollen Scope und erzwingt eine Pruefung auf Updates.
    resp.headers["Service-Worker-Allowed"] = "/"
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.route("/manifest.json")
def manifest():
    """Manifest auch im Root, damit die Verweise stabil bleiben."""
    resp = send_from_directory(app.static_folder, "manifest.json",
                               mimetype="application/manifest+json")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/login")
def login_page():
    if "uid" in session:
        return redirect(url_for("index_page"))
    return render_template("login.html")


def base_url():
    """Absolute Adresse fuer Canonical-Tags, Sitemap und Open Graph.

    Ohne PUBLIC_BASE_URL nehmen wir die tatsaechliche Anfrage — das
    funktioniert im Betrieb, ergibt aber lokal "http://localhost:5001".
    """
    configured = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
    if configured:
        return configured
    return request.url_root.rstrip("/")


@app.route("/")
def landing_page():
    """Ohne Login steht hier die oeffentliche Seite, mit Login der Studio-Hub.

    Warum getrennt: alle vier App-Seiten liegen hinter der Anmeldung und
    sind fuer Suchmaschinen unsichtbar. Ohne diese oeffentliche Seite
    waere die App im Netz nicht auffindbar.
    """
    if session.get("uid"):
        return render_template("hub.html")
    return render_template("landing.html", base_url=base_url())


@app.route("/robots.txt")
def robots_txt():
    """Nur die oeffentliche Seite zum Indexieren anmelden. Die vier
    App-Seiten bleiben draussen — sie sind ohnehin nur mit Login erreichbar."""
    body = (
        "User-agent: *\n"
        "Allow: /\n"
        # /login und /app gehoeren nicht in den Index
        "Disallow: /login\n"
        "Disallow: /beauty\n"
        "Disallow: /wardrobe\n"
        "Disallow: /settings\n"
        "Disallow: /api/\n"
        "\n"
        f"Sitemap: {base_url()}/sitemap.xml\n"
    )
    return Response(body, mimetype="text/plain")


@app.route("/sitemap.xml")
def sitemap_xml():
    """Nur die oeffentliche Seite — die App-Seiten sind nicht oeffentlich."""
    root = base_url()
    today = datetime.now().strftime("%Y-%m-%d")
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"  <url>\n    <loc>{root}/</loc>\n"
        f"    <lastmod>{today}</lastmod>\n"
        "    <changefreq>monthly</changefreq>\n"
        "    <priority>1.0</priority>\n  </url>\n"
        "</urlset>\n"
    )
    return Response(xml, mimetype="application/xml")


@app.route("/beauty")
@login_required
def beauty_lab():
    return render_template("beauty.html")


@app.route("/wardrobe")
@login_required
def style_lab():
    return render_template("wardrobe.html")


@app.route("/settings")
@login_required
def settings_page():
    """Einstellungs-Seite: Profil, Passwort, Sicherheitsfrage, Logout."""
    return render_template("settings.html")


# ============================================================
#   AUTH API
# ============================================================

def _validate_creds(username, password, email=""):
    if len(username) < 3 or not re.match(r"^[A-Za-z0-9_.-]+$", username):
        return "Username must be 3+ characters (letters, numbers, . _ -)."
    if len(password) < 6:
        return "Password must be at least 6 characters."
    if email and not re.match(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return "That email address looks invalid."
    return None


@app.route("/api/auth/signup", methods=["POST"])
def api_signup():
    d = request.get_json(silent=True) or {}
    username = (d.get("username") or "").strip()
    email = (d.get("email") or "").strip()
    password = d.get("password") or ""
    sec_q = (d.get("sec_q") or "").strip()
    sec_a = (d.get("sec_a") or "").strip()
    remember = bool(d.get("remember"))

    err = _validate_creds(username, password, email)
    if err:
        return jsonify({"ok": False, "error": err}), 400

    # Höchstens 3 neue Konten pro IP in 5 Minuten, damit niemand das
    # Signup-Feld für Spam/flut-artige Angriffe missbraucht.
    if not _rate_check("signup:" + _client_ip(), limit=3, window_s=300):
        return jsonify({
            "ok": False,
            "error": "Too many accounts created from this address. Wait a moment."
        }), 429

    if not sec_q or not sec_a:
        return jsonify({
            "ok": False,
            "error": "Please add a security question + answer — that's how you'll reset your password if you forget it."
        }), 400
    if len(sec_a) < 3:
        return jsonify({"ok": False, "error": "Security answer should be at least 3 characters."}), 400

    db = _get_db()
    # LOWER() beim Vergleich: egal ob jemand "Anna" oder "anna" tippt,
    # es ist derselbe Name — und er ist bereits vergeben.
    if db.execute("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", (username,)).fetchone():
        db.close()
        return jsonify({"ok": False, "error": "That username is already taken."}), 409
    if email and db.execute("SELECT id FROM users WHERE email = ?", (email.lower(),)).fetchone():
        db.close()
        return jsonify({"ok": False, "error": "That email is already registered."}), 409

    cur = db.execute(
        "INSERT INTO users (username, email, password_hash, sec_q, sec_a_hash) VALUES (?, ?, ?, ?, ?)",
        (username, email or None, generate_password_hash(password), sec_q, generate_password_hash(sec_a)),
    )
    db.commit()
    uid = cur.lastrowid
    db.close()

    session.clear()
    session["uid"] = uid
    session["username"] = username
    session.permanent = remember
    return jsonify({"ok": True, "username": username})


@app.route("/api/auth/login", methods=["POST"])
def api_login():
    d = request.get_json(silent=True) or {}
    identifier = (d.get("username") or "").strip()
    password = d.get("password") or ""
    remember = bool(d.get("remember"))

    # Brute-Force-Schutz: nicht mehr als 10 Login-Versuche pro Minute-Fenster.
    # (Zeitfenster 5 Minuten; nutzt die IP, damit ein Angreifer nicht mit
    # einem Script unendlich Passwörter durchprobieren kann.)
    if not _rate_check("login:" + _client_ip(), limit=10, window_s=300):
        return jsonify({
            "ok": False,
            "error": "Too many attempts. Please wait a few minutes and try again."
        }), 429

    db = _get_db()
    row = db.execute(
        "SELECT id, username, password_hash FROM users "
        "WHERE LOWER(username) = LOWER(?) OR email = ?",
        (identifier, identifier.lower()),
    ).fetchone()
    db.close()

    if not row or not check_password_hash(row["password_hash"], password):
        return jsonify({"ok": False, "error": "Wrong username or password."}), 401

    session.clear()
    session["uid"] = row["id"]
    session["username"] = row["username"]
    session.permanent = remember
    return jsonify({"ok": True, "username": row["username"]})


@app.route("/api/auth/forgot-info", methods=["POST"])
def _forgot_info():
    """Given a username/email, return its security question (if set)."""
    d = request.get_json(silent=True) or {}
    identifier = (d.get("username") or "").strip()
    if not _rate_check("forgot:" + _client_ip(), limit=8, window_s=300):
        return jsonify({"ok": False, "error": "Too many attempts. Wait a few minutes."}), 429
    db = _get_db()
    row = db.execute(
        "SELECT sec_q FROM users WHERE LOWER(username) = LOWER(?) OR email = ?",
        (identifier, identifier.lower()),
    ).fetchone()
    db.close()
    if not row or not row["sec_q"]:
        return jsonify({
            "ok": False,
            "error": "We couldn't find an account with that username, or it has no security question set yet."
        }), 404
    return jsonify({"ok": True, "question": row["sec_q"]})


@app.route("/api/auth/forgot-reset", methods=["POST"])
def api_forgot_reset():
    """Answer the security question to set a NEW password."""
    d = request.get_json(silent=True) or {}
    identifier = (d.get("username") or "").strip()
    answer = (d.get("answer") or "").strip()
    new_password = d.get("newPassword") or ""

    if len(new_password) < 6:
        return jsonify({"ok": False, "error": "New password must be at least 6 characters."}), 400
    if not answer:
        return jsonify({"ok": False, "error": "Enter your security answer."}), 400
    if not _rate_check("forgot:" + _client_ip(), limit=5, window_s=300):
        return jsonify({"ok": False, "error": "Too many attempts. Wait a few minutes."}), 429

    db = _get_db()
    row = db.execute(
        "SELECT id, sec_a_hash FROM users WHERE LOWER(username) = LOWER(?) OR email = ?",
        (identifier, identifier.lower()),
    ).fetchone()
    if not row or not row["sec_a_hash"]:
        db.close()
        return jsonify({"ok": False, "error": "This account has no security question set, so it can't be recovered online."}), 404

    if not check_password_hash(row["sec_a_hash"], answer):
        db.close()
        return jsonify({"ok": False, "error": "Wrong security answer."}), 401

    db.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (generate_password_hash(new_password), row["id"]),
    )
    db.commit()
    db.close()
    # Force re-login with the fresh password.
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/auth/security", methods=["POST"])
@api_login_required
def api_security_set():
    """Update (or add for legacy accounts) the security question."""
    d = request.get_json(silent=True) or {}
    sec_q = (d.get("sec_q") or "").strip()
    sec_a = (d.get("sec_a") or "").strip()
    if not sec_q or not sec_a:
        return jsonify({"ok": False, "error": "Please enter both a question and an answer."}), 400
    if len(sec_a) < 3:
        return jsonify({"ok": False, "error": "Security answer should be at least 3 characters."}), 400
    db = _get_db()
    db.execute(
        "UPDATE users SET sec_q = ?, sec_a_hash = ? WHERE id = ?",
        (sec_q, generate_password_hash(sec_a), session["uid"]),
    )
    db.commit()
    db.close()
    return jsonify({"ok": True})


@app.route("/api/auth/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/me")
def api_me():
    if "uid" not in session:
        return jsonify({"ok": False}), 401
    db = _get_db()
    row = db.execute(
        "SELECT username, email, sec_q, created_at FROM users WHERE id = ?",
        (session["uid"],),
    ).fetchone()
    db.close()
    return jsonify({
        "ok": True,
        "uid": session["uid"],
        "username": row["username"] if row else session["username"],
        "email": row["email"] if row else None,
        "hasSecurity": bool(row and row["sec_q"]),
        "createdAt": row["created_at"] if row else None
    })


# ============================================================
#   ACCOUNT SETTINGS  (Profil bearbeiten, Passwort ändern)
# ============================================================

@app.route("/api/account/email", methods=["POST"])
@api_login_required
def api_account_email():
    """Die E-Mail des angemeldeten Nutzers ändern.

    Zum Schutz fragen wir nach dem aktuellen Passwort — nur so kann
    niemand, der nur kurz am Gerät sitzt, die Kontaktdaten eines
    anderen Accounts umbiegen.
    """
    d = request.get_json(silent=True) or {}
    email = (d.get("email") or "").strip().lower()
    password = d.get("password") or ""

    if not _rate_check("account:" + _client_ip(), limit=5, window_s=300):
        return jsonify({"ok": False, "error": "Too many attempts. Wait a few minutes."}), 429

    if not re.match(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify({"ok": False, "error": "That email address looks invalid."}), 400

    db = _get_db()
    me = db.execute(
        "SELECT email, password_hash FROM users WHERE id = ?", (session["uid"],)
    ).fetchone()
    if not me:
        db.close()
        return jsonify({"ok": False, "error": "Account not found."}), 404
    if not check_password_hash(me["password_hash"], password):
        db.close()
        return jsonify({"ok": False, "error": "Wrong password."}), 401

    # Auch hier case-insensitiv gegen E-Mails anderer Nutzer prüfen,
    # damit nicht zwei Konten dieselbe Adresse bekommen.
    taken = db.execute(
        "SELECT id FROM users WHERE email = ? AND id != ?",
        (email, session["uid"]),
    ).fetchone()
    if taken:
        db.close()
        return jsonify({"ok": False, "error": "That email is already registered."}), 409

    db.execute("UPDATE users SET email = ? WHERE id = ?", (email, session["uid"]))
    db.commit()
    db.close()
    return jsonify({"ok": True, "email": email})


@app.route("/api/account/password", methods=["POST"])
@api_login_required
def api_account_password():
    """Der Nutzer kann sein Passwort ändern.

    Wir prüfen das aktuelle Passwort, damit nur der echte Kontoinhaber
    (der es ja kennt) das Passwort neu setzen kann.
    """
    d = request.get_json(silent=True) or {}
    current = d.get("current") or ""
    new_password = d.get("newPassword") or ""

    if not _rate_check("account:" + _client_ip(), limit=5, window_s=300):
        return jsonify({"ok": False, "error": "Too many attempts. Wait a few minutes."}), 429

    if len(new_password) < 6:
        return jsonify({"ok": False, "error": "New password must be at least 6 characters."}), 400

    db = _get_db()
    row = db.execute(
        "SELECT password_hash FROM users WHERE id = ?", (session["uid"],)
    ).fetchone()
    if not row or not check_password_hash(row["password_hash"], current):
        db.close()
        return jsonify({"ok": False, "error": "Your current password is wrong."}), 401

    db.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (generate_password_hash(new_password), session["uid"]),
    )
    db.commit()
    db.close()
    return jsonify({"ok": True})


# ============================================================
#   PER-USER DATA  (each row belongs to session["uid"])
# ============================================================

@app.route("/api/wardrobe", methods=["GET"])
@api_login_required
def api_wardrobe_get():
    db = _get_db()
    rows = db.execute(
        "SELECT data FROM wardrobe WHERE user_id = ?", (session["uid"],)
    ).fetchall()
    db.close()
    items = [json.loads(r["data"]) for r in rows]
    items.sort(key=lambda x: x.get("id", 0))
    return jsonify({"ok": True, "items": items})


@app.route("/api/wardrobe", methods=["POST"])
@api_login_required
def api_wardrobe_set():
    d = request.get_json(silent=True) or {}
    items = d.get("items")
    if not isinstance(items, list):
        return jsonify({"ok": False, "error": "Expected { items: [] }"}), 400

    uid = session["uid"]
    db = _get_db()
    db.execute("DELETE FROM wardrobe WHERE user_id = ?", (uid,))
    db.executemany(
        "INSERT INTO wardrobe (user_id, item_id, data) VALUES (?, ?, ?)",
        [(uid, it.get("id"), json.dumps(it)) for it in items if isinstance(it, dict)],
    )
    db.commit()
    db.close()
    return jsonify({"ok": True, "count": len(items)})


@app.route("/api/profile", methods=["GET"])
@api_login_required
def api_profile_get():
    db = _get_db()
    row = db.execute(
        "SELECT data FROM profile WHERE user_id = ?", (session["uid"],)
    ).fetchone()
    db.close()
    return jsonify({"ok": True, "profile": json.loads(row["data"]) if row else None})


@app.route("/api/profile", methods=["POST"])
@api_login_required
def api_profile_set():
    d = request.get_json(silent=True) or {}
    profile = d.get("profile")
    uid = session["uid"]
    db = _get_db()
    if profile is None:
        db.execute("DELETE FROM profile WHERE user_id = ?", (uid,))
    else:
        db.execute(
            "INSERT INTO profile (user_id, data) VALUES (?, ?) "
            "ON CONFLICT(user_id) DO UPDATE SET data = excluded.data",
            (uid, json.dumps(profile)),
        )
    db.commit()
    db.close()
    return jsonify({"ok": True})


@app.route("/api/capsule", methods=["GET"])
@api_login_required
def api_capsule_get():
    db = _get_db()
    row = db.execute(
        "SELECT data FROM capsule WHERE user_id = ?", (session["uid"],)
    ).fetchone()
    db.close()
    return jsonify({"ok": True, "state": json.loads(row["data"]) if row else {}})


@app.route("/api/capsule", methods=["POST"])
@api_login_required
def api_capsule_set():
    d = request.get_json(silent=True) or {}
    state = d.get("state")
    if not isinstance(state, dict):
        return jsonify({"ok": False, "error": "Expected { state: {} }"}), 400
    uid = session["uid"]
    db = _get_db()
    db.execute(
        "INSERT INTO capsule (user_id, data) VALUES (?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET data = excluded.data",
        (uid, json.dumps(state)),
    )
    db.commit()
    db.close()
    return jsonify({"ok": True})


# ============================================================
#   CLOTHING VISION (free Gemini Flash) — the AI "sees" photos
# ============================================================

def _downscale_jpeg(data_url, max_side=640):
    """Accept a data URL, decode it, trim it to a small JPEG.

    Smaller images = faster uploads, faster Gemini calls, lower cost.
    """
    mime = data_url.split(',')[0].split(';')[0].replace('data:', '')
    b64 = data_url.split(',', 1)[1]
    raw = base64.b64decode(b64)

    img = Image.open(io.BytesIO(raw)).convert("RGB")
    img.thumbnail((max_side, max_side), Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return {
        "mime_type": "image/jpeg",
        "data": base64.b64encode(buf.getvalue()).decode()
    }


# ============================================================
#   GEMINI-AUFRUF (mit Modell-Fallback + ohne Key-Leak)
# ============================================================

def _scrub(text):
    """Entfernt API-Keys und query-Strings aus Fehlermeldungen.

    Ein requests-Fehler enthaelt die vollstaendige URL inkl. ?key=... .
    Wurde diese Meldung ungefiltert an den Browser geschickt, lag der
    Schluessel im Klartext in der Oberflaeche. Deshalb wird jeder Text
    vor dem Verlassen des Servers geschwaerzt.
    """
    if not text:
        return ""
    text = str(text)
    text = re.sub(r"([?&]key=)[^&\s\"']+", r"\1***", text)
    text = re.sub(r"(key=)[A-Za-z0-9_\-]{20,}", r"\1***", text)
    text = re.sub(r"AIza[0-9A-Za-z_\-]{10,}", "***", text)
    text = re.sub(r"AQ\.[0-9A-Za-z_\-]{20,}", "***", text)
    return text


class _GeminiError(RuntimeError):
    """Fehler ohne URL/Key im Text, aber mit lesbarer Ursache."""
    pass


def _gemini_call(payload, *, label="text"):
    """Ruft Gemini; probiert die Modellliste durch, bis eines antwortet.

    Rueckgabe: (text, model) oder wirft _GeminiError.
    """
    if not GEMINI_API_KEY:
        raise _GeminiError("no_key")

    last = None
    for model in GEMINI_MODELS:
        url = ("https://generativelanguage.googleapis.com/v1beta/models/"
               f"{model}:generateContent")
        try:
            resp = requests.post(url, params={"key": GEMINI_API_KEY},
                                 json=payload, timeout=90, verify=_VERIFY)
        except Exception as exc:  # Netzwerk, TLS, Timeout
            last = f"{model}: {type(exc).__name__}"
            continue

        if resp.status_code != 200:
            # Kein Key im Log, keine URL im Log.
            try:
                api_msg = resp.json().get("error", {}).get("message", "")
            except Exception:
                api_msg = ""
            last = f"{model}: HTTP {resp.status_code} {_scrub(api_msg)[:160]}"
            # 400/404 heisst meist "falsches Modell" -> naechstes probieren
            continue

        try:
            text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError, TypeError, ValueError):
            # HTTP 200, aber leere Antwort: fast immer zu knappes
            # maxOutputTokens (Denk-Tokens haben das Budget aufgebraucht).
            last = f"{model}: leere Antwort (maxOutputTokens erhoehen?)"
            continue

        if not text or not text.strip():
            last = f"{model}: leere Antwort"
            continue

        app.logger.info("%s via %s", label, model)
        return text.strip(), model

    raise _GeminiError(_scrub(last) or "Gemini nicht erreichbar")

def _gemini_describe(data_url, name):
    inline = _downscale_jpeg(data_url)

    prompt = (
        "You are a fashion expert with computer vision. Look at the clothing "
        f"item in this photo. The user calls it: \"{name or 'unknown'}\". "
        "The user's name is authoritative about WHAT it is, but base every "
        "visual detail (color, fabric, pattern, cut, fit, style) strictly on "
        "what you actually SEE in the image. Never invent garments.\n\n"
        "Return ONLY valid JSON (no markdown) with exactly these fields:\n"
        "{\n"
        '  "type": string,                 // e.g. "Blazer", "Tee", "Boots"\n'
        '  "color": string,                // main color + undertone\n'
        '  "fabric": string,               // what the material looks like\n'
        '  "pattern": string,              // solid, striped, floral...\n'
        '  "fit": string,                  // oversized, slim, high-waist...\n'
        '  "style": string,                // aesthetic, e.g. streetwear, old money\n'
        '  "occasions": [string],          // 3 realistic places to wear it\n'
        '  "desc": string                  // ONE vivid 2-sentence description\n'
        "}\n"
        "If the image does not contain a clothing item, set type to \"unknown\" "
        "and describe what is actually there truthfully."
    )

    payload = {
        "contents": [{
            "parts": [
                {"inline_data": inline},
                {"text": prompt}
            ]
        }],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
            "maxOutputTokens": 8000
        }
    }
    text, _model = _gemini_call(payload, label="describe")

    try:
        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise RuntimeError("Gemini returned no content for this image.")

    text = text.strip()
    # Strip any code fences the model might add despite instructions.
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)

    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise RuntimeError("Gemini did not return JSON.")

    return json.loads(match.group(0))


def _gemini_text_json(prompt):
    """Text-only Gemini call that returns a parsed JSON object."""
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.4,
            "responseMimeType": "application/json",
            # Reserve, damit die Antwort nicht durch Denk-Tokens leer bleibt
            "maxOutputTokens": 8000
        }
    }
    text, _model = _gemini_call(payload, label="text-json")
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise RuntimeError("Gemini did not return JSON.")
    return json.loads(match.group(0))


def _key_missing_message():
    """Passender Hinweis, wenn GEMINI_API_KEY fehlt.

    Auf einem Hosting-Anbieter kann man keine .env-Datei anlegen — die
    Anleitung davor hat dort nie geholfen und den Nutzer raten lassen.
    Deshalb wird der Hinweis am Ort der Bereitstellung unterschieden.
    """
    if os.environ.get("RENDER"):
        return ("This deployment has no GEMINI_API_KEY. Add it under "
                "Environment in the dashboard, then the service restarts "
                "automatically. No .env file is needed here.")
    if os.environ.get("PORT") or os.environ.get("DYNO"):
        return ("This deployment has no GEMINI_API_KEY. Add it as an "
                "environment variable in the hosting dashboard, then "
                "restart the service.")
    return ("No GEMINI_API_KEY configured. Add GEMINI_API_KEY=your_key to "
            "the .env file and restart the server.")


def _gemini_text_raw(prompt, max_tokens=8000):
    """Plain-text Gemini call (no JSON constraint) for free-form answers."""
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.5,
            # grosszuegig bemessen: die Modelle denken zuerst nach und
            # verbrauchen dafuer einen Teil von maxOutputTokens. Zu knappe
            # Werte fuehren zu leeren Antworten ohne Fehlermeldung.
            "maxOutputTokens": max_tokens
        }
    }
    text, _model = _gemini_call(payload, label="text-raw")
    return text


@app.route('/api/text-ai', methods=['POST'])
@api_login_required
def api_text_ai():
    """Cloud fallback for the in-browser AI: generate JSON from a prompt.

    Works on ANY device/browser (no WebGPU needed). Requires GEMINI_API_KEY
    in .env; the client tries the in-browser model first and falls back here.
    """
    data = request.get_json(force=True, silent=True) or {}
    prompt = data.get("prompt", "")
    if not prompt:
        return jsonify({"ok": False, "error": "No prompt provided."}), 400
    if not GEMINI_API_KEY:
        return jsonify({
            "ok": False,
            "error": "no_key",
            "key_missing": True,
            "message": _key_missing_message()
        }), 200

    import time
    last_exc = None
    for attempt in range(3):
        try:
            if data.get("plain"):
                return jsonify({"ok": True, "text": _gemini_text_raw(prompt)})
            result = _gemini_text_json(prompt)
            return jsonify({"ok": True, "data": result})
        except _GeminiError as exc:
            last_exc = exc
            msg = str(exc).lower()
            if "503" in msg or "service unavailable" in msg or "overloaded" in msg:
                if attempt < 2:
                    time.sleep(1.5)
                    continue
            break
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            break

    # Log: volle Diagnose (serverintern). Antwort: bereinigt und ohne Key.
    app.logger.error("text-ai error: %s", _scrub(last_exc))
    detail = _scrub(last_exc)
    return jsonify({
        "ok": False,
        "error": "Cloud AI failed: " + detail,
        "reason": detail,
        "models_tried": GEMINI_MODELS
    }), 503


@app.route('/api/describe-clothing', methods=['POST'])
@api_login_required
def describe_clothing():
    data = request.get_json(force=True, silent=True) or {}
    image = data.get("image", "")
    name = data.get("name", "")

    if not image:
        return jsonify({"ok": False, "error": "No image provided."}), 200

    if not GEMINI_API_KEY:
        return jsonify({
            "ok": False,
            "key_missing": True,
            "error": _key_missing_message()
        }), 200

    try:
        result = _gemini_describe(image, name)
        result["ok"] = True
        return jsonify(result)
    except Exception as exc:  # noqa: BLE001 - surface anything to the client
        app.logger.error("Vision error: %s", _scrub(exc))
        detail = _scrub(exc)
        return jsonify({
            "ok": False,
            "error": "Vision analysis failed: " + detail,
            "reason": detail,
            "models_tried": GEMINI_MODELS,
            "key_missing": False
        }), 200


@app.route('/api/search', methods=['POST'])
@api_login_required
def api_search():
    """Serper-Proxy für Produkt-, Video- und Bildersuche.

    Früher stand der Serper-Schlüssel direkt im Browser-JavaScript — dort
    konnte ihn jeder mitlesen und für seine eigenen Zwecke missbrauchen.
    Jetzt bleibt er auf dem Server und das Ergebnis wird hier verkleinert
    (nur relevante Felder, nur http/https-Links), damit keine ungewollten
    Daten zum Client durchrutschen.
    """
    # Quota-Schutz: nicht mehr als 40 Suchanfragen pro Minute und Konto.
    if not _rate_check("search:" + str(session.get("uid")), limit=40, window_s=60):
        return jsonify({"ok": False, "error": "Too many searches. Wait a moment."}), 429

    d = request.get_json(silent=True) or {}
    kind = d.get("type", "shopping")
    q = (d.get("q") or "").strip()
    try:
        num = min(int(d.get("num") or 6), 12)
    except (TypeError, ValueError):
        num = 6

    if not q or len(q) > 200:
        return jsonify({"ok": False, "error": "Missing search query."}), 400
    if kind not in ("shopping", "videos", "images"):
        return jsonify({"ok": False, "error": "Unknown search type."}), 400
    if not SERPER_API_KEY:
        return jsonify({"ok": False, "error": "Server has no SERPER_API_KEY configured."}), 200

    try:
        resp = requests.post(
            f"https://google.serper.dev/{kind}",
            headers={"X-API-KEY": SERPER_API_KEY},
            json={"q": q, "num": num},
            timeout=20,
        )
    except requests.RequestException:
        return jsonify({"ok": False, "error": "Search service unreachable. Try again."}), 502
    if resp.status_code != 200:
        return jsonify({"ok": False, "error": f"Search backend error ({resp.status_code})."}), 502

    data = resp.json()

    def clean_url(u):
        # Nur echte Web-Links durchlassen, keine javascript:- oder data:-URLs.
        if not isinstance(u, str):
            return ""
        u = u.strip()
        return u if urlparse(u).scheme in ("http", "https") else ""

    out = {"ok": True}
    if kind == "shopping":
        items = []
        for it in (data.get("shopping") or [])[:num]:
            link = clean_url(it.get("link"))
            if not link:
                continue
            price = it.get("price")
            price = float(re.sub(r"[^0-9.]", "", str(price))) if price else None
            if price is None:
                continue  # nur wirklich kaufbare Artikel mit Preis
            items.append({
                "title": str(it.get("title") or "Product")[:180],
                "price": price,
                "link": link,
                "img": clean_url(it.get("imageUrl")) or "https://placehold.co/100x100?text=Shop",
                "merchant": str(it.get("source") or "ONLINE STORE").upper()[:60],
            })
        out["shopping"] = items
    elif kind == "videos":
        out["videos"] = [{
            "title": str(v.get("title") or "Video")[:200],
            "link": clean_url(v.get("link")),
            "imageUrl": clean_url(v.get("imageUrl")),
            "channel": str(v.get("channel") or "")[:120],
            "duration": str(v.get("duration") or "")[:30],
        } for v in (data.get("videos") or [])[:num] if clean_url(v.get("link"))]
    else:  # images
        out["images"] = [{
            "title": str(i.get("title") or "")[:200],
            "imageUrl": clean_url(i.get("imageUrl")),
        } for i in (data.get("images") or [])[:num] if clean_url(i.get("imageUrl"))]
    return jsonify(out)


if __name__ == "__main__":
    # Der Port ist der häufigste Streitpunkt: bricht ein Server mal falsch
    # ab, bleibt der Port eine Weile blockiert. Deshalb haben wir das:
    #  1. AESTRA_PORT=x startet auf einem festen Port.
    #  2. Ist dieser Port belegt, suchen wir uns automatisch den nächsten
    #     freien Port und melden die Adresse deutlich — kein
    #     "Address already in use"-Crash mehr beim Starten.
    # Neu starten nach Änderungen: ./run.sh (beendet alte Instanz zuerst).
    # Auf einem Hosting-Anbieter muss auf 0.0.0.0 gebunden werden, sonst
    # erreicht der Router des Anbieters die App nicht. Oeffentlich ist
    # 0.0.0.0 auch lokal sinnvoll (Handy im selben WLAN).
    host = os.environ.get("AESTRA_HOST", "0.0.0.0")
    # Reihenfolge: PORT (Render/Railway/Fly setzen das) -> AESTRA_PORT -> 5001
    preferred = int(os.environ.get("PORT") or os.environ.get("AESTRA_PORT") or "5001")

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        # SO_REUSEADDR einschalten, genauso wie es der spätere echte Server
        # (Werkzeug) macht. Ohne dieses Flag meckert der Probe-Bind an
        # halb-geöffneten Altverbindungen (TIME_WAIT/CLOSE_WAIT) — der Port
        # wäre in Wahrheit nutzbar, aber wir würden unnötig auf einen
        # Zufallsport ausweichen. Genau das war das "Port-Problem" von früher.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, preferred))
            port = preferred
        except OSError:
            port = None
    if port is None:
        # Belegter Port: einfach einen freien vom System geben lassen.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind((host, 0))
            port = probe.getsockname()[1]

    # Persönliche Dateien nur für den eigenen User zugänglich machen (0600):
    # .secret_key (fälschbare Sessions), .env (API-Keys) und die Datenbank
    # mit den Benutzer- und Kleidungsdaten.
    for _f in (os.path.join(BASE_DIR, ".secret_key"),
               os.path.join(BASE_DIR, ".env"),
               DB_PATH):
        try:
            if os.path.exists(_f):
                os.chmod(_f, 0o600)
        except OSError:
            pass

    # HTTPS-Entscheidung (siehe Erklärung im Config-Block):
    #   - Zwang über AESTRA_HTTPS=1/0
    #   - ansonsten: am eigenen Rechner (Loopback) HTTP ohne Warnung,
    #     bei LAN-Zugriff (Handy) automatisch HTTPS wenn Zertifikate da sind.
    force_https = os.environ.get("AESTRA_HTTPS")
    loopback = host in ("127.0.0.1", "localhost", "::1")
    if force_https == "1":
        use_https = True
    elif force_https == "0":
        use_https = False
    else:
        use_https = _SSL_PRESENT and not loopback

    if use_https and not _SSL_PRESENT:
        print("\n  ⚠️  HTTPS angefordert, aber certs/ fehlt. "
              "Zertifikate erzeugen mit  ./make_cert.sh")
        use_https = False

    # Secure-Flag nur dann setzen, wenn wirklich über TLS ausgeliefert wird,
    # sonst zerstören wir den Session-Login über HTTP (Cookie wird abgelehnt).
    # Hinter einem Proxy (Render/Railway) terminiert TLS der Anbieter,
    # Flask sieht nur "http". Deshalb lässt sich das Secure-Flag dort
    # nicht ableiten, sondern muss explizit gesetzt werden.
    # Der Import hat das Flag schon gesetzt, wenn es erzwungen wurde —
    # hier nur noch das Ergebnis der echten Zertifikats-Erkennung nachziehen.
    app.config["SESSION_COOKIE_SECURE"] = (
        use_https or os.environ.get("FORCE_SECURE_COOKIES", "") == "1"
    )

    scheme = "https" if use_https else "http"
    print(f"\n  ✨ Aestra läuft jetzt auf  {scheme}://{host}:{port}  (Port automatisch gefunden)\n")
    if use_https:
        # Selbstsignierte Zertifikate aus certs/ (./make_cert.sh erstellt sie).
        # Am Handy einmal die cert.pem importieren/vertrauen, dann geht auch
        # die Kamera im WLAN über HTTPS.
        print("     🔒 TLS aktiv für den Zugriff von außen (Handy).\n"
              "     Am eigenen Rechner nutzt du einfach http://127.0.0.1:5001 — \n"
              "     dort gilt die Kamera auch ohne Zertifikat als sicher.\n")
        app.run(debug=(os.environ.get("AESTRA_DEBUG", "0") == "1"),
                use_reloader=False, host=host, port=port,
                ssl_context=(_SSL_CERT, _SSL_KEY))
    else:
        app.run(debug=(os.environ.get("AESTRA_DEBUG", "0") == "1"),
                use_reloader=False, host=host, port=port)