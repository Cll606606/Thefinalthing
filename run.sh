#!/usr/bin/env bash
# Aestra sauber starten — beseitigt das nervige "Port schon belegt"-Problem.
#
# Warum überhaupt ein Skript? Wenn der Server vorher abgestürzt ist oder du
# mehrfach gestartet hast, hängt oft noch eine alte Instanz auf dem Port.
# Dann meckert der Port — nicht weil die App kaputt ist, sondern weil er
# noch besetzt ist. Dieses Skript räumt zuverlässig auf und startet frisch.
#
# Optional:
#   AESTRA_PORT=5050 ./run.sh    → fester Port
#   AESTRA_HOST=0.0.0.0 ./run.sh → auch übers WLAN vom Handy erreichbar
#
# HTTPS: Liegen certs/cert.pem + key.pem vor, läuft die App automatisch
# verschlüsselt (nötig für die Kamera am Handy). Zertifikate erzeugen mit:
#   ./make_cert.sh

cd "$(dirname "$0")" || exit 1

echo "Beende alte Aestra-Instanzen ..."
pkill -f "app.py" 2>/dev/null
sleep 1

if [ -f certs/cert.pem ] && [ -f certs/key.pem ]; then
    HOST="${AESTRA_HOST:-127.0.0.1}"
    PORT="${AESTRA_PORT:-5001}"
    if [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ]; then
        echo "  ℹ️  Lokaler Zugriff: läuft über http://$HOST:$PORT — keine Browser-Warnung,"
        echo "     die Kamera funktioniert hier auch ohne Zertifikat."
        echo "  📱  Handy im WLAN:  AESTRA_HOST=0.0.0.0 ./run.sh  → startet automatisch mit HTTPS."
    else
        echo "  🔒 Zugriff von außen: HTTPS aktiv (https://$HOST:$PORT)."
        echo "  Fürs Handy: certs/cert.pem dorthin übertragen und als vertrauenswürdig markieren."
    fi
else
    echo "  ℹ️  Kein certs/ gefunden — fürs Handy (HTTPS + Kamera): ./make_cert.sh"
fi

echo "Starte Aestra neu ..."
exec python3 app.py