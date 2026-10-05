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

    /* ------------------------------------------------------------
       iOS / iPadOS kennt kein beforeinstallprompt — das Ereignis
       feuert dort nie. Vorher blieb der Installationsknopf auf dem
       iPhone und iPad einfach unsichtbar, ohne jeden Hinweis.
       Dort gibt es nur den manuellen Weg: Teilen -> "Zum
       Home-Bildschirm".
       ------------------------------------------------------------ */
    function isIosSafari() {
        var ua = navigator.userAgent;
        var iOS = /iPad|iPhone|iPod/.test(ua) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        // Im bereits installierten Zustand (standalone) nicht mehr anbieten
        var standalone = window.matchMedia('(display-mode: standalone)').matches ||
                          window.navigator.standalone === true;
        return iOS && !standalone;
    }

    function showIosInstallHint() {
        var btn = document.getElementById('pwa-install-btn');
        if (!btn) return;
        if (window.__pwaInstalled) return;

        var steps = window.T
            ? window.T('pwa.iosHint')
            : 'Tap the Share button (□↑), then choose "Add to Home Screen".';

        // Schon einmal gezeigt? Dann nur den Knopf anbieten.
        if (!btn.__iosHintReady) {
            btn.__iosHintReady = true;
            var holder = btn.parentElement;
            var note = document.createElement('p');
            note.id = 'pwa-ios-note';
            note.style.cssText = 'text-align:center; margin-top:10px; font-size:12px; ' +
                                 'color:var(--muted); display:none;';
            note.textContent = steps;
            note.setAttribute('data-i18n', 'pwa.iosHint');
            if (holder && holder.parentElement) {
                holder.parentElement.insertBefore(note, holder.nextSibling);
            }
            btn.addEventListener('click', function () {
                if (note.style.display === 'none') note.style.display = 'block';
            });
        }
        /* Auf iOS installiert ein Klick nichts — der Text muss also
           vom Knopf zur Anleitung fuehren, sonst fuehlt sich der Knopf
           tot an. */
        btn.setAttribute('data-i18n', 'pwa.iosBtn');
        if (window.T) btn.textContent = window.T('pwa.iosBtn');
        btn.style.display = 'inline-flex';
    }

    if (isIosSafari()) showIosInstallHint();

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