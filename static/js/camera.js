const video = document.getElementById("video");
const canvas = document.getElementById("face-canvas");
const ctx = canvas.getContext("2d");

/* Quelle für MediaPipe + Hautton-Analyse: normalerweise das Live-Video.
   Nach einem Foto-Upload wird hier das hochgeladene <img> verwendet. */
let analysisSource = video;
window.photoMode = false;

/* ============================================================
   FEATURE OUTPUT
   ============================================================ */

window.features = {
    face: "--",
    eyes: "--",
    lips: "--",
    brows: "--",
    tone: "--",
    cheekbones: "--",
    eyeTilt: "--"
};

window.showMap = false;

/* Landmark-Punkte: standardmaessig AN. Man soll sehen, was die
   Gesichtserkennung wirklich sieht — 468 Punkte, die Masche dazwischen
   und die Strecken, aus denen die Kennzahlen entstehen. */
window.showLandmarks = true;

/* Die Kamera- und Foto-Vorschau ist gespiegelt (wie im Spiegel, CSS
   transform: scaleX(-1)). Die Landmarks kommen aber im ROH-
   Koordinatenraum des Streams: ohne Spiegeln beim Zeichnen sessen die
   Punkte links statt rechts — und das wuerde man sofort sehen. */
window.mirrorPreview = true;

/* Guide lines shown on the camera while scanning (passport-photo style).
   The user can toggle them and can also freely retype every detected
   feature in the manual override inputs. */
window.showGuide = true;
window.editedInputs = new Set();
window.markEdited = (id) => window.editedInputs.add(id);

