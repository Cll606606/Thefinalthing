# ============================================================
#  Produktions-Image für Render / Railway / Fly.io
# ============================================================
#  Build:  docker build -t my-style .
#  Start:  docker run -p 5001:5001 -e SECRET_KEY=... my-style
# ============================================================

FROM python:3.12-slim

# curl wird nur für den Health-Check des Anbieters gebraucht
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Abhaengigkeiten zuerst: eigene Layer, die der Build-Cache nutzen kann
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cache-Version des Service Workers an diesen Build binden
RUN python stamp_sw.py

# Datenbank der Standardablage in /data legen — dort kann ein
# persistenter Plattenlauf gemountet werden.
RUN mkdir -p /data
ENV DATABASE_PATH=/data/styleai.db \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AESTRA_DEBUG=0 \
    AESTRA_HOST=0.0.0.0 \
    PORT=5001

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5001/healthz || exit 1

# Gunicorn statt des Flask-Entwicklungs servers: der Dev-Server ist
# einbahnstrasse (kein HTTPS, ein Worker, Debug-Konsole).
CMD ["sh", "-c", "gunicorn app:app --bind 0.0.0.0:${PORT:-5001} --workers 2 --threads 4 --timeout 120 --access-logfile - --error-logfile -"]