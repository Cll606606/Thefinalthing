#!/usr/bin/env python3
"""Lokaler Pruef-Server fuer tools/run_checks.sh.

Ausgeliefert wird das Projektverzeichnis wie python3 -m http.server.
Zusaetzlich nimmt POST /__e2e-result das Ergebnis des Browser-Checks
entgegen und schreibt es nach tools/.e2e-result.txt.

Grund: --dump-dom enthaelt das Ergebnis erst, wenn die Seite geladen
ist, --virtual-time-budget haengt, sobald MediaPipe das Modell laedt.
Deshalb schickt check_e2e.html seinen Text selbst an uns.
"""
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULT = os.path.join(ROOT, 'tools', '.e2e-result.txt')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # Gleiche CSP wie app.py: DAS ist der entscheidende Unterschied zu
        # python3 -m http.server. Das MediaPipe-WASM bewertet JS-Strings
        # (eval/Function), also muss 'unsafe-eval' dort stehen, sonst faehrt
        # die Erkennung tot — genau der Fall aus dem Beauty Lab.
        self.send_header('Content-Security-Policy',
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' "
            "https://cdn.jsdelivr.net https://www.youtube.com https://www.youtube-nocookie.com; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src * data: blob:; "
            "font-src 'self' data:; "
            "connect-src 'self' https://cdn.jsdelivr.net; "
            "media-src 'self' blob:; "
            "frame-src https://www.youtube.com https://www.youtube-nocookie.com; "
            "worker-src 'self' blob: https://cdn.jsdelivr.net; "
            "manifest-src 'self'; "
            "object-src 'none'; base-uri 'self'; form-action 'self'")
        super().end_headers()

    def do_POST(self):
        if self.path.split('?')[0] != '/__e2e-result':
            self.send_error(404)
            return
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n)
        # Anhaengen: LOG/PULS-Zeilen duerfen das Endergebnis nicht
        # ueberschreiben, und umgekehrt.
        with open(RESULT, 'ab') as f:
            f.write(body.rstrip(b'\n') + b'\n')
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8951
    with socketserver.ThreadingTCPServer(('127.0.0.1', port), Handler) as srv:
        srv.serve_forever()