function drawGuide(ctx, w, h) {
    if (!window.showGuide) return;
    ctx.save();
    ctx.lineWidth = 2;
    /* vertical center line */
    ctx.strokeStyle = "rgba(20,184,166,0.40)";
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(w / 2, h * 0.10);
    ctx.lineTo(w / 2, h * 0.90);
    ctx.stroke();
    /* horizontal eye-guide line */
    ctx.strokeStyle = "rgba(20,184,166,0.55)";
    ctx.beginPath();
    ctx.moveTo(w * 0.16, h * 0.42);
    ctx.lineTo(w * 0.84, h * 0.42);
    ctx.stroke();
    /* face oval */
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = "rgba(20,184,166,0.65)";
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.44, w * 0.21, h * 0.31, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

window.toggleGuide = (btn) => {
    window.showGuide = !window.showGuide;
    const lbl = btn && btn.querySelector('#guide-label');
    const target = lbl || btn;
    if (target) {
        const t = window.T ? window.T : (k) => k;
        target.textContent = '🔲 ' + (window.showGuide ? t('beauty.guideOn') : t('beauty.guideOff'));
    }
};


/* ============================================================
   MESSKARTE
   ------------------------------------------------------------
   Die Hilfslinien oben sind statisch: sie liegen an festen
   Bildpositionen und sagen nichts darueber, WAS gemessen wird.
   Die Messkarte zeichnet dagegen die Landmarks selbst und die
   Strecken, aus denen die Kennzahlen entstehen. Sie haengt
   deshalb zwangslaeufig am Gesicht — bewegt sich das Gesicht,
   bewegt sich die Karte mit.

   Sie beantwortet drei Fragen, die im sonstigen UI unsichtbar
   bleiben:
     1. Welche Punkte werden ueberhaupt verwendet?
     2. Welche Strecke ergibt welchen Zahlenwert?
     3. Wie entwickelt sich der Wert, und wo liegt der Median?

   Wichtig: Gezeichnet wird in den ROH-Koordinaten aus
   window._lastLandmarks (x*Breite, y*Hoehe). Die
   Seitenverhaeltnis-Korrektur aus handleResults gehoert NICHT
   zum Zeichnen — sie macht die Einheiten der beiden Achsen
   gleich, wuerde das Bild aber verzerren, wenn man sie auch
   hier anwenden wuerde.
   ============================================================ */

/* Die fuenf Grundmessungen. Genau diese Strecken ergeben L, Wf,
   Wc, Wj und die Kinnbreite — alles Weitere ist daraus abgeleitet. */
const MAP_SEGMENTS = [
    { a: 10, b: 152, key: 'L', color: '#5ef2c3' },
    { a: 234, b: 454, key: 'Wc', color: '#7dd3fc' },
    { a: 103, b: 332, key: 'Wf', color: '#c4b5fd' },
    { a: 172, b: 397, key: 'Wj', color: '#fcd34d' },
    { a: 136, b: 148, key: 'chinWidth', color: '#f9a8d4' }
];

/* Lidspalte: drei Strecken je Auge, daraus der Median. */
const MAP_APERTURE = [
    [145, 159], [144, 160], [153, 158],
    [374, 386], [373, 387], [380, 385]
];

/* Lippenhoehe: drei vertikale Strecken. */
const MAP_LIP_HEIGHT = [[13, 14], [82, 87], [312, 317]];

/* Brauenbogen: innerer Endpunkt -> Scheitel -> aeusserer Endpunkt. */
const MAP_BROWS = [[107, 105, 53], [336, 334, 283]];

/* Hautton-Stichproben. */
const MAP_TONE = [50, 101, 118, 187, 205, 280, 330, 347, 411, 425];

/* Alle Punkte, die in eine Auswertung eingehen — heller als der Rest. */
const MAP_USED = (() => {
    const s = new Set();
    MAP_SEGMENTS.forEach(g => { s.add(g.a); s.add(g.b); });
    MAP_APERTURE.forEach(p => { s.add(p[0]); s.add(p[1]); });
    MAP_LIP_HEIGHT.forEach(p => { s.add(p[0]); s.add(p[1]); });
    MAP_BROWS.forEach(p => p.forEach(i => s.add(i)));
    [33, 133, 362, 263, 78, 308, 70, 300].forEach(i => s.add(i));
    MAP_TONE.forEach(i => s.add(i));
    return s;
})();


/* ============================================================
   LANDMARK-EBENE — die Punkte selbst, so wie MediaPipe sie liefert
   ------------------------------------------------------------
   Die Hilfslinien sind statisch: ein gedrucktes Oval, das nichts mit
   dem Gesicht zu tun hat. Diese Ebene zeigt dagegen genau das, was
   die Messung wirklich benutzt: 468 Punkte, die Masche dazwischen
   und die Konturen von Augen, Brauen und Lippen.
   ============================================================ */

/* x-Spiegelung der Vorschau (siehe window.mirrorPreview). */
function mapX(nx, w) {
    return (window.mirrorPreview === false ? nx : 1 - nx) * w;
}

/* Rahmen des Videos auf die Anzeigeflaeche abbilden — also das
   nachbilden, was object-fit:cover mit dem Bild macht. Ohne diese
   Rechnung liegen die Punkte neben dem Gesicht, sobald Bild und
   Rahmen ein anderes Seitenverhaeltnis haben (typisch 4:3-Stream
   in einem 3:4-Rahmen: bis zu 100 px daneben). */
function overlayTransform(boxW, boxH, srcW, srcH) {
    const s = Math.max(boxW / srcW, boxH / srcH);
    return {
        scale: s,
        dx: (boxW - srcW * s) / 2,
        dy: (boxH - srcH * s) / 2
    };
}
window.overlayTransform = overlayTransform;

/* Verbindungsliste direkt aus dem MediaPipe-Modul (FACEMESH_*), damit
   die Masche exakt zum Modell passt und keine Kanten erfunden werden.
   Faehlt das Modul (CDN blockiert / offline), bleiben die Punkte allein
   stehen — gezeichnet wird trotzdem. */
function meshPairs(name) {
    try {
        const v = window[name];
        return Array.isArray(v) ? v : [];
    } catch (e) {
        return [];
    }
}

const MESH = {
    tesselation: meshPairs('FACEMESH_TESSELATION'),
    contours: meshPairs('FACEMESH_CONTOURS')
        .concat(meshPairs('FACEMESH_FACE_OVAL'))
        .concat(meshPairs('FACEMESH_LIPS'))
        .concat(meshPairs('FACEMESH_LEFT_EYE'), meshPairs('FACEMESH_RIGHT_EYE'))
        .concat(meshPairs('FACEMESH_LEFT_EYEBROW'), meshPairs('FACEMESH_RIGHT_EYEBROW')),
    iris: meshPairs('FACEMESH_LEFT_IRIS').concat(meshPairs('FACEMESH_RIGHT_IRIS'))
};


function drawLandmarkDots(c, lm, w, h) {

    if (!lm || lm.length < 468) return;

    const X = (i) => mapX(lm[i].x, w);
    const Y = (i) => lm[i].y * h;
    const ok = (i) => lm[i] && Number.isFinite(lm[i].x) && Number.isFinite(lm[i].y);
    const scale = Math.max(0.6, Math.min(w, h) / 480);

    c.save();
    c.lineCap = 'round';

    /* --- 1. Masche: 2528 Kanten, aber EIN Pfad, ein Stroke --------- */
    if (MESH.tesselation.length) {
        c.strokeStyle = 'rgba(94,242,195,0.11)';
        c.lineWidth = Math.max(0.6, 0.8 * scale);
        c.beginPath();
        MESH.tesselation.forEach(p => {
            if (!ok(p[0]) || !ok(p[1])) return;
            c.moveTo(X(p[0]), Y(p[0]));
            c.lineTo(X(p[1]), Y(p[1]));
        });
        c.stroke();
    }

    /* --- 2. Konturen, die eine Gesichter wirklich erkennbar machen -- */
    if (MESH.contours.length) {
        c.strokeStyle = 'rgba(94,242,195,0.60)';
        c.lineWidth = Math.max(1, 1.4 * scale);
        c.beginPath();
        MESH.contours.forEach(p => {
            if (!ok(p[0]) || !ok(p[1])) return;
            c.moveTo(X(p[0]), Y(p[0]));
            c.lineTo(X(p[1]), Y(p[1]));
        });
        c.stroke();
    }

    /* --- 3. Irisringe (nur bei refineLandmarks, Punkte 468+) ------- */
    if (lm.length >= 478 && MESH.iris.length) {
        c.strokeStyle = 'rgba(125,211,252,0.95)';
        c.lineWidth = Math.max(1.2, 1.8 * scale);
        c.beginPath();
        MESH.iris.forEach(p => {
            if (!ok(p[0]) || !ok(p[1])) return;
            c.moveTo(X(p[0]), Y(p[0]));
            c.lineTo(X(p[1]), Y(p[1]));
        });
        c.stroke();
    }

    /* --- 4. alle Punkte -------------------------------------------- */
    const r = Math.max(1, 1.7 * scale);
    c.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < lm.length && i < 468; i++) {
        if (!ok(i)) continue;
        c.fillRect(X(i) - r, Y(i) - r, r * 2, r * 2);
    }

    /* --- 5. die Punkte, die in eine Messung eingehen, heller -------- */
    const ra = Math.max(2.4, 3.2 * scale);
    MAP_USED.forEach(i => {
        if (!ok(i)) return;
        c.fillStyle = '#5ef2c3';
        c.beginPath();
        c.arc(X(i), Y(i), ra, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = 'rgba(6,8,12,0.75)';
        c.lineWidth = Math.max(1, scale);
        c.stroke();
    });

    c.restore();

}


/* Sichtbar machen, ob gerade ueberhaupt ein Gesicht da ist — sonst
   sieht der Nutzer nur die Hilfslinien und weiss nicht, ob die
   Erkennung laeuft oder ob die Kamera nur die Decke filmt. */
let badgeState = null;
let badgeFound = false;
let badgeCount = 0;

function setDetectBadge(found, count, force) {

    badgeFound = !!found;
    badgeCount = count || 0;

    const el = document.getElementById('detect-badge');
    if (!el) return;

    const t = (k, fb) => (window.T ? window.T(k) : fb);
    const text = found
        ? t('beauty.detectOn', 'FACE · {n} POINTS').replace('{n}', String(count))
        : t('beauty.detectOff', 'SEARCHING FOR A FACE…');

    if (!force && text === badgeState) return;
    badgeState = text;

    el.textContent = text;
    el.classList.toggle('on', !!found);

}

/* Vom Sprachwechsel aus neu setzen (Text sonst bis zum naechsten Frame
   in der alten Sprache). */
window.refreshDetectBadge = function () {
    setDetectBadge(badgeFound, badgeCount, true);
};


window.toggleLandmarks = (btn) => {
    window.showLandmarks = !window.showLandmarks;
    const lbl = btn && btn.querySelector('#landmark-label');
    const target = lbl || btn;
    if (target) {
        const t = window.T ? window.T : (k) => k;
        target.textContent = '✨ ' + (window.showLandmarks
            ? t('beauty.landmarksOn', 'Landmark dots: ON')
            : t('beauty.landmarksOff', 'Landmark dots: OFF'));
    }
    /* Sofakt neu zeichnen: sonst bleiben die Punkte bis zum naechsten
       Frame stehen, wenn gerade kein Live-Bild laeuft (Foto-Modus). */
    if (typeof renderOverlay === 'function') renderOverlay();
};


function mapLabel(c, text, x, y, scale, color) {

    c.font = '600 ' + Math.round(12 * scale) + 'px ui-monospace, Menlo, monospace';
    c.textAlign = 'left';
    c.textBaseline = 'middle';

    const wpx = c.measureText(text).width;

    c.fillStyle = 'rgba(6,8,12,0.72)';
    c.fillRect(x - 3 * scale, y - 8 * scale, wpx + 6 * scale, 16 * scale);
    c.fillStyle = color;
    c.fillText(text, x, y);

}


function drawFaceMap(c, lm, w, h) {

    if (!lm || lm.length < 468) return;

    /* Punkte ausserhalb des Bildes nicht zeichnen. */
    const ok = (i) => lm[i] && Number.isFinite(lm[i].x) && Number.isFinite(lm[i].y);

    /* x ueber mapX: die Vorschau ist gespiegelt, die Roh-Landmarks nicht. */
    const X = (i) => mapX(lm[i].x, w);
    const Y = (i) => lm[i].y * h;

    const scale = Math.max(0.6, Math.min(w, h) / 480);
    const fm = window.faceMetrics || {};

    c.save();

    /* --- 1. alle 468 Landmarks, sehr dezent ------------------- */
    c.fillStyle = 'rgba(94,242,195,0.22)';
    for (let i = 0; i < lm.length; i++) {
        const p = lm[i];
        if (!p) continue;
        c.fillRect(mapX(p.x, w) - scale, p.y * h - scale, 2 * scale, 2 * scale);
    }

    /* --- 2. Augenbrauen-Gesackel als feine Linien ------------ */
    c.strokeStyle = 'rgba(196,181,253,0.35)';
    c.lineWidth = Math.max(1, scale);
    MAP_BROWS.forEach(trio => {
        c.beginPath();
        c.moveTo(X(trio[0]), Y(trio[0]));
        c.lineTo(X(trio[1]), Y(trio[1]));
        c.lineTo(X(trio[2]), Y(trio[2]));
        c.stroke();
    });

    /* --- 3. Lippenkontur ------------------------------------- */
    if (ok(78) && ok(308)) {
        c.strokeStyle = 'rgba(249,168,212,0.45)';
        c.lineWidth = Math.max(1, 1.5 * scale);
        c.beginPath();
        c.moveTo(X(78), Y(78));
        c.lineTo(X(308), Y(308));
        c.stroke();
    }

    /* --- 4. die fuenf Grundmessungen ------------------------- */
    c.lineWidth = Math.max(2, 2.5 * scale);
    c.lineCap = 'round';

    MAP_SEGMENTS.forEach(seg => {
        if (!ok(seg.a) || !ok(seg.b)) return;
        c.strokeStyle = seg.color;
        c.beginPath();
        c.moveTo(X(seg.a), Y(seg.a));
        c.lineTo(X(seg.b), Y(seg.b));
        c.stroke();

        /* Endpunkte markieren */
        [seg.a, seg.b].forEach(i => {
            c.fillStyle = seg.color;
            c.beginPath();
            c.arc(X(i), Y(i), 3 * scale, 0, Math.PI * 2);
            c.fill();
        });

        const value = fm[seg.key];
        if (Number.isFinite(value)) {
            const mx = (X(seg.a) + X(seg.b)) / 2;
            const my = (Y(seg.a) + Y(seg.b)) / 2;
            const txt = seg.key + ' ' + (value < 1 ? value.toFixed(3) : value.toFixed(2));
            mapLabel(c, txt, mx + 6 * scale, my - 10 * scale, scale, seg.color);
        }
    });

    /* --- 5. Lidspalten --------------------------------------- */
    c.strokeStyle = 'rgba(94,242,195,0.75)';
    c.lineWidth = Math.max(1.5, 2 * scale);
    MAP_APERTURE.forEach(pair => {
        if (!ok(pair[0]) || !ok(pair[1])) return;
        c.beginPath();
        c.moveTo(X(pair[0]), Y(pair[0]));
        c.lineTo(X(pair[1]), Y(pair[1]));
        c.stroke();
    });

    /* --- 6. Lippenhoehe -------------------------------------- */
    c.strokeStyle = 'rgba(249,168,212,0.75)';
    MAP_LIP_HEIGHT.forEach(pair => {
        if (!ok(pair[0]) || !ok(pair[1])) return;
        c.beginPath();
        c.moveTo(X(pair[0]), Y(pair[0]));
        c.lineTo(X(pair[1]), Y(pair[1]));
        c.stroke();
    });

    /* --- 7. Roll-Referenz fuer den Tilt ---------------------- */
    /* Waagerechte durch die Augenmitten. Der gemessene Tilt ist
       der Winkel zwischen dieser Linie und der Augenlinie — so wird
       sichtbar, dass die Kopfdrehung herausgerechnet wird. */
    if (ok(33) && ok(133) && ok(362) && ok(263)) {
        const eyeMidY = ((Y(33) + Y(133) + Y(362) + Y(263)) / 4);
        const tilt = window.measurements ? window.measurements.tiltDeg : null;

        c.save();
        c.setLineDash([6 * scale, 6 * scale]);
        c.strokeStyle = 'rgba(125,211,252,0.55)';
        c.lineWidth = Math.max(1, scale);
        c.beginPath();
        c.moveTo(w * 0.06, eyeMidY);
        c.lineTo(w * 0.94, eyeMidY);
        c.stroke();
        c.restore();

        /* Augenlinien selbst, dick hervorgehoben */
        c.strokeStyle = '#7dd3fc';
        c.lineWidth = Math.max(2, 2.5 * scale);
        [[33, 133], [362, 263]].forEach(pair => {
            c.beginPath();
            c.moveTo(X(pair[0]), Y(pair[0]));
            c.lineTo(X(pair[1]), Y(pair[1]));
            c.stroke();
        });

        if (Number.isFinite(tilt)) {
            const mx = w * 0.5;
            mapLabel(
                c, 'tilt ' + tilt.toFixed(1) + '\u00B0',
                mx + 8 * scale, eyeMidY - 14 * scale, scale, '#7dd3fc'
            );
        }
    }

    /* --- 8. Hautton-Stichproben ------------------------------ */
    c.strokeStyle = 'rgba(253,186,116,0.9)';
    c.lineWidth = Math.max(1, scale);
    MAP_TONE.forEach(i => {
        if (!ok(i)) return;
        const r = 4 * scale;
        c.strokeRect(X(i) - r, Y(i) - r, r * 2, r * 2);
    });

    /* --- 9. genutzte Punkte hervorheben ----------------------- */
    c.fillStyle = '#ffffff';
    MAP_USED.forEach(i => {
        if (!ok(i)) return;
        c.beginPath();
        c.arc(X(i), Y(i), 2.6 * scale, 0, Math.PI * 2);
        c.fill();
    });

    /* --- 10. Eckfeld mit den eingestuften Werten -------------- */
    const m = window.measurements;
    const rows = [
        ['face', window.features.face, fm.ratio],
        ['eyes', window.features.eyes, m ? m.eyeStable : null],
        ['tilt', window.features.eyeTilt, m ? m.tiltDeg : null],
        ['lips', window.features.lips, m ? m.lipRatio : null],
        ['brows', window.features.brows, m ? m.browArch : null],
        ['cheek', window.features.cheekbones, m ? m.cheekRatio : null],
        ['tone', window.features.tone, null]
    ].filter(r => r[1] && r[1] !== '--');

    if (rows.length) {
        const fs = Math.round(11 * scale);
        const lh = fs * 1.55;
        const pad = 6 * scale;
        const boxW = 168 * scale;
        const boxH = rows.length * lh + pad * 2 + fs * 1.4;

        c.fillStyle = 'rgba(6,8,12,0.66)';
        c.fillRect(8 * scale, 8 * scale, boxW, boxH);
        c.strokeStyle = 'rgba(94,242,195,0.30)';
        c.lineWidth = Math.max(1, scale);
        c.strokeRect(8 * scale, 8 * scale, boxW, boxH);

        c.font = '700 ' + Math.round(10 * scale) + 'px ui-monospace, Menlo, monospace';
        c.fillStyle = '#5ef2c3';
        c.textAlign = 'left';
        c.textBaseline = 'middle';
        c.fillText('MEASURED', 8 * scale + pad, 8 * scale + pad + fs * 0.6);

        c.font = '400 ' + fs + 'px ui-monospace, Menlo, monospace';
        rows.forEach((row, idx) => {
            const y = 8 * scale + pad + fs * 1.4 + idx * lh + lh / 2;
            c.fillStyle = '#9ca3af';
            c.fillText(row[0], 8 * scale + pad, y);
            c.fillStyle = '#e5e7eb';
            c.textAlign = 'right';
            const val = Number.isFinite(row[2])
                ? row[2].toFixed(2)
                : '';
            c.fillText(String(row[1]) + (val ? '  ' + val : ''), 8 * scale + boxW - pad, y);
            c.textAlign = 'left';
        });
    }

    c.restore();

}


window.toggleMap = (btn) => {

    window.showMap = !window.showMap;
    const target = (btn && btn.querySelector('#map-label')) || btn;

    if (target) {
        /* Ohne geladenes i18n-Modul (oder vor ihm) waere der rohe Schluessel
           sichtbar — deshalb als Fallback der englische Text. */
        const t = (k, fb) => (window.T ? window.T(k) : fb);
        target.textContent = '\uD83D\uDCF1 ' + (window.showMap
            ? t('beauty.mapOn', 'Measurement map: ON')
            : t('beauty.mapOff', 'Measurement map: OFF'));
    }

    /* Verlaufs-Diagramm gehört zum Messmodus. */
    const panel = document.getElementById('trend-panel');
    if (panel) panel.style.display = window.showMap ? 'block' : 'none';

    if (window.showMap) {
        renderOverlay();
        drawTrend();
    }

};


/* ============================================================
   VERLAUF
   ------------------------------------------------------------
   Sechs Kennzahlen, sechs völlig verschiedene Wertebereiche
   (Tilt −45…45, Lidspalte 0.05…1.2, Wangen 0.5…2.5). In EINEM
   Diagramm ueberlagert waeren sie unlesbar, deshalb bekommt jede
   Kennzahl eine eigene Zeile mit eigener Skala, eingezeichneten
   Einstufungsgrenzen und einer Markierung fuer den Median.

   Genau dieser Median ist das, worueber die Einstufung entscheidet
   — die Linie macht daher sichtbar, WARUM ein Label steht.
   ============================================================ */

const TREND_SERIES = [
    { key: 'eye', label: 'eye', color: '#5ef2c3',
      marks: [[0.27, 'narrow'], [0.44, 'round']] },
    { key: 'lip', label: 'lips', color: '#f9a8d4',
      marks: [[0.22, 'thin'], [0.36, 'full']] },
    { key: 'tilt', label: 'tilt', color: '#7dd3fc',
      marks: [[-3, 'down'], [3, 'up']] },
    { key: 'brow', label: 'brow', color: '#c4b5fd',
      marks: [[0.06, 'straight'], [0.15, 'high']] },
    { key: 'cheek', label: 'cheek', color: '#fcd34d',
      marks: [[1.15, 'moderate'], [1.30, 'high']] },
    { key: 'cheekDom', label: 'cheekDom', color: '#fdba74',
      marks: [[0.10, 'high']] }
];

const TREND_LABEL_W = 74;
const TREND_ROW_H = 30;
const TREND_PAD = 8;


function drawTrend() {

    const el = document.getElementById('trend-canvas');
    if (!el) return;

    const cssW = el.clientWidth || 320;
    const cssH = TREND_PAD * 2 + TREND_SERIES.length * TREND_ROW_H;

    /* Auflösung an die Darstellungsgröße anpassen, sonst wird das
       Diagramm auf Retina unscharf. */
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const wantW = Math.round(cssW * dpr);
    const wantH = Math.round(cssH * dpr);

    if (el.width !== wantW || el.height !== wantH) {
        el.width = wantW;
        el.height = wantH;
        el.style.height = cssH + 'px';
    }

    const c = el.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cssW, cssH);

    const plotX = TREND_LABEL_W;
    const plotW = Math.max(30, cssW - TREND_LABEL_W - TREND_PAD - 34);

    TREND_SERIES.forEach((series, idx) => {

        const range = VALID_HISTORY[series.key];
        const lo = range[0];
        const hi = range[1];
        const top = TREND_PAD + idx * TREND_ROW_H;
        const midY = top + TREND_ROW_H / 2;

        const toY = (v) => midY - ((v - lo) / (hi - lo)) * (TREND_ROW_H * 0.40);

        /* Zeilenhintergrund */
        c.fillStyle = idx % 2 ? 'rgba(255,255,255,0.020)' : 'rgba(255,255,255,0.045)';
        c.fillRect(plotX, top + 2, plotW, TREND_ROW_H - 4);

        /* Einstufungsgrenzen */
        c.save();
        c.setLineDash([3, 3]);
        c.lineWidth = 1;
        series.marks.forEach(m => {
            const y = toY(m[0]);
            c.strokeStyle = 'rgba(156,163,175,0.45)';
            c.beginPath();
            c.moveTo(plotX, y);
            c.lineTo(plotX + plotW, y);
            c.stroke();
            c.fillStyle = 'rgba(156,163,175,0.75)';
            c.font = '8px ui-monospace, Menlo, monospace';
            c.textAlign = 'left';
            c.textBaseline = 'middle';
            c.fillText(m[1], plotX + plotW + 4, y);
        });
        c.restore();

        /* Serienverlauf */
        const list = history[series.key];

        if (list.length) {
            const step = list.length > 1 ? plotW / (HISTORY_MAX - 1) : 0;
            const x0 = plotX + plotW - (list.length - 1) * step;

            c.strokeStyle = series.color;
            c.lineWidth = 1.6;
            c.beginPath();
            list.forEach((v, i) => {
                const x = x0 + i * step;
                const y = toY(v);
                if (i === 0) c.moveTo(x, y);
                else c.lineTo(x, y);
            });
            c.stroke();

            /* letzter Rohwert als Punkt */
            c.fillStyle = series.color;
            c.beginPath();
            c.arc(x0 + (list.length - 1) * step, toY(list[list.length - 1]), 2.4, 0, Math.PI * 2);
            c.fill();

            /* Median der letzten 25 — die Groesse, nach der
               tatsaechlich eingestuft wird. */
            const win = list.slice(-Math.min(list.length, 25));
            const med = median(win);
            const yMed = toY(med);
            c.strokeStyle = series.color;
            c.lineWidth = 1.2;
            c.beginPath();
            c.moveTo(plotX, yMed);
            c.lineTo(plotX + plotW, yMed);
            c.stroke();
        }

        /* Beschriftung */
        c.fillStyle = list.length ? '#e5e7eb' : '#6b7280';
        c.font = '600 10px ui-monospace, Menlo, monospace';
        c.textAlign = 'left';
        c.textBaseline = 'middle';
        c.fillText(series.label, 4, midY);

        /* aktueller Median als Zahl */
        if (list.length) {
            c.fillStyle = series.color;
            c.font = '600 10px ui-monospace, Menlo, monospace';
            c.textAlign = 'right';
            c.fillText(median(list.slice(-Math.min(list.length, 25))).toFixed(2), cssW - 4, midY);
            c.textAlign = 'left';
        }
    });

}


