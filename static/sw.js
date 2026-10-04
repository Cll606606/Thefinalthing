/* ============================================================
   SERVICE WORKER — My Style
   ------------------------------------------------------------
   Strategie:
   - App-Shell (HTML/CSS/JS/Icons): Cache-First. Die App startet
     auch ohne Netz, weil alle Seiten server-rendered sind und die
     static files lokal liegen.
   - /api/*: NIEMALS cachen. Sonst wuerden Antworten mit
     fremden Daten (Kleiderschrank, KI-Antworten) ausgeliefert.
   - CDN (MediaPipe): Cache-First mit Limit, sonst laesst die
     Gesichtsanalyse im Offline-Modus sofort scheitern.
   ============================================================ */

const VERSION = 'v1';
const SHELL_CACHE = `styleai-shell-${VERSION}`;
const CDN_CACHE = `styleai-cdn-${VERSION}`;
const MAX_CDN = 40;

/* Seiten, die ohne Netz zwingend verfuegbar sein muessen. */
const SHELL_ASSETS = [
    '/static/css/base.css',
    '/static/css/style.css',
    '/static/js/i18n.js',
    '/static/js/app-ui.js',
    '/static/js/camera.js',
    '/static/js/ai-logic.js',
    '/static/icons/icon-192.png',
    '/static/icons/icon-512.png',
    '/static/icons/logo.svg',
    '/static/favicon.png',
    '/static/manifest.json'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())
            .catch(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((k) => k.startsWith('styleai-') && k !== SHELL_CACHE && k !== CDN_CACHE)
                    .map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

function isCdn(url) {
    return url.hostname === 'cdn.jsdelivr.net';
}

async function trimCache(cacheName, max) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= max) return;
    await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    /* 1) API und Nutzerdaten niemals aus dem Cache liefern. */
    if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(req).catch(() => new Response(
                JSON.stringify({
                    ok: false,
                    error: 'offline',
                    message: 'Offline — keine Verbindung zum Server.'
                }),
                { status: 503, headers: { 'Content-Type': 'application/json' } }
            ))
        );
        return;
    }

    /* 2) Medien/Blob nicht anfassen (Kamera-Streams, Daten-URLs). */
    if (url.protocol === 'blob:' || url.protocol === 'data:') return;

    /* 3) CDN: Cache-First, damit FaceMesh offline startet. */
    if (isCdn(url)) {
        event.respondWith(
            caches.open(CDN_CACHE).then(async (cache) => {
                const hit = await cache.match(req);
                if (hit) return hit;
                try {
                    const res = await fetch(req);
                    if (res && res.ok) {
                        await cache.put(req, res.clone());
                        trimCache(CDN_CACHE, MAX_CDN);
                    }
                    return res;
                } catch (e) {
                    return new Response('', { status: 504 });
                }
            })
        );
        return;
    }

    /* 4) Navigation: Netz zuerst, Cache als Rueckfall. So bekommt man
          nach einem Update keine alte HTML-Datei ohne neue Logik. */
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).then((res) => {
                if (res && res.ok) {
                    const copy = res.clone();
                    caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
                }
                return res;
            }).catch(async () => {
                const cached = await caches.match(req);
                return cached || caches.match('/login') ||
                    new Response(
                        '<!doctype html><meta charset="utf-8">' +
                        '<title>Offline</title>' +
                        '<body style="background:#000;color:#fff;font:16px system-ui;' +
                        'display:grid;place-items:center;height:100vh;margin:0;text-align:center">' +
                        '<div><h1 style="letter-spacing:.05em">Offline</h1>' +
                        '<p>Keine Verbindung. Zum Fortsetzen online gehen.</p></div>',
                        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
                    );
            })
        );
        return;
    }

    /* 5) Statische Dateien: Cache-First. */
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(req).then((hit) => {
                if (hit) return hit;
                return fetch(req).then((res) => {
                    if (res && res.ok && res.type === 'basic') {
                        const copy = res.clone();
                        caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
                    }
                    return res;
                });
            })
        );
    }
});

/* Der Browser kann eine Aktualisierung anfordern (z. B. nach dem Login). */
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') self.skipWaiting();
});