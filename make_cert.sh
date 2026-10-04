#!/usr/bin/env bash
# Aestra — selbstsignierte HTTPS-Zertifikate erzeugen.
#
# Warum? Die Beauty-Kamera (MediaPipe) darf INS Browser-Aufforderung nur in
# einem "sicheren Kontext": HTTPS oder 127.0.0.1. Am Handy im WLAN funktioniert
# die Kamera deshalb nur, wenn der Server verschlüsselt läuft und das Handy
# unserem Zertifikat vertraut.
#
# So geht's:
#   1. ./make_cert.sh
#   2. ./run.sh            → der Server startet automatisch mit HTTPS
#   3. Auf dem Handy die Datei  certs/cert.pem  installieren
#      (z. B. per Mail/AirDrop an das Telefon schicken und dort öffnen) und
#      unter "Einstellungen → Allgemein → VPN & Geräteverwaltung" als
#      vertrauenswürdig aktivieren (iOS).
#   4. Am Handy im selben WLAN:  https://<LAN-IP>:5001  öffnen

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl ist nicht installiert — aber das brauchen wir für HTTPS."
    exit 1
fi

mkdir -p certs

# Sammle die IPs, die später im Zertifikat gültig sein sollen:
# localhost, 127.0.0.1 und alle LAN-/WLAN-Adressen dieses Geräts.
SAN_IPS=$(python3 - <<'PY'
import socket
addrs = {"127.0.0.1"}
try:
    addrs.add(socket.gethostbyname(socket.gethostname()))
except Exception:
    pass
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("8.8.8.8", 80))
    addrs.add(s.getsockname()[0])
    s.close()
except Exception:
    pass
print(",".join("IP:" + ip for ip in sorted(addrs)))
PY
)
SAN="DNS:localhost,$SAN_IPS"
echo "Zertifikat wird für folgende Adressen ausgestellt:  $SAN"

# OpenSSL-Konfiguration: SAN (Subject Alternative Names) gehört, damit der
# Browser "localhost"/die IP nicht wegen Hostname-Mismatch ablehnt.
CONF=$(mktemp)
trap 'rm -f "$CONF"' EXIT
cat > "$CONF" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = Aestra Local
[ext]
subjectAltName = $SAN
extendedKeyUsage = serverAuth
EOF

# -addext existiert bei LibreSSL nicht → erst so versuchen, sonst Config-Datei.
if openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
    -keyout certs/key.pem -out certs/cert.pem \
    -subj "/CN=Aestra Local" \
    -addext "subjectAltName=$SAN" \
    -addext "extendedKeyUsage=serverAuth" 2>/dev/null; then
    :
else
    openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
        -keyout certs/key.pem -out certs/cert.pem \
        -subj "/CN=Aestra Local" \
        -extensions ext -config "$CONF"
fi

chmod 600 certs/key.pem
echo ""
echo "  ✅ Fertig!  →  ./run.sh  startet jetzt mit HTTPS (https://localhost:5001)"
echo "     Für das Handy: certs/cert.pem dorthin übertragen und vertrauen."