let trendRaf = null;
let trendLast = 0;

function trendLoop(ts) {

    trendRaf = requestAnimationFrame(trendLoop);

    /* 12 fps genuegen fuer eine 45-Frames-Historie und sparen
       deutlich Akku auf dem Geraet. */
    if (ts - trendLast < 80) return;
    trendLast = ts;

    const el = document.getElementById('trend-canvas');
    if (!el) return;
    if (!el.clientWidth) return;

    drawTrend();

}


/* ============================================================
   OVERLAY RENDERNA — eine Quelle fuer Live-Bild und Foto
   ============================================================ */

function renderOverlay() {

    const src = analysisSource;

    const sw = (src && src.videoWidth) || (src && src.naturalWidth) || (src && src.width) || 0;
    const sh = (src && src.videoHeight) || (src && src.naturalHeight) || (src && src.height) || 0;

    if (!sw || !sh) return;

    /* Anzeigeflaeche statt Bildgroesse: das Video faellt per
       object-fit:cover in den Rahmen, der Canvas frueher einfach gestreckt.
       Jetzt wird die Cover-Transformation hier uebernommen — dann sitzen
       die Punkte exakt auf dem, was der Nutzer sieht. */
    const boxW = canvas.clientWidth || sw;
    const boxH = canvas.clientHeight || sh;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(boxW * dpr));
    const H = Math.max(1, Math.round(boxH * dpr));

    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const t = overlayTransform(boxW, boxH, sw, sh);
    ctx.setTransform(dpr * t.scale, 0, 0, dpr * t.scale, dpr * t.dx, dpr * t.dy);

    /* Die Hilfslinien helfen nur beim Einrichten vor der Kamera. Bei einem
       hochgeladenen Foto gibt es nichts auszurichten — sie wuerden dort nur
       stoeren. */
    if (!window.photoMode) drawGuide(ctx, sw, sh);

    /* Landmarks: im Live-Bild nur, solange sie frisch sind. Sonst haengten
       die Punkte noch Sekunden in der Luft, nachdem das Gesicht weg ist
       (leere Frames werden absichtlich NICHT zurueckgesetzt, siehe
       handleResults). Ein Standbild liefert genau einen Frame — dort zaehlt
       er dauerhaft. */
    const lm = window._lastLandmarks;
    const fresh = !!lm && (
        window.photoMode ||
        (!!window._landmarksAt && Date.now() - window._landmarksAt < 700)
    );

    if (fresh) {
        if (window.showLandmarks) drawLandmarkDots(ctx, lm, sw, sh);
        if (window.showMap) drawFaceMap(ctx, lm, sw, sh);
    }

    setDetectBadge(fresh, lm ? lm.length : 0);

}

/* Ein hochgeladenes Foto wird AUCH im Scanner-Rahmen gezeigt. Vorher
   stand dort nur das eingefrorene Kamerabild, waehrend die Punkte schon
   vom Foto kamen — die haengen dann sichtbar neben dem Bild. */
function showPhotoPreview(img) {

    const el = document.getElementById('photo-preview');

    if (el && img && img.src) {
        el.src = img.src;
        el.style.display = 'block';
    }

    const v = document.getElementById('video');
    if (v) v.style.visibility = 'hidden';

    renderOverlay();

}

function hidePhotoPreview() {

    const el = document.getElementById('photo-preview');
    if (el) {
        el.style.display = 'none';
        el.removeAttribute('src');
    }

    const v = document.getElementById('video');
    if (v) v.style.visibility = '';

}

/* Eigener Zeichen-Loop für die Führungslinien — läuft dauernd über dem
   Live-Kamerabild und wartet NICHT auf die Gesichtserkennung. So erscheinen
   die Hilfslinien sofort, auch wenn MediaPipe noch nicht fertig geladen ist
   oder gerade kein Gesicht erkannt wurde. */
let guideRaf = null;
let overlayStaleStamp = 0;

function guideLoop() {

    guideRaf = requestAnimationFrame(guideLoop);

    if (window.photoMode) {
        /* Ein Foto ist statisch. Neu zeichnen nur, wenn MediaPipe neue
           Landmarks geliefert hat — sonst 60× pro Sekunde dasselbe Bild. */
        const stamp = window._landmarksAt || 0;
        if (stamp && stamp !== overlayStaleStamp) {
            overlayStaleStamp = stamp;
            renderOverlay();
        }
        return;
    }

    if (!video.videoWidth || !video.videoHeight) return;

    renderOverlay();

}
guideLoop();

/* Verlaufs-Diagramm: eigener Loop, gedrosselt auf ~12 fps. */
requestAnimationFrame(trendLoop);

/* Fill the manual-override inputs with the freshly detected values —
   but never overwrite a value the user typed by hand. */
const manualInputIds = {
    face: 'manual-face',
    eyes: 'manual-eyes',
    eyeTilt: 'manual-eyeTilt',
    lips: 'manual-lips',
    brows: 'manual-brows',
    cheekbones: 'manual-cheekbones',
    tone: 'manual-tone'
};

function syncManualFeatures() {
    for (const key in manualInputIds) {
        const el = document.getElementById(manualInputIds[key]);
        if (!el || window.editedInputs.has(manualInputIds[key])) continue;
        const v = window.features[key];
        if (v && v !== '--') el.value = v;
    }
}


/* ============================================================
   ANALYSIS CANVAS
   ============================================================ */

const analysisCanvas = document.createElement("canvas");

const analysisCtx = analysisCanvas.getContext("2d", {
    willReadFrequently: true
});


/* ============================================================
   MATH HELPERS
   ============================================================ */

/* ------------------------------------------------------------
   STRECKENLAENGE — bewusst 2D, kein z.

   Frueher stand hier eine 3D-Variante, die z mit in die Strecke
   rechnete. Das ergab schon bei einem frontalen Portraet falsche
   Werte:

   - z von MediaPipe hat den Ursprung in der Kopfmitte und ist also
     auch ohne jede Drehung ungleich 0 (Nase vorn, Stirn/Kinn hinten).
   - y wird mit dem aspect korrigiert, z bleibt unveraendert.
   - Jede vertikale Strecke (Gesichtslaenge, Lippenhoehe, Kiefer)
     bekam dadurch einen z-Anteil und wurde zu gross gemessen.

   Messreihe an einem synthetischen Gesicht mit realistischem
   z-Profil: Lippenverhaeltnis 0,30 (Soll) -> 0,40, also aus
   "Balanced" -> "Full"; bei etwas staerkerem z kippte auch die
   Gesichtsform von "Oval" -> "Long". Eine leichte Kopfdrehung
   liess die 3D-Strecken regelrecht zusammenbrechen.

   Durch die aspect-Korrektur sind die Koordinaten bereits isotrop,
   die 2D-Strecke ist damit geometrisch sauber.
   ------------------------------------------------------------ */
function dist2D(a, b) {

    return Math.hypot(a.x - b.x, a.y - b.y);

}


