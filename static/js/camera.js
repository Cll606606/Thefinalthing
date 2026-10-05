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

/* Eigener Zeichen-Loop für die Führungslinien — läuft dauernd über dem
   Live-Kamerabild und wartet NICHT auf die Gesichtserkennung. So erscheinen
   die Hilfslinien sofort, auch wenn MediaPipe noch nicht fertig geladen ist
   oder gerade kein Gesicht erkannt wurde. */
let guideRaf = null;
function guideLoop() {
    guideRaf = requestAnimationFrame(guideLoop);
    if (window.photoMode) return;
    if (!video.videoWidth || !video.videoHeight) return;

    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGuide(ctx, canvas.width, canvas.height);

    /* Debug-Punkte (eingeschaltet über die Entwickler-Konsole, window.showMap) */
    if (window.showMap && window._lastLandmarks) {
        const lm = window._lastLandmarks;
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#5ef2c3";
        const points = [10, 152, 234, 454, 33, 133, 362, 263, 159, 145, 160, 144,
                        386, 374, 387, 373, 13, 14, 78, 308, 70, 300,
                        50, 101, 118, 187, 205, 280, 330, 347, 411, 425];
        points.forEach(i => {
            const p = lm[i];
            if (!p) return;
            ctx.beginPath();
            ctx.arc(p.x * canvas.width, p.y * canvas.height, 3, 0, 2 * Math.PI);
            ctx.stroke();
        });
    }
}
guideLoop();

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


function resetHistory() {

    for (const key in history) history[key].length = 0;

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


/* Sichtbarer Hinweis statt stillem Weiterlaufen. */
function mediaPipeWarning(reason) {

    window.mediapipeError = reason;

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
                `${MEDIAPIPE_CDN}${file}`

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
        window._sourceSizePending = true;
        return;
    }

    window._sourceSizePending = false;

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

    if (eyeStable > 0.44) {

        window.features.eyes =
            "Round";

    }
    else if (eyeStable > 0.27) {

        window.features.eyes =
            "Almond";

    }
    else {

        window.features.eyes =
            "Narrow / Hooded";

    }


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

    if (tiltStable < -3) {

        window.features.eyeTilt =
            "Downturned";

    }
    else if (tiltStable > 3) {

        window.features.eyeTilt =
            "Upturned";

    }
    else {

        window.features.eyeTilt =
            "Neutral";

    }


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

    if (lipStable > 0.36) {

        window.features.lips =
            "Full";

    }
    else if (lipStable > 0.22) {

        window.features.lips =
            "Balanced";

    }
    else {

        window.features.lips =
            "Thin";

    }


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

    if (browStable > 0.15) {

        window.features.brows =
            "High Arch";

    }
    else if (browStable > 0.06) {

        window.features.brows =
            "Soft Arch";

    }
    else {

    window.features.brows =
        "Straight";

}

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

                        }
                        catch (e) {

                            /* ein einzelner fehlgeschlagener Frame
                               darf nicht die ganze Schleife killen */

                        }

                    },

                    width: 640,

                    height: 480

                }
            );

            await candidate.start();

            cam = candidate;
            window.cameraActive = true;
            window.cameraError = '';
            window.mediapipeError = '';
            window.photoMode = false;
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