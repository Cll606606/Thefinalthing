/* ============================================================
   PWA-Registrierung
   ------------------------------------------------------------
   Wird auf jeder Seite geladen. Ohne Service Worker laeuft die
   App normal weiter — die Registrierung istrein zusaetzlich,
   damit auf Servern ohne HTTPS (z. B. beim Teilen ueber LAN)
   keine Konsolenfehler entstehen.
   ============================================================ */

(function () {
    'use strict';

    if (!('serviceWorker' in navigator)) return;

    /* Registrierung nur bei sicherem Kontext. localhost gilt als
       sicher, daher funktioniert der Test auch ohne TLS. */
    var secure = window.isSecureContext ||
                 location.protocol === 'https:' ||
                 location.hostname === 'localhost' ||
                 location.hostname === '127.0.0.1';
    if (!secure) return;

    window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
            .then(function (reg) {
                reg.addEventListener('updatefound', function () {
                    var sw = reg.installing;
                    if (!sw) return;
                    sw.addEventListener('statechange', function () {
                        /* Neue Version da und bereits aktiv: einmal neu
                           laden, damit die neue Logik greift. */
                        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                            window.__pwaUpdateReady = true;
                        }
                    });
                });
            })
            .catch(function () {
                /* Kein Service Worker (z. B. bei file:// oder blockiert) —
                   die App funktioniert ohnehin normal weiter. */
            });
    });

    /* Anleitung fuer die Installation anbieten, wenn der Browser
       es unterstuetzt (Chrome/Edge/Android). */
    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        window.__pwaInstallPrompt = e;

        var btn = document.getElementById('pwa-install-btn');
        if (btn) btn.style.display = 'inline-flex';

        document.addEventListener('click', function onClick(ev) {
            if (!ev.target.closest || !ev.target.closest('#pwa-install-btn')) return;
            e.prompt();
            window.__pwaInstallPrompt = null;
            if (btn) btn.style.display = 'none';
            document.removeEventListener('click', onClick);
        });
    });

    window.addEventListener('appinstalled', function () {
        window.__pwaInstalled = true;
        var btn = document.getElementById('pwa-install-btn');
        if (btn) btn.style.display = 'none';
    });
})();