// Winkel am Punkt b zwischen den Vektoren b→a und b→c (in Grad).
// Wird für den Kieferwinkel (rund vs. quadratisch) benutzt.
function angleAt(a, b, c) {

    const v1x = a.x - b.x;
    const v1y = a.y - b.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;

    const dot =
        v1x * v2x +
        v1y * v2y;

    const len =
        Math.hypot(v1x, v1y) *
        Math.hypot(v2x, v2y);

    if (!len) return 0;

    return (
        Math.acos(
            clamp(dot / len, -1, 1)
        ) *
        180 /
        Math.PI
    );

}


// Glättung zwischen zwei Messwerten: nimmt nur einen Teil des neuen
// Wertes, damit die Overlays nicht pro Frame flackern.
function lerp(oldValue, newValue, alpha = 0.15) {
    return oldValue + (newValue - oldValue) * alpha;
}


function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}


// Winkel in den Bereich -180…180 bringen (z.B. für Kopfdrehung).
function normalizeAngle(angle) {
    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;
    return angle;
}


// Median statt Mittelwert: robust gegen einzelne kaputte Einzelmessungen.
function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return sorted[middle];
}


/* ============================================================
   SMOOTHING
   ============================================================ */

let smooth = {

    face: null,
    eye: null,
    lip: null,
    tilt: null,
    cheek: null,
    cheekDom: null,
    brow: null,

    skinL: null,
    skinA: null,
    skinB: null
};

function smoothValue(
    key,
    value,
    alpha = 0.15
) {

    if (!Number.isFinite(value)) {
        return smooth[key];
    }

    if (smooth[key] === null) {
        smooth[key] = value;
    }
    else {
        smooth[key] = lerp(
            smooth[key],
            value,
            alpha
        );
    }

    return smooth[key];

}


/* ============================================================
   MESSHISTORIE
   ------------------------------------------------------------
   Wichtig: die Einstufung darf NICHT vom aktuellen Einzel-Frame
   abhaengen. Der erste Frame nach dem Kamera-Start ist oft
   unzuverlaessig (Teilgesicht, Lidern noch in Bewegung) — genau
   ein solcher Frame hat bisher das Ergebnis festgelegt ("Round
   eyes"), obwohl sich die Augen danach deutlich anders verhielten.
   Wir sammeln daher alle Messungen und stufen nach dem Median
   der letzten N Frames ein: der Median ignoriert Ausreisser und
   bleibt stabil, waehrend der geglaettete Wert nur fuer die
   Live-Anzeige dient.
   ============================================================ */

const HISTORY_MAX = 45;

const history = {
    eye: [],
    lip: [],
    tilt: [],
    cheek: [],
    cheekDom: [],
    brow: []
};

const VALID_HISTORY = {
    eye: [0.05, 1.2],
    lip: [0.05, 1.2],
    tilt: [-45, 45],
    cheek: [0.5, 2.5],
    cheekDom: [-0.5, 0.5],
    brow: [-0.4, 0.6]
};


function pushSample(
    key,
    value
) {

    if (!Number.isFinite(value)) return;

    const range = VALID_HISTORY[key];

    if (range && (value < range[0] || value > range[1])) return;

    const list = history[key];
    list.push(value);
    if (list.length > HISTORY_MAX) list.shift();

}


/* Median der Historie, solange sie lang genug ist — sonst der
   geglaettete Wert. Bei Standbildern (photoMode) zaehlt nur der
   eine Frame, dort wird direkt der Rohwert verwendet. */

function stableValue(
    key,
    fallback
) {

    if (window.photoMode) return fallback;

    const list = history[key];

    if (list.length < 5) return fallback;

    return median(
        list.slice(
            -Math.min(
                list.length,
                25
            )
        )
    );

}


/* ============================================================
   HYSTERESE
   ------------------------------------------------------------
   Harte Schwellen springen, wenn der Messwert genau auf ihnen
   liegt — auch nicht mehr durch den Median. Test: Augenverhaeltnis
   0,444 bei Schwelle 0,44 ergab 49 Labelwechsel in 150 Frames bei
   sonst ruhigem Gesicht.

   Deshalb zaehlt ein Wechsel erst, wenn der Wert die betroffene
   Grenze zusaetzlich um HYSTERESIS ueberschritten hat. Innerhalb
   des Bandes bleibt das vorherige Label stehen. Komfortabel
   innerhalb eines Bandes gemessen ist alles stabil, deshalb ist
   der Bandrand schmal genug fuer eine schnelle Reaktion.
   ============================================================ */

const HYSTERESIS = 0.02;
const HYSTERESIS_DEG = 1.5;

const labelState = {};

/* value >= cuts[i] fuer jedes i zaehlt eine Stufe hoch.
   labels[index] ist das Ergebnis. */

function labelWithHysteresis(
    key,
    value,
    cuts,
    labels,
    margin = HYSTERESIS
) {

    if (!Number.isFinite(value)) return labels[0];

    let idx = 0;

    while (
        idx < cuts.length &&
        value >= cuts[idx]
    ) {

        idx++;

    }

    const prev =
        labelState[key];

    if (
        prev !== undefined &&
        prev !== idx
    ) {

        /* die Grenze, die gerade ueberschritten wurde. In beide
           Richtungen existiert sie: idx > prev braucht cuts[prev],
           idx < prev braucht cuts[prev - 1]. */

        const cut =
            idx > prev
                ? cuts[prev]
                : cuts[prev - 1];

        const confirmed =
            idx > prev
                ? value >= cut + margin
                : value <= cut - margin;

        if (!confirmed) {

            labelState[key] = prev;
            return labels[prev];

        }

    }

    labelState[key] = idx;

    return labels[idx];

}


/* Tilt ist nicht monoton (+ = aufwaerts, - = abwaerts), daher eine
   eigene, symmetrische Variante mit derselben Logik. */

const TILT_LABELS = ["Downturned", "Neutral", "Upturned"];

function tiltWithHysteresis(value) {

    if (!Number.isFinite(value)) return TILT_LABELS[1];

    const idx =
        value > 3
            ? 2
            : (value < -3 ? 0 : 1);

    const prev =
        labelState.eyeTilt;

    if (
        prev !== undefined &&
        prev !== idx
    ) {

        const need =
            idx > prev
                ? (prev === 0 ? -3 + HYSTERESIS_DEG : 3 + HYSTERESIS_DEG)
                : (prev === 2 ? 3 - HYSTERESIS_DEG : -3 - HYSTERESIS_DEG);

        const confirmed =
            idx > prev
                ? value >= need
                : value <= need;

        if (!confirmed) {

            labelState.eyeTilt = prev;
            return TILT_LABELS[prev];

        }

    }

    labelState.eyeTilt = idx;

    return TILT_LABELS[idx];

}


function resetHistory() {

    for (const key in history) history[key].length = 0;

    /* Beim Wechsel der Quelle auch den Label-Zustand loeschen,
       sonst blockiert die Hysterese den ersten Wert der neuen
       Quelle, bis die alte Grenze ueberschritten ist. */

    for (const key in labelState) delete labelState[key];

}


/* Live-Anzeige der Rohwerte. Zweck: der Nutzer soll sehen, dass sich die
   Messwerte wirklich mit dem Gesicht bewegen (z. B. sinkt der
   Lidspalten-Wert beim Zusammenkniffen) — vorher war die Erkennung eine
   Blackbox, in der ein falscher Wert nicht von einem echten zu unterscheiden
   war. */

function renderLiveMetrics() {

    const box = document.getElementById('live-metrics');
    const rows = document.getElementById('live-metrics-rows');
    if (!box || !rows) return;

    const m = window.measurements;
    if (!m) return;

    box.style.display = 'block';

    const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : '—');

    const closed = m.eyeClosed
        ? ' <span style="color:#fb923c;">(closed — blink ignored)</span>'
        : '';

    rows.innerHTML =
        'eye opening: <b style="color:#e5e7eb;">' + f3(m.eyeAperture) + '</b>' +
        ' (width ' + f3(m.eyeWidth) + ') → ' + (window.features.eyes || '—') + closed +
        '<br>tilt: <b style="color:#e5e7eb;">' + f3(m.tiltDeg) + '°</b> → ' + (window.features.eyeTilt || '—') +
        '<br>lips: <b style="color:#e5e7eb;">' + f3(m.lipRatio) + '</b> → ' + (window.features.lips || '—') +
        '<br>brow arch: <b style="color:#e5e7eb;">' + f3(m.browArch) + '</b> → ' + (window.features.brows || '—') +
        '<br>cheek/jaw: <b style="color:#e5e7eb;">' + f3(m.cheekRatio) + '</b> → ' + (window.features.cheekbones || '—') +
        '<br>cheek dominance: <b style="color:#e5e7eb;">' + f3(m.cheekDominance) + '</b>' +
        '<br>frames used: <b style="color:#e5e7eb;">' + (m.frames || 0) + '</b> · source ' + (m.source || '—');

}


/* ============================================================
   RGB → LINEAR RGB
   ============================================================ */

function srgbToLinear(value) {

    value /= 255;

    if (value <= 0.04045) {
        return value / 12.92;
    }

    return Math.pow(
        (value + 0.055) / 1.055,
        2.4
    );
}


/* ============================================================
   RGB → CIELAB
   ============================================================ */

function rgbToLab(r, g, b) {

    r = srgbToLinear(r);
    g = srgbToLinear(g);
    b = srgbToLinear(b);


    /* RGB → XYZ */

    let X =
        r * 0.4124564 +
        g * 0.3575761 +
        b * 0.1804375;

    let Y =
        r * 0.2126729 +
        g * 0.7151522 +
        b * 0.0721750;

    let Z =
        r * 0.0193339 +
        g * 0.1191920 +
        b * 0.9503041;


    /* D65 reference white */

    X /= 0.95047;
    Y /= 1.00000;
    Z /= 1.08883;


    function f(t) {

        const delta = 6 / 29;

        if (t > Math.pow(delta, 3)) {
            return Math.cbrt(t);
        }

        return (
            t /
            (3 * delta * delta)
        ) + (4 / 29);
    }


    const fx = f(X);
    const fy = f(Y);
    const fz = f(Z);


    return {

        L: 116 * fy - 16,

        a: 500 * (fx - fy),

        b: 200 * (fy - fz)

    };
}


/* ============================================================
   NORMALIZED RGB
   ============================================================ */

function normalizedRGB(r, g, b) {

    const sum = r + g + b;

    if (sum <= 0) {

        return {
            r: 0,
            g: 0,
            b: 0
        };

    }

    return {

        r: r / sum,

        g: g / sum,

        b: b / sum

    };
}


/* ============================================================
   GET PIXEL
   ============================================================ */

function getPixel(x, y) {

    x = Math.round(x);
    y = Math.round(y);


    if (
        x < 0 ||
        y < 0 ||
        x >= analysisCanvas.width ||
        y >= analysisCanvas.height
    ) {

        return null;

    }


    return analysisCtx.getImageData(
        x,
        y,
        1,
        1
    ).data;
}


/* ============================================================
   SAMPLE PATCH
   ============================================================ */

function samplePatch(point, radius = 2) {

    const centerX =
        Math.round(
            point.x *
            analysisCanvas.width
        );

    const centerY =
        Math.round(
            point.y *
            analysisCanvas.height
        );


    const pixels = [];


    for (
        let dx = -radius;
        dx <= radius;
        dx++
    ) {

        for (
            let dy = -radius;
            dy <= radius;
            dy++
        ) {

            const pixel =
                getPixel(
                    centerX + dx,
                    centerY + dy
                );


            if (!pixel) {
                continue;
            }


            pixels.push({

                r: pixel[0],
                g: pixel[1],
                b: pixel[2]

            });

        }

    }


    if (!pixels.length) {
        return null;
    }


    return {

        r: median(
            pixels.map(
                p => p.r
            )
        ),

        g: median(
            pixels.map(
                p => p.g
            )
        ),

        b: median(
            pixels.map(
                p => p.b
            )
        )

    };
}


