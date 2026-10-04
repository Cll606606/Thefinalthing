/* ============================================================
   app-ui.js — kleine Helfer, die auf allen Seiten gleich sind
   ------------------------------------------------------------
   - logOut(): sicher abmelden und zurück zum Login
   - toast():  kurze Erfolgs-/Fehlermeldung unten zeigen
   - markNavActive(): den aktiven Eintrag in der Navigation markieren
   - escHtml()/safeUrl(): XSS-Schutz für Inhalte, die in innerHTML
     eingesetzt werden (KI-Ergebnisse, Such-Titel, Benutzereingaben)
   ============================================================ */

/* HTML-Escaping: verwandelt < > & " ' in harmlose Platzhalter, damit
   fremde Inhalte (KI-Antworten, Suchtreffer) nie als Code ausgeführt
   werden, sondern nur als Text angezeigt werden. */
window.escHtml = function (val) {
    return String(val == null ? '' : val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

/* Lässt nur echte Web-Links durch (keine javascript:, data:, vbscript:),
   z. B. für href=/src= Attribute aus externen Quellen. */
window.safeUrl = function (url) {
    const u = String(url == null ? '' : url).trim();
    return /^https?:\/\//i.test(u) ? u : '#';
};

window.logOut = async function (e) {
    if (e && e.preventDefault) e.preventDefault();
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (err) {}
    location.href = '/login';
};

window.toast = function (msg, isError) {
    let el = document.getElementById('toast');
    if (!el) {
        // Toast-Element existiert noch nicht → einfach anlegen.
        el = document.createElement('div');
        el.id = 'toast';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
};

/* Markiert den passenden Bottom-/Desktop-Nav-Knopf anhand der Daten-
   Eigenschaft data-active-for. Jede Seite sagt damit, wo sie steht. */
window.markNavActive = function (key) {
    document.querySelectorAll('.nav-item').forEach(item => {
        if (item.dataset.page === key) item.classList.add('active');
    });
    document.querySelectorAll('.desktop-nav a').forEach(item => {
        if (item.dataset.page === key) item.classList.add('active');
    });
};