/* ============================================================
   BROW ARCH
   ------------------------------------------------------------
   Wie weit steht der Scheitelpunkt der Braue ueber der Linie
   zwischen innerem und aeusserem Augenwinkel?

   0      = Braue waere exakt gerade
   > 0    = gewölbt (positiv = nach oben gewölbt)
   < 0    = nach unten abfallend

   Normiert auf die Laenge der Innen-/Aussenlinie, damit grosse und
   kleine Gesichter denselben Wert liefern.
   ============================================================ */

function browArchRatio(inner, apex, outer) {

    if (!inner || !apex || !outer) return 0;

    const chordX = outer.x - inner.x;
    const chordY = outer.y - inner.y;
    const chordLen =
        Math.sqrt(
            chordX * chordX +
            chordY * chordY
        );

    if (!chordLen) return 0;

    /* Wo liegt der Scheitel auf der Linie? (auf 0..1 begrenzt, falls
       das Tracking ihn neben die Braue legt) */
    let t = (
        (apex.x - inner.x) * chordX +
        (apex.y - inner.y) * chordY
    ) / (chordLen * chordLen);

    t = Math.max(
        0,
        Math.min(1, t)
    );

    const chordYat = inner.y + chordY * t;

    /* Bildkoordinaten: y waechst nach unten, also ist ein Scheitel
       "hoeher", wenn seine y-Koordinate KLEINER ist. */
    const height = chordYat - apex.y;

    return height / chordLen;

}


/* ============================================================
   SKIN TONE ANALYSIS
   ============================================================ */

function analyzeSkinTone(lm) {

    /*
        Multiple points are used instead of
        only one or two pixels.

        This reduces:
        - shadows
        - highlights
        - pixel noise
        - accidental sampling of hair
    */

    const skinPoints = [

        lm[50],
        lm[101],
        lm[118],
        lm[187],
        lm[205],

        lm[280],
        lm[330],
        lm[347],
        lm[411],
        lm[425]

    ];


    const labSamples = [];


    skinPoints.forEach(point => {

        if (!point) {
            return;
        }


        const pixel =
            samplePatch(
                point,
                2
            );


        if (!pixel) {
            return;
        }


        /*
            Ignore almost-black and
            almost-white pixels.

            They are likely to be:
            - shadows
            - highlights
            - invalid samples
        */

        const brightness =
            (
                pixel.r +
                pixel.g +
                pixel.b
            ) / 3;


        if (
            brightness < 15 ||
            brightness > 245
        ) {

            return;

        }


        const lab =
            rgbToLab(
                pixel.r,
                pixel.g,
                pixel.b
            );


        labSamples.push(lab);

    });


    if (labSamples.length < 3) {
        return;
    }


    /*
        Wichtig: leere/schwarze Video-Frames liefern sonst für ALLE
        denselben "Hautton". Ein schwarzes oder ausgegrautes Bild hat
        ueberall dieselbe Helligkeit — dann lieber kein Ergebnis als ein
        falsches, das bei jedem User identisch aussieht.

        Gemessen wird die Streuung von L (Lightness), nicht von
        (L + a + b) / 3: a und b sind Opponent-Kanaele, ihre Summe
        sagt nichts ueber Helligkeit aus.
    */

    const lVals = labSamples.map(
        (l) => l.L
    );

    const lSpread =
        Math.max.apply(null, lVals) -
        Math.min.apply(null, lVals);


    if (lSpread < 6) {
        return;
    }


    /*
        Median is more robust than
        simply averaging all samples.
    */

    const L =
        median(
            labSamples.map(
                x => x.L
            )
        );


    const A =
        median(
            labSamples.map(
                x => x.a
            )
        );


    const B =
        median(
            labSamples.map(
                x => x.b
            )
        );


    /*
        Smooth skin measurements over time.

        A small alpha prevents the tone
        from jumping whenever lighting changes.
    */

    const smoothL =
        smoothValue(
            "skinL",
            L,
            0.08
        );


    const smoothA =
        smoothValue(
            "skinA",
            A,
            0.08
        );


    const smoothB =
        smoothValue(
            "skinB",
            B,
            0.08
        );


    /*
        Compress extreme lighting changes.

        This does NOT magically remove lighting,
        but makes the classification less sensitive
        to sudden exposure changes.
    */

    const stableL =
        50 +
        (smoothL - 50) * 0.65;


    /*
        Skin-tone classification.

        These are broad image-based categories,
        not biological measurements.
    */

    if (stableL >= 72) {

        window.features.tone =
            "Fair";

    }
    else if (stableL >= 57) {

        window.features.tone =
            "Light";

    }
    else if (stableL >= 42) {

        window.features.tone =
            "Medium";

    }
    else {

        window.features.tone =
            "Deep";

    }


    /*
        Optional debugging information.
    */

    window.skinAnalysis = {

        L: smoothL,
        a: smoothA,
        b: smoothB,

        sampleCount:
            labSamples.length

    };
}


/* ============================================================
   MEDIAPIPE FACE MESH
   ------------------------------------------------------------
   WICHTIG: FaceMesh wird NICHT mehr beim Seitenaufbau erzeugt.
   Vorher stand hier "new FaceMesh(...)" ganz oben — ist das CDN
   (cdn.jsdelivr.net) blockiert, wirft diese Zeile sofort, und
   danach ist der REST der Datei nie geladen: weder onResults noch
   runFaceMeshOn, stopCamera oder die Foto-Analyse. Die Folge war
   "gleiche/leere Merkmale bei allen" + "kein Gesicht erkannt".
   Jetzt: warten bis die MediaPipe-Skripte da sind, Fehler sichtbar
   melden und die App trotzdem lauffähig halten.
   ============================================================ */

let faceMesh = null;

window.mediapipeReady = false;
window.mediapipeError = '';
window.cameraActive = false;
window.cameraError = '';

const MEDIAPIPE_CDN =
    'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/';


/* Wartet höchstens timeout ms, bis FaceMesh/Camera im Fenster sind. */
function waitForMediaPipe(timeout = 12000) {

    return new Promise(
        (resolve, reject) => {

            if (
                typeof window.FaceMesh === 'function' &&
                typeof window.Camera === 'function'
            ) {

                resolve(true);
                return;

            }

            const started = Date.now();

            const tick = setInterval(() => {

                if (
                    typeof window.FaceMesh === 'function' &&
                    typeof window.Camera === 'function'
                ) {

                    clearInterval(tick);
                    resolve(true);

                }
                else if (
                    Date.now() - started > timeout
                ) {

                    clearInterval(tick);
                    reject(new Error('MediaPipe did not load'));

                }

            }, 150);

        }
    );

}


/* ============================================================
   FRAME-DIAGNOSE
   ------------------------------------------------------------
   Zwei Fallstricke, die beide im echten Betrieb beobachtet wurden:

   1. Beim ersten Start laedt das Modell mehrere Megabyte. Waehrend
      dieses Download schlaegt jedes send() fehl. Solange duerfen
      Fehler NICHT gezaehlt werden — sonst steht nach jedem
      Seitenaufruf die Warnung, obwohl danach alles laeuft.
   2. Eine einmal gezeigte Warnung muss wieder verschwinden, wenn
      die Frames laufen. Sonst haelt EIN schlechter Moment die
      Meldung fuer immer offen — genau das passiert, wenn man nur
      die Fehler zaehlt und nie zuruecksetzt.
   ============================================================ */

/* Schwellen. Ueber window.* vor dem Laden von camera.js setzbar, damit
   die Browser-Pruefung denselben Pfad mit kleinen Zahlen abdeckt. */
const MP_GRACE_MS = (window.MP_GRACE_MS !== undefined)
    ? window.MP_GRACE_MS : 8000;   /* Modell-Download + WASM-Start */
const MP_FAIL_LIMIT = (window.MP_FAIL_LIMIT !== undefined)
    ? window.MP_FAIL_LIMIT : 60;   /* ~2 s echte Fehlerrate */
const MP_OK_CLEAR = (window.MP_OK_CLEAR !== undefined)
    ? window.MP_OK_CLEAR : 30;     /* 1 s in Folge ok => Warnung weg */

let mpStreamStart = 0;
let mpFailStreak = 0;
let mpOkStreak = 0;
let mpFirstError = '';

window._frameErrors = 0;

function mpResetFrameStats() {

    mpStreamStart = Date.now();
    mpFailStreak = 0;
    mpOkStreak = 0;
    mpFirstError = '';
    window._frameErrors = 0;

}

/* Nur fuer die Pruefung: Gnadenfrist ablaufen lassen, ohne 8 s zu warten. */
window.__mpExpireGrace = function () {
    mpStreamStart = 0;
};

/* Die kritischen Dateien des Modells. Wenn eine davon nicht ladet,
   hilft "60 Frames fehlgeschlagen" niemandem — der Dateiname ist das,
   was Ad-Blocker, Offline-Caches und kaputte Netzwerke unterscheidbar
   macht. */
async function probeMediaPipeAssets() {

    const files = [
        'face_mesh.binarypb',
        'face_mesh_solution_packed_assets.data',
        'face_mesh_solution_simd_wasm_bin.wasm'
    ];

    const bad = [];

    for (const file of files) {

        try {

            const res = await fetch(`${MEDIAPIPE_CDN}${file}`, { method: 'HEAD' });

            if (!res.ok) bad.push(`${file} (HTTP ${res.status})`);

        }
        catch (e) {

            bad.push(`${file} (${(e && e.message) ? e.message : 'blocked'})`);

        }

    }

    window._mpAssetProbe = bad;

    const detail = document.getElementById('mediapipe-note-detail');

    if (!detail) return;

    if (bad.length) {

        detail.textContent += ' Blocked asset: ' + bad.join(', ') + '.';

    }
    else if (window._mpWarningSource === 'frames') {

        detail.textContent +=
            ' All MediaPipe files are reachable — the error above comes ' +
            'from the browser itself (camera / WebGL / console for details).';

    }

}

function frameStreamOk() {

    mpFailStreak = 0;
    mpOkStreak += 1;
    window._frameErrors = 0;

    if (mpOkStreak >= MP_OK_CLEAR && window._mpWarningSource === 'frames') {

        mediaPipeClear();

    }

}

function frameStreamFailed(e) {

    const msg = (e && e.message) ? e.message : String(e);

    if (mpOkStreak > 0) console.error('Aestra: FaceMesh frame failed —', e);

    mpOkStreak = 0;

    /* Modell laedt gerade: zaehlen nicht. */
    if (mpStreamStart && Date.now() - mpStreamStart < MP_GRACE_MS) return;

    mpFailStreak += 1;
    window._frameErrors = mpFailStreak;

    if (!mpFirstError) mpFirstError = msg;

    if (mpFailStreak === 1) console.error('Aestra: FaceMesh frame failed —', e);

    if (mpFailStreak === MP_FAIL_LIMIT) {

        mediaPipeWarning(
            MP_FAIL_LIMIT + ' camera frames could not be processed — ' +
            'first error: "' + mpFirstError + '". Reload the page, or ' +
            'disable your ad blocker for cdn.jsdelivr.net.',
            'frames'
        );

        probeMediaPipeAssets();

    }

}


/* Sichtbarer Hinweis statt stillem Weiterlaufen. */
function mediaPipeWarning(reason, source) {

    window.mediapipeError = reason;
    window._mpWarningSource = source || '';

    const note = document.getElementById('mediapipe-note');

    if (note) {

        note.style.display = 'block';

    }

    /* Der konkrete Grund ist wichtiger als der generische Satz: nur so kann
       der Nutzer Ad-Blocker, Kamerarechte oder Netzfehler unterscheiden. */

    const detail = document.getElementById('mediapipe-note-detail');

    if (detail) detail.textContent = reason ? 'Details: ' + reason : '';

    if (window.showMap) return;

    console.error('Aestra: MediaPipe nicht verfügbar —', reason);

}


/* Nur Warnungen, die von fehlgeschlagenen Frames stammen, verschwinden
   wieder, wenn die Erkennung laeuft. Fehlerteilungen beim Start
   (Kamera verweigert, Bibliothek blockiert) bleiben stehen, bis jemand
   auf "Retry" tippt. */
function mediaPipeClear() {

    if (window._mpWarningSource !== 'frames') return;

    window._mpWarningSource = '';
    window.mediapipeError = '';

    const note = document.getElementById('mediapipe-note');
    if (note) note.style.display = 'none';

    const detail = document.getElementById('mediapipe-note-detail');
    if (detail) detail.textContent = '';

}


/* Neuer Versuch per Nutzergeste — Browser verweigern getUserMedia
   zuverlässiger, wenn der Aufruf aus einem Klick kommt. */

window.retryCamera = async function () {

    window.mediapipeError = '';
    window.cameraError = '';

    const engine = await initMediaPipe();
    if (!engine) return false;
    return startCameraStream();

};


async function initMediaPipe() {

    try {

        await waitForMediaPipe();

        faceMesh = new window.FaceMesh({

            locateFile: (file) =>
                `${MEDIAPIPE_CDN}${file}`,

            /* Ein Gesicht reicht (die Messung nimmt sowieso nur das erste),
               refineLandmarks liefert die Irisringe — man sieht damit, dass
               auch der Blick erkannt wird, nicht nur die Gesichtskontur. */
            maxNumFaces: 1,
            refineLandmarks: true

        });

        faceMesh.onResults(handleResults);

        window.mediapipeReady = true;

        return true;

    }
    catch (e) {

        faceMesh = null;
        mediaPipeWarning(e.message);
        return false;

    }

}


/* ============================================================
   MAIN FACE ANALYSIS
   ============================================================ */

function handleResults(results) {

    /* ------------------------------------------------------------
       QUELLGROESSE — entscheidet ueber die richtigkeit ALLER Quoten

       MediaPipe normalisiert x auf die Bildbreite, y auf die Bildhoehe.
       Ein Laengenquotient (z. B. Augenhoehe / Augenbreite) ist nur
       sinnvoll, wenn beide Achsen dieselbe Einheit benutzen.

       Fehler im alten Code: wenn die Videogroesse noch nicht bekannt
       war (videoWidth = 0 beim ersten Frame oder bei einem
       Quellwechsel), wurde aspect = 1 gesetzt und trotzdem gemessen.
       Bei einem 4:3-Stream sind vertikale Massstabe dann um 1.33 zu
       gross, bei 16:9 um 1.78 — das Ergebnis war bei JEDER Person
       falsch (alle Augen "Round", alle Lippen "Full", jedes Gesicht
       "Long"). Lieber diesen Frame ueberspringen als falsch messen.
       ------------------------------------------------------------ */

    const src = analysisSource;
    const srcW =
        (src && src.videoWidth) ||
        (src && src.naturalWidth) ||
        (src && src.width) ||
        0;

    const srcH =
        (src && src.videoHeight) ||
        (src && src.naturalHeight) ||
        (src && src.height) ||
        0;

    if (!srcW || !srcH) {

        /* Das Video liefert noch keine Groesse. Bisher geschah hier
           stillschweigend nichts: handleResults kehrt zurueck, es werden
           keine Merkmale geschrieben, alle Felder bleiben leer — der
           Nutzer sah keinen Grund und tippte alles von Hand. Jetzt wird
           das einmal sichtbar gemeldet, damit es nicht bei jedem Frame
           blinkt. */

        window._sourceSizePending = true;
        window._pendingFrames = (window._pendingFrames || 0) + 1;

        if (window._pendingFrames === 30) {

            mediaPipeWarning(
                'the camera image still has no size — the video is not ' +
                'playing. Check the camera permission, or use ' +
                '"Upload a photo" instead.'
            );

        }

        return;

    }

    window._sourceSizePending = false;
    window._pendingFrames = 0;

    analysisCanvas.width = srcW;
    analysisCanvas.height = srcH;

    analysisCtx.drawImage(
        analysisSource,
        0,
        0,
        srcW,
        srcH
    );

    if (
        !results.multiFaceLandmarks ||
        !results.multiFaceLandmarks[0]
    ) {
        /* WICHTIG: hier die Landmarks NICHT zurücksetzen. Nach dem Stoppen
           der Kamera kommen oft leere Frames — sonst wäre die Gesichtskarte
           plötzlich "weg", obwohl sie kurz vorher da war. Die letzten gültigen
           Landmarks bleiben also erhalten. */
        return;
    }

    const lm =
        results.multiFaceLandmarks[0];

    /* Für Debug-Modus (window.showMap) und die Gesichtskarte aufheben
       (diese bleiben in den ROH-Koordinaten, das Zeichnen skaliert
       x mit der Breite und y mit der Höhe). */
    window._lastLandmarks = lm;
    window._landmarksAt = Date.now();

    /* ------------------------------------------------------------
       SEITENVERHÄLTNIS-KORREKTUR (wichtig für alle Längenquotienten)

       MediaPipe normalisiert x auf die BildBREITE, y auf die BildHÖHE.
       Ein geometrisch sauberes L/W_c ist aber nur vergleichbar, wenn
       beide Achsen dieselbe Einheit haben. Bei einem 3:4-Video
       (z. B. 480×640) wäre ein kreisförmiges Gesicht sonst fälschlich
       L/W_c ≈ 1.33 statt 1.0 — die Gesichtserkennung würde systematisch
       zu "Long" / "Oval" kippen.

        Deshalb: für alle Messungen y mit (H/W) in Breiten-Einheiten
        umrechnen. Die Zeichenkoordinaten oben bleiben unangetastet.
        (srcW/srcH stehen inzwischen fest — siehe QUELLGROESSE oben.)
        ------------------------------------------------------------ */
    const aspect =
        srcH / srcW;

    const m = lm.map(
        (p) => ({
            x: p.x,
            y: p.y * aspect,
            z: p.z
        })
    );

    /* Bei einem Standbild (hochgeladenes / gespeichertes Foto) gibt es
       nur einen einzigen Frame. Dann die Glättung verwerfen, sonst zeigt
       die Anzeige noch die Werte des VORHERIGEN Gesichts. */
    if (window.photoMode) {
        Object.keys(smooth).forEach(
            (k) => {
                smooth[k] = null;
            }
        );
    }


    /* ========================================================
       FACE DIMENSIONS
       ======================================================== */

    const faceWidth =
        dist2D(
            m[234],
            m[454]
        );


    const faceHeight =
        dist2D(
            m[10],
            m[152]
        );


    if (
        faceWidth <= 0 ||
        faceHeight <= 0
    ) {

        return;

    }


    /* ========================================================
       1. FACE SHAPE — geometrische Modellierung
       ------------------------------------------------------------
       L    = Stirnmitte (10) bis Kinnspitze (152)
       W_f  = Stirnbreite  (103 – 332)
       W_c  = Wangenbreite (234 – 454)
       W_j  = Kieferbreite  (172 – 397)
       ------------------------------------------------------------
       Ein reines L/W_c-Verhältnis reicht nicht: rund und quadratisch
       liegen beide bei ≈ 1. Deshalb kommt die Breiten-Rangfolge
       (W_f/W_c/W_j) UND der gemessene Kieferwinkel am Gonion (172)
       dazu — erst dadurch wird die Form trennscharf.
       ======================================================== */

    const L =
        faceHeight;


    const Wc =
        faceWidth;


    const Wf =
        dist2D(
            m[103],
            m[332]
        );


    const Wj =
        dist2D(
            m[172],
            m[397]
        );


    if (
        Wc <= 0 ||
        L <= 0 ||
        Wf <= 0 ||
        Wj <= 0
    ) {

        return;

    }


    /* L / W_c — das Längen-Breiten-Verhältnis des Gesichts */

    smooth.face =
        smoothValue(
            "face",
            L / Wc,
            0.12
        );


    const ratio =
        smooth.face;


    /*
        Breiten-Spreizung: 1.00 = alle drei Breiten gleich,
        1.20 = die größte ist 20 % breiter als die kleinste.
    */

    const wSpread =
        Math.max(Wf, Wc, Wj) /
        Math.max(
            0.0001,
            Math.min(Wf, Wc, Wj)
        );


    /*
        Gonialer Winkel am Kiefergelenk (Gonion 172): Vektor nach oben
        Richtung Wange/Ohr gegen den Vektor zur Kinnseite.
        Rund → größerer Winkel (flacherer Kieferbogen),
        quadratisch → kleinerer Winkel (steilerer Unterkiefer).
    */

    const jawAngle =
        angleAt(
            m[234],
            m[172],
            m[136]
        );


    /*
        Spitzes Kinn? (Herz-/V-Gesicht) — Kinnbreite im
        Verhältnis zur Kieferbreite.
    */

    const chinWidth =
        dist2D(
            m[136],
            m[148]
        );


    const chinPointed =
        chinWidth / Wj < 0.72;


    /*
        Rund vs. quadratisch: beide haben L/W_c ≈ 1 und
        W_f ≈ W_c ≈ W_j. Entscheidend sind Kieferwinkel UND
        Kinnbreite (flaches breites Kinn = quadratisch,
        schmales rundes Kinn = rund). Beide werden zu einem
        Score verrechnet, damit Messrauschen nicht ständig
        die Form wechseln lässt.
    */

    const chinOverJaw =
        chinWidth / Wj;


    const angleScore =
        clamp(
            (145 - jawAngle) / 20,
            0,
            1
        );


    const chinScore =
        clamp(
            (chinOverJaw - 0.45) / 0.20,
            0,
            1
        );


    /* 0 = rund, 1 = quadratisch */

    const squareScore =
        0.55 * angleScore +
        0.45 * chinScore;


    const isRound =
        squareScore < 0.40;


    const isSquare =
        squareScore >= 0.60;


    /*
        "deutlich größer" — für Herz und Raute zählt nicht nur die
        Reihenfolge, sondern der Betrag: die Raute braucht W_c
        DEUTLICH breiter als Stirn UND Kiefer, sonst ist es ein
        normals Oval (W_c > W_f > W_j).
    */

    const isDiamond =
        Wc > Wf &&
        Wc > Wj &&
        (Wc / Wf) > 1.12 &&
        (Wc / Wj) > 1.15;


    const isHeart =
        Wf > Wc &&
        Wc > Wj &&
        (Wf / Wc) > 1.05;


    /*
        Klassifikation nach L/W_c + Breiten-Rangfolge + Kieferwinkel:

        L/W_c < 1.30              kurz und breit   → Round / Square
        1.30 … 1.50               Übergang         → Heart / Diamond / Oval
        L/W_c > 1.50              lang             → Long / Oval
    */

    let shape;

    if (
        ratio < 1.30
    ) {

        if (isDiamond) {

            shape = "Diamond";

        }
        else {

            shape =
                isRound
                    ? "Round"
                    : (isSquare ? "Square" : "Round / Square");

        }

    }
    else if (
        ratio <= 1.50
    ) {

        if (isHeart) {

            shape =
                (chinPointed)
                    ? "Heart / V-Shape"
                    : "Heart";

        }
        else if (isDiamond) {

            shape = "Diamond";

        }
        else if (
            Wc > Wf &&
            Wc > Wj
        ) {

            /* klassisches Oval: W_c > W_f > W_j, sanft auslaufendes Kinn */

            shape = "Oval";

        }
        else {

            shape =
                isRound
                    ? "Round"
                    : (isSquare ? "Square" : "Round / Square");

        }

    }
    else {

        if (
            wSpread <= 1.10
        ) {

            shape = "Long";

        }
        else if (isDiamond) {

            shape = "Diamond";

        }
        else if (
            isHeart &&
            chinPointed
        ) {

            /* Langer V-Typ: schmale Wangen, verjüngtes Kinn */

            shape = "Heart / V-Shape";

        }
        else {

            shape = "Oval";

        }

    }


    window.features.face =
        shape;


    /* ========================================================
       1b. GOLDENE PROPORTIONEN + FÜNFAUGEN-REGEL
       ------------------------------------------------------------
       φ = 1.618 :  L / W_c  ≈ 1.618  (ideale Gesichtsproportion)
       Dreiteilung:  d1 (Stirn→Braue) ≈ d2 (Braue→Nase) ≈ d3 (Nase→Kinn)
       Fünfaugen:     W_c ≈ 5 × Augenbreite, Innenwinkelabstand = 1 × Auge
       ======================================================== */

    const PHI =
        1.618;


    const phiRatio =
        L / Wc;


    /* 0 = exakt golden, 1 = doppelte Abweichung (nach 1/φ gewichtet) */

    const phiDelta =
        Math.abs(phiRatio - PHI) / PHI;


    const d1 =
        dist2D(
            m[10],
            m[168]
        );


    const d2 =
        dist2D(
            m[168],
            m[1]
        );


    const d3 =
        dist2D(
            m[1],
            m[152]
        );


    const zoneMean =
        (d1 + d2 + d3) / 3;


    const zoneSpread =
        zoneMean > 0
            ? (Math.max(d1, d2, d3) - Math.min(d1, d2, d3)) / zoneMean
            : 0;


    const eyeWidth =
        (
            dist2D(m[33], m[133]) +
            dist2D(m[362], m[263])
        ) / 2;


    const fiveEye =
        eyeWidth > 0
            ? Wc / eyeWidth
            : 0;


    const innerGap =
        dist2D(
            m[133],
            m[362]
        );


    const gapRatio =
        eyeWidth > 0
            ? innerGap / eyeWidth
            : 0;




    /* ========================================================
       2. EYE SHAPE
       ======================================================== */

    /*
        Lidspalte = Abstand Oberlid <-> Unterlid, normiert auf die
        Breite des Auges (Aussenwinkel <-> Innenwinkel).

        Wichtig sind zwei Details:

        1) Mehrere Messpunkte je Auge statt nur einem. 145/159 und
           144/160 liegen an verschiedenen Stellen der Lidkante; der
           Median daraus reagiert auf Tracking-Zittern viel ruhiger.
        2) Die Augenbreite wird rein horizontal (2D) gemessen. Mit z
           waere sie bei schraegem Kopf verzerrt und der Quotient
           waere nicht mehr vergleichbar.
    */

    const rightAperture = median(
        [
            dist2D(
                m[145],
                m[159]
            ),
            dist2D(
                m[144],
                m[160]
            ),
            dist2D(
                m[153],
                m[158]
            )
        ]
    );

    const leftAperture = median(
        [
            dist2D(
                m[374],
                m[386]
            ),
            dist2D(
                m[373],
                m[387]
            ),
            dist2D(
                m[380],
                m[385]
            )
        ]
    );

    const leftEyeWidth =
        dist2D(
            m[33],
            m[133]
        );


    const rightEyeWidth =
        dist2D(
            m[362],
            m[263]
        );


    const leftEyeRatio =
        rightAperture /
        Math.max(
            leftEyeWidth,
            0.0001
        );


    const rightEyeRatio =
        leftAperture /
        Math.max(
            rightEyeWidth,
            0.0001
        );


    const eyeRatio =
        (
            leftEyeRatio +
            rightEyeRatio
        ) / 2;


    smooth.eye =
        smoothValue(
            "eye",
            eyeRatio,
            0.25
        );


    /*
        Anthropometrie: die Lidspalte ist ca. 10-12 mm hoch und
        28-32 mm breit, liegt also bei gewoehnlichen Augen um 0,30-0,40.
        Mit der alten Grenze 0.34 landete damit fast jeder in "Round".
        Rund = deutlich ueber der Norm, schmal = deutlich darunter.
    */

    /* Eingestuft wird nach dem Median der letzten Frames, nicht nach dem
       aktuellen Frame — ein einzelner schlechter Frame (Lidschluss,
       Blinzeln, erstes Tracking-Frame) darf das Ergebnis nicht mehr
       festlegen. */

    const eyeStable =
        stableValue(
            "eye",
            smooth.eye
        );

    window._eyeAperture = eyeRatio;
    window._eyeClosed = eyeRatio < 0.12;

    window.features.eyes =
        labelWithHysteresis(
            "eyes",
            eyeStable,
            [0.27, 0.44],
            ["Narrow / Hooded", "Almond", "Round"]
        );


    /* ========================================================
       3. EYE TILT
       ======================================================== */

    /*
        Left eye angle
    */

    const leftDx =
        m[133].x -
        m[33].x;


    const leftDy =
        m[133].y -
        m[33].y;


    /*
        Right eye angle
    */

    const rightDx =
        m[263].x -
        m[362].x;


    const rightDy =
        m[263].y -
        m[362].y;


    const leftEyeAngle =
        Math.atan2(
            leftDy,
            leftDx
        ) *
        180 /
        Math.PI;


    const rightEyeAngle =
        Math.atan2(
            rightDy,
            rightDx
        ) *
        180 /
        Math.PI;


    /*
        Head-roll reference (nur noch als Plausibilitaetswert, siehe unten)

        WICHTIG — bug im alten Code:

            relativeTilt = (leftRelativeTilt + rightRelativeTilt) / 2

        Die beiden Vektoren laufen aus anatomischen Gruenden in dieselbe
        Bildrichtung (+x), aber bei schraegen Augen haben sie entgegen-
        gesetzte Vorzeichen. Der Mittelwert war deshalb IMMER ~0 — bei
        jedermann "Neutral", egal wie die Augen standen.

        Korrekt ist die gespiegelte Differenz:

            t_rechts = Winkel 33 -> 133   (aussen -> innen, rechtes Auge)
            t_links  = Winkel 362 -> 263  (innen -> aussen, linkes Auge)

            tilt = (t_rechts - t_links) / 2

        Bei einem kippenden Kopf drehen sich BEIDE Winkel um denselben
        Rollwinkel, der sich in der Differenz wieder heraushebt — die
        Formel ist also von Haus aus roll-invariant.
    */

    const faceDx =
        m[454].x -
        m[234].x;


    const faceDy =
        m[454].y -
        m[234].y;


    const faceAngle =
        Math.atan2(
            faceDy,
            faceDx
        ) *
        180 /
        Math.PI;

    /*
        Roll des Gesichts abziehen. Die beiden Augenwinkel beziehen sich
        beide auf die Bild-x-Achse; ihre Differenz hebt den Rollwinkel
        bereits heraus, die faceAngle-Pruefung faengt nur noch grobe
        Tracking-Ausschuetter ab (z. B. wenn ein Auge verloren ging).
    */

    const leftRelativeTilt =
        normalizeAngle(
            leftEyeAngle -
            faceAngle
        );


    const rightRelativeTilt =
        normalizeAngle(
            rightEyeAngle -
            faceAngle
        );


    /*
        GESPIEGELTE DIFFERENZ, nicht der Mittelwert.
        Positiv = aeussere Augenwinkel liegen hoeher = "Upturned"
        (Bildkoordinaten: y waechst nach unten).
    */

    const relativeTilt =
        (
            leftRelativeTilt -
            rightRelativeTilt
        ) / 2;


    smooth.tilt =
        smoothValue(
            "tilt",
            relativeTilt,
            0.12
        );


    /*
        3° dead zone prevents small
        tracking noise from changing
        the result.
    */

    const tiltStable =
        stableValue(
            "tilt",
            smooth.tilt
        );

    window.features.eyeTilt =
        tiltWithHysteresis(
            tiltStable
        );


    /* ========================================================
       4. LIPS
       ======================================================== */

    const lipWidth =
        dist2D(
            m[78],
            m[308]
        );


    const vertical1 =
        dist2D(
            m[13],
            m[14]
        );


    const vertical2 =
        dist2D(
            m[82],
            m[87]
        );


    const vertical3 =
        dist2D(
            m[312],
            m[317]
        );


    const lipHeight =
        (
            vertical1 +
            vertical2 +
            vertical3
        ) / 3;


    const lipRatio =
        lipHeight /
        lipWidth;


    smooth.lip =
        smoothValue(
            "lip",
            lipRatio,
            0.12
        );


    /*
        Lippenhoehe / Mundbreite: durchschnittlich ca. 15 mm / 50 mm = 0,30,
        "voll" ab ca. 18 mm (0,36). Die alte Grenze 0,30 hat praktisch
        jeden als "Full" eingestuft.
    */

    const lipStable =
        stableValue(
            "lip",
            smooth.lip
        );

    window.features.lips =
        labelWithHysteresis(
            "lips",
            lipStable,
            [0.22, 0.36],
            ["Thin", "Balanced", "Full"]
        );


    /* ========================================================
       5. CHEEKBONES
       ======================================================== */

    /*
        Important correction:

        Previously:

            cheekboneWidth =
                dist2D(m[234], m[454])

        But this is the same as faceWidth.

        Therefore the previous calculation wasn't
        an independent cheekbone measurement.

        Here we use the ratio:

            face width / jaw width

        as a structural proxy.
    */

    const cheekToJawRatio =
        Wc /
        Math.max(
            Wj,
            0.0001
        );


    /*
        Wie stark dominieren die Wangen gegenüber Stirn UND Kiefer?
        Positiver Wert = W_c ist die breiteste Ebene des Gesichts
        (typisch für definierte / diagonale Wangenknochen).
    */

    const cheekDominanceRaw =
        (
            Wc -
            Math.max(Wf, Wj)
        ) / Wc;


    smooth.cheek =
        smoothValue(
            "cheek",
            cheekToJawRatio,
            0.12
        );


    /*
        Wichtig: die Dominanz wurde zuvor direkt aus dem Rohframe
        ausgewertet, waehrend der Wangen-/Kiefer-Quotient durch die
        Historie geschickt wurde. Genau an der Grenze liess das die
        Einstufung pro Frame umspringen: Test mit 0,6 px Tracking-
        Rauschen ergab 79 Labelwechsel in 150 Frames bei sonst
        ruhigem Gesicht.

        Sie laeuft jetzt ueber dieselbe Kette wie alle anderen
        Groessen — Rohwert in die Historie, Einstufung nach dem
        Median der letzten Frames. Der geglaettete Wert dient nur
        der Live-Anzeige.
    */

    const cheekDominance =
        smoothValue(
            "cheekDom",
            cheekDominanceRaw,
            0.12
        );

    pushSample(
        "cheekDom",
        cheekDominanceRaw
    );


    /* "High & Defined" nur, wenn die Wangenebene beide anderen Ebenen
       um mindestens 10% uebertrifft — mit 7% war das bei vielen
       Gesichtern der Normalfall. */

    const cheekStable =
        stableValue(
            "cheek",
            smooth.cheek
        );

    const cheekDomStable =
        stableValue(
            "cheekDom",
            cheekDominance
        );

    if (
        cheekStable > 1.30 ||
        cheekDomStable > 0.10
    ) {

        window.features.cheekbones =
            "High & Defined";

    }
    else if (
        cheekStable > 1.15
    ) {

        window.features.cheekbones =
            "Moderate";

    }
    else {

        window.features.cheekbones =
            "Soft";

    }


    /* ========================================================
       6. EYEBROWS
       ======================================================== */

    /*
        WICHTIG — bug im alten Code:

            browHeight = dist(m[70], m[159]) / faceHeight
                         ~~~~~~~~~~~~~~~~   ~~~~~
                         Braue           Unterlied

        Das mass den Abstand zwischen Braue und Augenlid. Der haengt
        hauptsaechlich an der Augenhoehe, NICHT an der Bogenform — die
        Augenbrauen wurden dadurch fast immer als "High Arch"
        eingestuft, egal wie die Braue tatsaechlich verlief.

        Richtig ist die Bogenhoehe: der Scheitelpunkt der Braue, wie weit
        er ueber der Verbindungslinie Innen- <-> Aussenwinkel steht,
        normiert auf die Laenge dieser Linie. Das ist unabhaengig von
        Abstand und Groesse des Auges.
    */

    const browToLid = (
        dist2D(m[70], m[159]) +
        dist2D(m[300], m[386])
    ) / (2 * faceHeight);

    /* Innerer Endpunkt -> Scheitel -> aeusserer Endpunkt */
    const rightBrow = browArchRatio(
        m[107],
        m[105],
        m[53]
    );

    const leftBrow = browArchRatio(
        m[336],
        m[334],
        m[283]
    );

    const avgArch =
        (
            rightBrow +
            leftBrow
        ) / 2;


    smooth.brow =
        smoothValue(
            "brow",
            avgArch,
            0.12
        );


    /*
        Positiv = der Scheitel steht sichtbar ueber der Innen-/Aussen-
        Linie (gewölbt). Negativ = Braue faellt nach unten.
    */

    /* Schwellen aus der Brauen-Anthropometrie: der Scheitel einer
       gewölbten Braue liegt etwa 0,5-0,8 x Brauendicke (= 5-8 px bei
       50 px Brauenlaenge) ueber der Linie -> 0,10-0,16.
       Gerade Brauen liegen bei 0-0,04. */

    const browStable =
        stableValue(
            "brow",
            smooth.brow
        );

    window.features.brows =
        labelWithHysteresis(
            "brows",
            browStable,
            [0.06, 0.15],
            ["Straight", "Soft Arch", "High Arch"]
        );

/* Samples nach jeder stabilen Messung in die Historie werfen
   (nur wenn die Augen nicht gerade geschlossen sind, sonst droht
   ein einzelner Blinzler, falsche Werte einzuschreiben). */

pushSample('eye', eyeRatio);
if (Math.abs(relativeTilt) < 45) pushSample('tilt', relativeTilt);
pushSample('lip', lipRatio);
pushSample('cheek', cheekToJawRatio);
pushSample('brow', avgArch);


    /* ========================================================
       7. SKIN TONE
       ======================================================== */

    analyzeSkinTone(lm);

    /* Kennzahlen erst hier festschreiben: browArch, browToLid und
       eyeTiltDeg werden weiter oben berechnet — vor der Zuweisung
       waeren sie im TDZ und wuerfen einen ReferenceError. */

    window.measurements = {
        eyeAperture: eyeRatio,
        eyeWidth: (
            leftEyeWidth +
            rightEyeWidth
        ) / 2,
        eyeStable: eyeStable,
        eyeClosed: window._eyeClosed,
        lipRatio: lipRatio,
        tiltDeg: tiltStable,
        browArch: browStable,
        cheekRatio: cheekStable,
        cheekDominance: cheekDomStable,
        frames: history.eye.length,
        source: (
            srcW +
            'x' +
            srcH
        )
    };

    renderLiveMetrics();

    /* Für UI + KI-Prompt: alle Kennzahlen an einem Ort */

    window.faceMetrics = {
        L: L,
        Wf: Wf,
        Wc: Wc,
        Wj: Wj,
        ratio: ratio,
        jawAngle: jawAngle,
        wSpread: wSpread,
        chinWidth: chinWidth,
        chinPointed: chinPointed,
        phi: phiRatio,
        phiDelta: phiDelta,
        zones: [d1, d2, d3],
        zoneSpread: zoneSpread,
        eyeWidth: eyeWidth,
        fiveEye: fiveEye,
        innerGap: innerGap,
        gapRatio: gapRatio,
        browArch: avgArch,
        browToLid: browToLid,
        eyeTiltDeg: relativeTilt
    };


    /* --------------------------------------------------------
       8. Sync detected values into the manual inputs
       -------------------------------------------------------- */

    syncManualFeatures();

}


/* ============================================================
   CAMERA
   ------------------------------------------------------------
   Die Kamera startet NICHT mehr blind beim Seitenaufbau: ein
   getUserMedia ohne Nutzer-Geste wird von aktuellen Browsern
   blockiert bzw. scheitert still — es kamen dann nie Frames an,
   also auch keine Landmarks und keine Merkmale. Gestartet wird
   jetzt beim Klick auf "INITIALIZE SCAN" (Nutzergeste) und nur
   einmal. Fehler landen sichtbar in #mediapipe-note.
   ============================================================ */

let cam = null;

let cameraStarting = null;


/* WICHTIG: "läuft schon?" darf sich NICHT an "cam existiert" orientieren —
   cam wird gesetzt, BEVOR start() erfolgreich war. Sonst meldet ein
   zweiter Aufruf Erfolg, obwohl die Kamera gerade scheitert, und
   stopCamera() hätte nichts zu stoppen. */
function isCameraRunning() {

    return (
        window.cameraActive === true &&
        cam !== null
    );

}


/* Wartet, bis das Video wirklich Frames hat. videoWidth wird erst
   gesetzt, wenn der Decoder den ersten Frame geliefert hat — direkt
   nach start() ist es oft noch 0. Ohne dieses Warten meldet der
   Quellgroessen-Test in handleResults faelschlich "Quelle liefert
   nichts". */

function waitForVideoReady(timeoutMs = 4000) {

    return new Promise((resolve) => {

        if (video.videoWidth && video.videoHeight) {

            resolve(true);
            return;

        }

        const started = Date.now();

        const tick = () => {

            if (video.videoWidth && video.videoHeight) {

                resolve(true);

            }
            else if (Date.now() - started > timeoutMs) {

                mediaPipeWarning(
                    'the camera started but delivered no image after ' +
                    Math.round(timeoutMs / 1000) +
                    ' s — close other apps using the camera, or use ' +
                    '"Upload a photo".'
                );
                resolve(false);

            }
            else {

                setTimeout(tick, 100);

            }

        };

        tick();

    });

}


async function startCameraStream() {

    if (isCameraRunning()) return true;
    if (cameraStarting) return cameraStarting;

    cameraStarting = (async () => {

        if (
            typeof window.Camera !== 'function'
        ) {

            mediaPipeWarning('camera_utils did not load');
            return false;

        }

        try {

            const candidate = new window.Camera(
                video,
                {

                    onFrame: async () => {

                        if (!faceMesh) return;

                        try {

                            await faceMesh.send({
                                image: video
                            });

                            frameStreamOk();

                        }
                        catch (e) {

                            /* Ein einzelner fehlgeschlagener Frame darf
                               die Schleife nicht killen — aber er darf
                               auch nicht spurlos verschwinden. Sonst
                               bleibt bei einem echten Fehler die
                               Oberflaeche einfach leer, ohne jeden
                               Hinweis. Zählen, erste Meldung zeigen,
                               Modell-Download nicht als Fehler werten
                               (siehe FRAME-DIAGNOSE oben). */

                            frameStreamFailed(e);

                        }

                    },

                    width: 640,

                    height: 480

                }
            );

            await candidate.start();

            /* Frame-Zähler neu starten: Modell-Download läuft erst ab
               hier mit — Fehler davor dürfen die Warnung nicht triggern
               (siehe FRAME-DIAGNOSE). */
            mpResetFrameStats();

            /* Ohne diese drei Zeilen startet das Video auf iOS/Safari
               nicht: die Autoplay-Richtlinie verlangt bei einem
               Videostream muted, und playsinline, damit er nicht in
               den Vollbild schaltet. Ohne playing Bild laeuft der Stream
               trotzdem, aber videoWidth bleibt 0 — und dann liefert
               handleResults nichts und alle Felder bleiben leer.
               camera_utils setzt muted zwar, das haengt aber an der
               geladenen Version und ist hier nicht ausdruecklich
               abgesichert. */

            video.muted = true;
            video.playsInline = true;

            try {

                await video.play();

            }
            catch (e) {

                /* autoplay abgelehnt: der Klick auf "INITIALIZE SCAN"
                   ist die Nutzergeste, aber manche Browser blockieren
                   trotzdem. Ohne playing gibt es keine Groesse und
                   damit keine Merkmale — also sichtbar machen. */

                mediaPipeWarning(
                    'the browser blocked video playback (' +
                    (e && e.name ? e.name : 'autoplay') +
                    ') — tap INITIALIZE SCAN again'
                );

                return false;

            }

            await waitForVideoReady();

            cam = candidate;
            window.cameraActive = true;
            window.cameraError = '';
            window.mediapipeError = '';
            window.photoMode = false;
            hidePhotoPreview();
            /* Neue Sitzung: alte Messungen duerfen das Ergebnis nicht
               beeinflussen (z. B. beim Wechsel zu einer anderen Person). */
            resetHistory();

            const note = document.getElementById('mediapipe-note');
            if (note) note.style.display = 'none';

            /* Alte Fehlermeldung loeschen, sonst steht sie beim naechsten
               Fehler wieder als "Details" oben. */
            const detail = document.getElementById('mediapipe-note-detail');
            if (detail) detail.textContent = '';

            return true;

        }
        catch (e) {

            cam = null;
            window.cameraError =
                e && e.name === 'NotAllowedError'
                    ? 'camera permission denied'
                    : (e && e.message) || 'camera failed to start';

            mediaPipeWarning(
                `Camera unavailable: ${window.cameraError}. Use \u201cUpload a photo\u201d instead.`
            );

            return false;

        }
        finally {

            cameraStarting = null;

        }

    })();

    return cameraStarting;

}


window.startCamera = startCameraStream;


/* MediaPipe laden und — falls erlaubt — die Kamera starten. */

initMediaPipe().then(function (ok) {
    if (ok) startCameraStream();
});

/* ============================================================
   INSTANT-IMAGE ANALYSIS (Foto-Upload / gespeichertes Profil)
   ============================================================ */

// MediaPipe auf ein <img>-Element anwenden (Foto statt Kamera).
// löst onResults() aus → Merkmale + Face-Map-Landmarks.
// Ohne Engine darf das nicht mit einem TypeError enden, sondern der Aufrufer
// (ensureLandmarks) braucht eine saubere Fehlermeldung.
window.runFaceMeshOn = (img) => {

    if (!faceMesh || typeof faceMesh.send !== 'function') {
        const msg = 'face-detection library not loaded';
        window.mediapipeError = msg;
        window.mediapipeReady = false;
        mediaPipeWarning(msg);
        return Promise.reject(new Error(msg));
    }
    return faceMesh.send({ image: img });

};

// Analysen-Umstellung auf ein hochgeladenes Bild.
window.useUploadedPhoto = (img) => {
    window.photoMode = true;
    analysisSource = img;
    resetHistory();
    /* Punkte der vorherigen Kamerastunde gehoeren nicht zum neuen Foto —
       sonst stunden sie einen Moment lang ueber dem falschen Gesicht,
       bis MediaPipe das Foto ausgewertet hat. */
    window._lastLandmarks = null;
    window._landmarksAt = 0;
    showPhotoPreview(img);
    if (faceMesh && typeof faceMesh.send === 'function') {
        faceMesh.send({ image: img });
    }
    else {
        /* Sonst passiert beim Upload gar nichts und der Nutzer wundert sich,
           warum das Foto keine Merkmale liefert. */
        mediaPipeWarning('face-detection library not loaded — the photo cannot be measured yet');
    }
};

/* ============================================================
   STOP CAMERA + FACE SNAPSHOT
   ============================================================ */

// Actually stop the webcam when analysis starts
window.stopCamera = () => {
    if (cam && typeof cam.stop === 'function') cam.stop();
};

// Capture the current camera frame as a photo for the results page.
// Called BEFORE stopCamera() so the last frame is still available.
window.captureFaceSnapshot = () => {
    if (!video.videoWidth) return null;
    const snap = document.createElement('canvas');
    snap.width = video.videoWidth;
    snap.height = video.videoHeight;
    snap.getContext('2d').drawImage(video, 0, 0);
    return snap.toDataURL('image/jpeg', 0.85);
};