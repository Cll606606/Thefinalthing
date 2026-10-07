// Die KI läuft in der Cloud (kostenloser Gemini-Schlüssel vom Server).
// So braucht es auf dem Gerät weder WebGPU noch eine riesige herunterladbare
// KI-Datei — wichtig vor allem fürs Handy und für iPhones.
window.currentBudget = 100;

// --- Auswahl am Anfang der Analyse: Modell / Sprache / Umfang ---
// "auto" heisst: Server entscheidet bzw. Sprache folgt der Oberflaeche.
window.aiModel = 'auto';
window.aiLang = 'auto';
window.aiMode = 'standard';

// Umfang -> Vorgaben fuer den Prompt. Die Schrittzahl ist die einzige
// Stelle, an der "wie lang" wirklich etwas bedeutet: alles andere waere
// nur Fliesstext drumherum.
const AI_MODES = {
    quick: {
        steps: 3,
        rule: 'Create EXACTLY 3 steps - the bare minimum routine, nothing optional. '
            + 'Every step must still be specific to THIS face. Keep each field one short '
            + 'sentence, no repetition, no alternatives.'
    },
    standard: {
        steps: 6,
        rule: 'Create EXACTLY 6 steps - no more, no fewer. Stop immediately after 6 steps. '
            + 'NEVER repeat a product, category, shade, placement or technique.'
    },
    detailed: {
        steps: 6,
        rule: 'Create EXACTLY 6 steps - no more, no fewer. Stop immediately after 6 steps. '
            + 'NEVER repeat a product, category, shade, placement or technique. '
            + 'Write for a BEGINNER who has never done this: explain the reason behind each '
            + 'step in plain words, name the amount to use, and mention the single most '
            + 'common mistake for this face shape.'
    }
};

/* WICHTIG: der Helfer darf nicht "aiMode" heissen - der Zustand sitzt
   unter window.aiMode (gleiche Global-Eigenschaft!) und wuerde die
   Funktion ueberschreiben, das Ergebnis waere "aiMode is not a function". */
function aiModeCfg() {
    return AI_MODES[window.aiMode] || AI_MODES.standard;
}

// Antwortsprache: "auto" = Sprache der Oberflaeche (sonst Englisch).
// Feste, kurze Anweisung an das Modell - der Rest des Prompts bleibt
// Englisch, damit die Feldnamen stabil bleiben.
const AI_LANGS = {
    de: 'Write EVERY value in the JSON in GERMAN (Deutsch). Keep the JSON keys exactly as '
        + 'specified (category, product, placement, shade, technique, why, searchQuery, '
        + 'summary, steps, searchKeyword). Brand and product names stay as they are.',
    en: 'Write EVERY value in the JSON in ENGLISH. Keep the JSON keys exactly as specified.',
    es: 'Write EVERY value in the JSON in SPANISH (Espanol). Keep the JSON keys exactly as '
        + 'specified (category, product, placement, shade, technique, why, searchQuery, '
        + 'summary, steps, searchKeyword). Brand and product names stay as they are.',
    fr: 'Write EVERY value in the JSON in FRENCH (Francais). Keep the JSON keys exactly as '
        + 'specified (category, product, placement, shade, technique, why, searchQuery, '
        + 'summary, steps, searchKeyword). Brand and product names stay as they are.'
};

function aiLangRule() {
    if (window.aiLang && window.aiLang !== 'auto') return AI_LANGS[window.aiLang] || '';
    /* Quelle der Wahrheit ist die i18n-Oberflaeche selbst: I18N.lang bzw.
       document.documentElement.lang (beides setzt i18n.js). Ein eigenes
       Flag waere leicht zu vergessen - so hakt der Prompt automatisch an,
       was der Nutzer gerade liest. */
    const ui = String(
        (window.I18N && window.I18N.lang) || document.documentElement.lang || ''
    ).slice(0, 2).toLowerCase();
    if (ui && AI_LANGS[ui]) {
        return AI_LANGS[ui] + ' (This follows the interface language the user is reading.)';
    }
    return AI_LANGS.en;
}

// Marken-Akzentfarbe lesen: statt hartkodiertem Pink nehmen wir immer
// die aktuelle Akzentfarbe aus dem CSS (derzeit Teal). So bleibt die
// Beauty-Seite automatisch im Look der übrigen App.
function cssVar(name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || '#14b8a6';
}

// Für onclick-Attribute sicher escape'n (zusätzlich zu escHtml).
const attrVal = (s) => escHtml(String(s)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// i18n-Kurzform (fein, wenn i18n.js noch nicht geladen ist → Rückfall = Key).
const T = (k) => (window.T ? window.T(k) : k);

// Deduplicate + cap AI steps: small local models sometimes repeat themselves
// after step 6 or drift into extra steps. This keeps exactly 6 unique ones.
// `cap` folgt der Umfangs-Wahl; 6 ist die Obergrenze, damit ein Modell,
// das mehr liefert, das Ergebnis nicht aufblaeht.
function cleanSteps(steps, cap = 6) {
    if (!Array.isArray(steps)) return [];
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const seenProducts = new Set();
    const seenSig = new Set();
    const out = [];
    for (const s of steps) {
        const product = norm(s.product || s.title);
        const sig = product + '|' + norm(s.placement);
        if (product && seenProducts.has(product)) continue; // repeated product => skip
        if (sig && seenSig.has(sig)) continue;              // repeated step content => skip
        if (product) seenProducts.add(product);
        seenSig.add(sig);
        out.push(s);
        if (out.length >= cap) break;
    }
    return out;
}

// Cloud-Aufruf: das JSON kommt vom Server (Gemini). Wiederholungsversuche
// bei 503/Netzabbrüchen, damit kurze Überlastung der KI nicht den Ablauf killt.
async function serverJson(prompt, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch('/api/text-ai', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // Modellwahl mitschicken. "auto" = Server nimmt seine
                // eigene Fallback-Kette in der konfigurierten Reihenfolge.
                body: JSON.stringify({ prompt, model: window.aiModel || 'auto' }),
                signal: window.aiController ? window.aiController.signal : undefined
            });
            if (res.status === 503 && attempt < retries) {
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }
            const obj = await res.json();
            if (obj.key_missing) {
                /* Die Meldung kommt vom Server, weil nur er weiss, wo er
                   laeuft: lokal hilft eine .env-Datei, auf Render nur die
                   Variable im Dashboard. */
                throw new Error(obj.error || obj.message ||
                    'The server has no AI key set up.');
            }
            if (!obj.ok || !obj.data) throw new Error(obj.error || 'Cloud AI failed.');
            // Merken, welches Modell wirklich geantwortet hat (kann vom
            // gewaehlten abweichen, wenn es ausfaellt und der Server
            // weiter die Kette durchprobiert).
            window.aiModelUsed = obj.model || window.aiModelUsed;
            return obj.data;
        } catch (e) {
            if (attempt < retries && (e.message.includes('503') || e.message.includes('Failed to fetch') || e.message.includes('NetworkError'))) {
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }
            throw e;
        }
    }
}

// Einheitlicher KI-Aufruf für alle Analysen — aktuell immer die schnelle
// Cloud-Variante. Sollte irgendwann eine lokale KI dazukommen, tauscht man
// nur diese eine Stelle.
async function runAi(prompt, maxTokens) {
    return serverJson(prompt);
}

// --- 1. UI HELPERS (Outside of startAnalysis so they are always "clickable") ---

window.setStyle = (styleName, el) => {
    const input = document.getElementById('style-req');
    if(input) input.value = styleName;

    document.querySelectorAll('.style-card').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
};

window.setBudget = (val, el) => {
    window.currentBudget = val;
    document.querySelectorAll('.budget-chip').forEach(b => b.classList.remove('picked'));
    el.classList.add('picked');
    const custom = document.getElementById('custom-budget');
    if (custom) custom.value = '';
};

// --- Auswahl-Chips: Modell / Sprache / Umfang ---
// Ein Muster fuer alle drei: Wert merken, Geschwister abwaehlen, den
// gewaehlten Chip markieren. "data-pick" haelt die Chip-Gruppe auseinander.
function pickChip(value, el, group) {
    const state = { model: 'aiModel', lang: 'aiLang', mode: 'aiMode' }[group];
    window[state] = value;
    document.querySelectorAll('[data-pick="' + group + '"]').forEach(c => {
        c.classList.toggle('picked', c === el);
    });
}

window.setAiModel = (val, el) => pickChip(val, el, 'model');
window.setAiLang = (val, el) => pickChip(val, el, 'lang');
window.setAiMode = (val, el) => pickChip(val, el, 'mode');

// Modellmenue aus der Server-Konfiguration fuellen. Der Browser erfindet
// keine Modellnamen - sonst zeigt er Modelle, die der Key gar nicht hat,
// und der Aufruf laeuft ins Leere. Ohne Antwort (offline, kein Login)
// bleibt einfach "Auto" stehen, das ist immer gueltig.
window.loadAiModels = async () => {
    const box = document.getElementById('ai-model-chips');
    if (!box) return;
    try {
        const res = await fetch('/api/ai-models', { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return;
        const obj = await res.json();
        const models = Array.isArray(obj.models) ? obj.models : [];
        if (!models.length) return;

        // "Auto" bleibt immer erste Option.
        let html = '<button class="chip-alt picked" data-pick="model" data-default="true" '
            + 'onclick="setAiModel(\'auto\', this)" data-i18n="b.aiAuto">\u2699 Auto</button>';
        models.forEach(m => {
            const safe = String(m).replace(/[^A-Za-z0-9._-]/g, '');
            if (!safe) return;
            html += '<button class="chip-alt" data-pick="model" '
                + 'onclick="setAiModel(\'' + safe + '\', this)">' + safe + '</button>';
        });
        box.innerHTML = html;

        // Neues Markup einfuegen -> Labels in der aktuellen Sprache setzen.
        if (window.I18N && typeof window.I18N.apply === 'function') window.I18N.apply();
    } catch (e) {
        // Kein Netz/kein Key: "Auto" ist bereits da und reicht.
    }
};

// Numbers-only custom budget. Strips every non-numeric character so a
// price field can never contain letters or symbols.
window.customBudget = (el) => {
    const cleaned = String(el.value).replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    if (cleaned !== el.value) el.value = cleaned;
    document.querySelectorAll('.budget-chip').forEach(b => b.classList.remove('picked'));
    const n = parseFloat(cleaned);
    if (!isNaN(n) && n > 0) window.currentBudget = n;
};

// Merge the auto-detected features with the user's manual overrides.
// A field only counts as an override when the user actually typed in it
// (markEdited). Otherwise the scanner's own value would freeze the field
// after the first frame — squinting later would still report the first
// measurement, which is exactly the "it always says Round eyes" bug.
window.collectFeatures = () => {
    const detected = window.features || {};
    const ids = {
        face: 'manual-face',
        eyes: 'manual-eyes',
        eyeTilt: 'manual-eyeTilt',
        lips: 'manual-lips',
        brows: 'manual-brows',
        cheekbones: 'manual-cheekbones',
        tone: 'manual-tone'
    };
    const edited = window.editedInputs || new Set();
    const out = {};
    for (const key in ids) {
        const el = document.getElementById(ids[key]);
        const typed = edited.has(ids[key]) && el && el.value ? el.value.trim() : '';
        out[key] = (typed && typed !== '--')
            ? typed
            : (detected[key] && detected[key] !== '--' ? detected[key] : '--');
    }
    return out;
};

// Klick auf ein Feature-Merkmal: setzt die gewählten Merkmale ins Textfeld
// „feature-search" (mit/ohne Komma) und hebt die Auswahl farblich hervor.
window.toggleFeature = (name, el) => {
    const input = document.getElementById('feature-search');

    if (input.value.includes(name)) {
        // Schon gewählt? Dann wieder entfernen und abwählen.
        input.value = input.value.replace(name, '').replace(/,\s*,/, ',').trim();
        el.style.borderColor = '#333';
        el.style.color = '#fff';
    } else {
        // Noch nicht drin? Anhängen und markieren.
        input.value += (input.value ? ', ' : '') + name;
        el.style.borderColor = cssVar('--primary');
        el.style.color = cssVar('--primary');
    }
};

// --- 2. MAIN AI ANALYSIS ---
window.startAnalysis = async () => {
    // Neuer Abbruch-Controller für jeden Lauf (Stop AI).
    window.aiController = new AbortController();
    const stopBtn = document.getElementById('ai-stop-btn');
    if (stopBtn) stopBtn.style.display = 'inline-block';

    /* Kamera ggf. erst hier starten — der Klick ist die Nutzergeste,
       die Browser für getUserMedia verlangen. Ohne sie kommen keine
       Frames und damit auch keine erkannten Merkmale. */
    if (typeof window.startCamera === 'function' && !window.cameraActive) {
        await window.startCamera();
    }

    /* Kurzes Warten, damit MediaPipe den ersten Frame verarbeiten kann,
       sonst ist der Schnappschuss schwarz. */
    if (!window.faceSnapshot && window.cameraActive) {
        await new Promise((r) => setTimeout(r, 900));
        if (typeof window.captureNow === 'function') {
            try { window.captureNow(); } catch (e) { /* egal */ }
        }
    }

    if (!window.faceSnapshot) {
        alert(t('scan.noface', 'No photo captured yet. Allow the camera, or use “📤 Upload a photo” / “📸 Use my saved photo” on the scanner screen.'));
    }

    // Use the snapshot captured earlier at INITIALIZE time.
    if (window.faceSnapshot) {
        const photo = document.getElementById('face-photo');
        const wrap = document.getElementById('face-photo-wrap');
        if (photo) photo.src = window.faceSnapshot;
        if (wrap) wrap.style.display = 'block';
    }
    if (window.stopCamera) window.stopCamera();
    const loader = document.getElementById('loading-overlay');
    const statusText = document.getElementById('loading-status');
    const styleReq = document.getElementById('style-req').value || "Natural Glam";
    const extraFeatures = document.getElementById('feature-search').value;
    
    loader.style.display = 'flex';
    statusText.innerText = T('l.analyzing');

    try {
        const f = window.collectFeatures();

        /* Messwerte der geometrischen Analyse als Text — für die KI
           (präzise Platzierung) und als sichtbare Kennzahlen für den User. */
        const m = window.faceMetrics;
        const pct = (v) => `${Math.round(v * 100)}%`;
        let geoLine = '';
        if (m) {
            geoLine = `\nMEASURED FACE GEOMETRY (math, use for precise placement): length/cheek-width = ${m.ratio.toFixed(2)} (golden ratio target 1.618, deviation ${pct(m.phiDelta)}), jaw angle = ${Math.round(m.jawAngle)}°, forehead/cheek/jaw width = ${pct(m.Wf / m.Wc)} / ${pct(1)} / ${pct(m.Wj / m.Wc)}, chin width = ${pct(m.chinWidth / m.Wj)} of jaw width, three-zone balance (hairline→brow→nose→chin) deviation = ${pct(m.zoneSpread)} (0% = perfectly equal thirds), five-eye ratio = ${m.fiveEye.toFixed(2)} (ideal 5.00), inner eye gap = ${m.gapRatio.toFixed(2)} × one eye width (ideal 1.00).`;
            renderGeometry();
        }

        const ids = ['res-face', 'res-eyes', 'res-eyeTilt', 'res-lips', 'res-brows', 'res-cheeks', 'res-tone'];
        const keys = ['face', 'eyes', 'eyeTilt', 'lips', 'brows', 'cheekbones', 'tone'];
        
        ids.forEach((id, i) => {
            const el = document.getElementById(id);
            if(el) el.innerText = (f[keys[i]] && f[keys[i]] !== "--") ? f[keys[i]] : "Detecting...";
        });

        // Skin tone badge on the captured photo
        const toneBadge = document.getElementById('tone-badge');
        if (toneBadge && f.tone && f.tone !== "--") toneBadge.innerText = `Skin: ${f.tone}`;

        // Optimized prompt: professional MUA detail so steps are specific, not generic
        const mode = aiModeCfg();
        const langRule = aiLangRule();
        const prompt = `You are a high-end professional Makeup Artist. Create a tailored tutorial for a ${f.face} face, ${f.eyes} eyes with ${f.eyeTilt} eye tilt, ${f.lips} lips, ${f.brows} brows, ${f.cheekbones} cheekbones, ${f.tone} skin. Style: ${styleReq}. Preferences: ${extraFeatures}. Budget total: $${window.currentBudget}.${geoLine}

THE MOST IMPORTANT RULE: every step must be individually adapted to THIS user's measurements. Map them one-by-one:
- EYES (${f.eyes} + ${f.eyeTilt}): pick exact eye techniques that flatter this shape, e.g. hooded = no product above the crease until the browbone / round = deepen the outer V / narrow = open it with a light inner corner and clean liner / upturned or downturned = place the wing along the corrected angle.
- LIPS (${f.lips}): ${f.lips === 'Thin' ? 'subtle overline that stays inside the natural lip border, focus on the center' : f.lips === 'Full' ? 'stay inside your natural border, emphasize the cupid\'s bow' : 'sculpt right along the natural border'}.
- BROWS (${f.brows}): ${f.brows === 'High Arch' ? 'soften the arch with fine hair strokes' : f.brows === 'Straight' ? 'add a gentle curve to lift the face' : 'clean up with clear gel and defined strokes'}.
- CHEEKS (${f.cheekbones}): ${f.cheekbones === 'High & Defined' ? 'blush just under the cheekbone, blended up to the temple' : f.cheekbones === 'Soft' ? 'blush on the apples, swept up the temple to add lift' : 'blush at the apples, a whisper of contour underneath'}.
- SKIN (${f.tone}): every base and shade undertone must be chosen for ${f.tone} skin (warm/cool/neutral as appropriate).

${mode.rule} Every step must be specific to THIS face shape, skin tone and style - generic advice like "apply some blush" is FORBIDDEN. Write like a beauty editor, not a robot.

LANGUAGE: ${langRule}

For EVERY step include:
- category: the product group, e.g. Base, Bronzer, Blush, Eyes, Brows, Lips
- product: the exact product WITH texture or finish, e.g. "thin dewy medium-coverage foundation", "pigmented cream blush"
- placement: exactly where on the face it goes for a ${f.face} face, with the reason, e.g. "high on the cheekbones, angled up to lift a round face"
- shade: the exact shade PLUS undertone for ${f.tone} skin, e.g. "soft peach with warm undertone"
- technique: the exact tool and motion, e.g. "damp beauty sponge, stipple from center outward" or "fluffy brush, buff in small circles"
- why: one pro sentence on how this step creates the ${styleReq} effect
- searchQuery: a short shoppable phrase for the product, e.g. "drugstore warm-toned foundation"

Return valid JSON ONLY with exactly ${mode.steps} steps: {"summary":"..","steps":[{"category":"..","product":"..","placement":"..","shade":"..","technique":"..","why":"..","searchQuery":".."}],"searchKeyword":"e.g. soft glam makeup bundle"}`;

        statusText.innerText = T('l.generating');
        let data;
        try {
            data = await runAi(prompt, 2048);
        } catch (aiErr) {
            throw aiErr;
        }

        if (!data) {
            throw new Error("The AI returned no usable output. Tap Analyze again — the model is cached now, so it's usually instant.");
        }

        // Safety net: even if the model repeated itself or added extra steps,
        // show only unique, non-repeating steps - as many as chosen.
        data.steps = cleanSteps(data.steps, mode.steps);

        document.getElementById('ai-summary').innerText = data.summary || "Your custom tutorial is ready.";
        renderTutorial(data);

        statusText.innerText = T('l.matching');
        // Run both in parallel: per-step products + real YouTube tutorials
        await Promise.all([fetchLiveProducts(data), fetchTutorialVideos(data, styleReq)]);

        // Switch screens
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById('step-results').classList.add('active');

        // "Als Gesichtsprofil speichern" anbieten, sobald ein Foto vorhanden ist
        const saveBtn = document.getElementById('save-face-profile-btn');
        if (saveBtn && window.faceSnapshot) saveBtn.style.display = 'inline-block';

    } catch (e) {
        // Per "Stop AI" abgebrochen? Dann still zurück — kein Fehler-Alarm.
        if (e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''))) return;
        // Im Zweifel dem Nutzer eine klare Meldung geben statt ihn raten zu lassen.
        console.error("Analyse fehlgeschlagen:", e);
        alert(`The AI had a small hiccup. Error details: ${e.message}. Please try clicking Analyze again.`);
    } finally {
        loader.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'none';
        statusText.innerText = T('l.analyzing');
    }
};

// "Stop AI" auf dem Lade-Overlay: bricht alle laufenden Anfragen ab.
window.stopAi = () => {
    if (window.aiController) window.aiController.abort();
    const loader = document.getElementById('loading-overlay');
    const status = document.getElementById('loading-status');
    const stopBtn = document.getElementById('ai-stop-btn');
    if (loader) loader.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';
    if (status) status.innerText = T('l.stopped');
};

// --- 3. SHOPPING ENGINE (ONE PRODUCT PER STEP + BUDGET-SAFE COMBOS) ---
// Die Suche läuft über den Server (/api/search). Der Such-API-Schlüssel
// liegt also nur auf dem Server — im Browser wäre er für jeden lesbar.

function parsePrice(raw) {
    const n = parseFloat(String(raw || '').replace(/[^0-9.]/g, ''));
    return isNaN(n) ? null : n;
}

async function searchShopping(query, num) {
    const response = await fetch('/api/search', {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "shopping", q: query, num: num }),
        signal: window.aiController ? window.aiController.signal : undefined
    });
    if (!response.ok) throw new Error('Shopping search failed (' + response.status + ')');
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'Search failed');
    return (data.shopping || []).map(item => ({
        title: item.title || 'Beauty product',
        price: parsePrice(item.price),
        link: item.link || '#',
        img: item.img || 'https://placehold.co/100x100?text=Beauty',
        merchant: item.merchant || 'ONLINE STORE'
    })).filter(p => p.price !== null);
}

async function fetchLiveProducts(data) {
    const list = document.getElementById('product-list-detailed');
    if (!list) return;

    const steps = (data.steps || []).slice(0, 6);
    list.innerHTML = `<p style="text-align:center; padding:20px;">Matching a buyable product to every tutorial step...</p>`;

    try {
        // 1) Search per step so EVERY step gets its own buyable products
        const stepProducts = [];
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const q = step.searchQuery || step.product || '';
            let items = q ? await searchShopping(q, 3) : [];
            items.sort((a, b) => a.price - b.price); // cheapest first = default pick
            stepProducts.push({ step, stepIndex: i, items });
        }

        // 2) Fallback pool: cover any step that found nothing
        const emptySteps = stepProducts.filter(s => s.items.length === 0);
        if (emptySteps.length > 0) {
            const pool = await searchShopping(data.searchKeyword || 'affordable makeup set', 8);
            for (const empty of emptySteps) {
                empty.items = pool.splice(0, 3).sort((a, b) => a.price - b.price);
            }
        }

        window.stepProducts = stepProducts;
        window.comboSelection = stepProducts.map(() => 0); // cheapest option per step by default

        // 3) Fill the "Buy for this step" strip inside every tutorial card
        fillStepShopStrip(stepProducts);

        // 4) Render the interactive combo picker (Shop tab) with live budget check
        renderComboPicker(stepProducts);

    } catch (err) {
        console.error("Shopping API error:", err);
        list.innerHTML = "<p style='text-align:center;'>Product search failed. Check your API key and connection.</p>";
    }
}

function fillStepShopStrip(stepProducts) {
    stepProducts.forEach(({ stepIndex, items }) => {
        const strip = document.getElementById(`step-shop-${stepIndex}`);
        if (!strip) return;
        if (items.length === 0) {
            strip.innerHTML = `<p style="color:#666; font-size:0.8rem; margin:0;">No buyable product matched this step - broaden the preference keywords and retry.</p>`;
            return;
        }
        const best = items[0]; // cheapest match for this step
        strip.innerHTML = `
            <div class="hud-label" style="margin-bottom:8px;">Buy for this step</div>
            <div style="display:flex; align-items:center; gap:10px; background:#141414; border:1px solid #333; border-radius:12px; padding:10px;">
                <img src="${safeUrl(best.img)}" style="width:44px; height:44px; object-fit:contain; background:#fff; border-radius:8px; padding:3px;" onerror="this.style.display='none'">
                <div style="flex:1; min-width:0;">
                    <div style="font-size:0.85rem; line-height:1.3;">${escHtml(best.title)}</div>
                    <div style="color:#888; font-size:0.75rem;">${escHtml(best.merchant)}</div>
                </div>
                <div style="text-align:right; flex-shrink:0;">
                    <div class="brand-glow" style="font-weight:bold;">$${best.price.toFixed(2)}</div>
                    <a href="${safeUrl(best.link)}" target="_blank" rel="noopener" style="color:${cssVar('--primary')}; font-size:0.75rem;">BUY</a>
                </div>
            </div>
            <p style="color:#666; font-size:0.75rem; margin:6px 0 0 0;">More options and a live budget checker for this combo are in the Shop tab.</p>`;
    });
}

function comboTotal() {
    return (window.stepProducts || []).reduce((sum, s, i) => {
        const pick = s.items[(window.comboSelection || [])[i]];
        return sum + (pick ? pick.price : 0);
    }, 0);
}

function renderComboPicker(stepProducts) {
    const list = document.getElementById('product-list-detailed');
    if (!list) return;

    if (stepProducts.length === 0 || stepProducts.every(s => s.items.length === 0)) {
        list.innerHTML = `<p style='text-align:center;'>No products found for any step. Try a broader search or a higher budget.</p>`;
        return;
    }

    const body = stepProducts.map(({ step, stepIndex, items }) => `
        <div class="step-card">
            <div class="step-num">${stepIndex + 1}</div>
            <div class="hud-label">${escHtml(step.category || 'Step')}</div>
            <h3 class="brand-glow">${escHtml(step.product || 'Step product')}</h3>
            <p style="opacity:0.6; font-size:0.8rem; margin:4px 0 12px;">Pick 1 option per step - the total updates instantly.</p>
            ${items.map((it, oi) => `
                <label id="combo-opt-${stepIndex}-${oi}" onclick="selectComboOption(${stepIndex}, ${oi})"
                       style="display:flex; align-items:center; gap:10px; border:1px solid ${oi === 0 ? cssVar('--primary') : '#333'};
                              background:${oi === 0 ? 'rgba(20,184,166,0.10)' : '#141414'};
                              border-radius:12px; padding:10px; margin-bottom:8px; cursor:pointer;">
                    <input type="radio" name="combo-${stepIndex}" ${oi === 0 ? 'checked' : ''} style="flex-shrink:0;">
                    <img src="${safeUrl(it.img)}" style="width:44px; height:44px; object-fit:contain; background:#fff; border-radius:8px; padding:3px; flex-shrink:0;" onerror="this.style.display='none'">
                    <div style="flex:1; min-width:0;">
                        <div style="font-size:0.85rem; line-height:1.3;">${escHtml(it.title)}</div>
                        <div style="color:#888; font-size:0.72rem;">${escHtml(it.merchant)}</div>
                    </div>
                    <div style="text-align:right; flex-shrink:0;">
                        <div class="brand-glow" style="font-weight:bold;">$${it.price.toFixed(2)}</div>
                        <a href="${safeUrl(it.link)}" target="_blank" rel="noopener" style="color:${cssVar('--primary')}; font-size:0.72rem;">BUY</a>
                    </div>
                </label>`).join('')}
            ${items.length === 0 ? `<p style="color:#666; font-size:0.8rem;">No match for this step yet - adjust preferences and regenerate.</p>` : ''}
        </div>`).join('');

    list.innerHTML = `<div id="combo-summary"></div><div id="shopping-list"></div><div class="product-vertical-grid">${body}</div>`;
    updateComboSummary();
}

window.selectComboOption = (stepIdx, optIdx) => {
    window.comboSelection[stepIdx] = optIdx;
    const items = (window.stepProducts[stepIdx] || {}).items || [];
    items.forEach((_, i) => {
        const label = document.getElementById(`combo-opt-${stepIdx}-${i}`);
        if (!label) return;
        label.style.borderColor = i === optIdx ? cssVar('--primary') : '#333';
        label.style.background = i === optIdx ? 'rgba(20,184,166,0.10)' : '#141414';
        const radio = label.querySelector('input');
        if (radio) radio.checked = (i === optIdx);
    });
    updateComboSummary();
};

function updateComboSummary() {
    const el = document.getElementById('combo-summary');
    if (!el) return;
    const total = comboTotal();
    const budget = window.currentBudget;
    const inBudget = total <= budget;
    const diff = Math.abs(budget - total);

    el.innerHTML = `
        <div style="background:#1a1a1a; padding:15px; border-radius:12px; border:1px solid ${inBudget ? '#7cffb2' : '#ff5c5c'}; margin-bottom:15px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                <div>
                    <span style="color:#aaa; font-size:0.8rem;">Your 1-product-per-step combo</span>
                    <h3 style="margin:4px 0 0 0; color:${inBudget ? '#7cffb2' : '#ff5c5c'};">
                        $${total.toFixed(2)} <span style="color:#555; font-size:0.9rem;">of $${budget} budget</span>
                    </h3>
                    <p style="margin:4px 0 0 0; font-size:0.8rem; color:${inBudget ? '#7cffb2' : '#ff5c5c'};">
                        ${inBudget
                            ? `Fits your budget - ${(window.stepProducts || []).length} products, $${diff.toFixed(2)} to spare`
                            : `Over budget by $${diff.toFixed(2)} - swap one or more steps for a cheaper option`}
                    </p>
                </div>
                <div style="width:160px;">
                    <p style="color:#888; font-size:0.72rem; text-align:right; margin:0 0 6px 0;">BUDGET USED: ${budget > 0 ? Math.round((total / budget) * 100) : 0}%</p>
                    <div style="width:100%; height:8px; background:#222; border-radius:4px; overflow:hidden;">
                        <div style="width:${Math.min(100, budget > 0 ? (total / budget) * 100 : 0)}%; height:100%; background:${inBudget ? '#7cffb2' : '#ff5c5c'}; transition: width 0.25s;"></div>
                    </div>
                </div>
            </div>
        </div>`;
    renderShoppingList();
}

// --- SHOPPING LIST: die gewählten Produkte als einfache Einkaufsliste ---
// Damit ist der Einkauf übersichtlicher: alle ausgewählten Produkte mit
// Preis, Kategorie, BUY-Link und Häckchen für "schon besorgt".
window.shoppingBought = window.shoppingBought || (() => {
    try { return new Set(JSON.parse(localStorage.getItem('styleai_shopping_bought') || '[]')); }
    catch (e) { return new Set(); }
})();

function persistShoppingBought() {
    try { localStorage.setItem('styleai_shopping_bought', JSON.stringify([...window.shoppingBought])); } catch (e) {}
}

function selectedShoppingRows() {
    const steps = window.stepProducts || [];
    const sel = window.comboSelection || [];
    const rows = [];
    steps.forEach((s, i) => {
        const pick = (s.items || [])[sel[i]];
        if (!pick) return;
        rows.push({
            stepIdx: i,
            category: (s.category || 'Step'),
            product: (s.product || ''),
            title: pick.title || '',
            merchant: pick.merchant || '',
            price: pick.price || 0,
            link: pick.link || '#'
        });
    });
    return rows;
}

/* Zeigt die mathematischen Messwerte (L/W_c, φ, Dreiteilung,
   Fünfaugen-Regel, Kieferwinkel) im Ergebnis an. Damit der User
   sieht, WORAUF die Empfehlung beruht. */
function renderGeometry() {
    const m = window.faceMetrics;
    const box = document.getElementById('face-geometry');
    const rows = document.getElementById('geometry-rows');
    if (!box || !rows || !m) return;
    const pct = (v) => `${Math.round(v * 100)}%`;
    const gt = (k, fallback) => (typeof T === 'function' ? T(k, fallback) : fallback);
    const z = m.zones || [0, 0, 0];
    /* Landmark-Koordinaten sind normiert — deshalb alles relativ
       ausweisen (Prozent von L bzw. W_c), sonst stehen da 0.00-Werte. */
    const z1 = Math.round((z[0] / m.L) * 100);
    const z2 = Math.round((z[1] / m.L) * 100);
    const z3 = Math.round((z[2] / m.L) * 100);
    const eyePct = Math.round((m.eyeWidth / m.Wc) * 100);
    const lines = [
        `<div><b>${escHtml(gt('g.ratio', 'Length / width'))}:</b> ${m.ratio.toFixed(2)} &nbsp;<span class="muted">(${escHtml(gt('g.ideal', 'length/width ratio that defines the shape'))})</span></div>`,
        `<div><b>${escHtml(gt('g.phi', 'Golden ratio'))} φ:</b> ${m.phi.toFixed(3)} &nbsp;<span class="muted">(${escHtml(gt('g.target', 'target'))} 1.618 · ${escHtml(gt('g.deviation', 'deviation'))} ${pct(m.phiDelta)})</span></div>`,
        `<div><b>${escHtml(gt('g.widths', 'Widths W_f / W_c / W_j'))}:</b> ${pct(m.Wf / m.Wc)} / ${pct(1)} / ${pct(m.Wj / m.Wc)}</div>`,
        `<div><b>${escHtml(gt('g.jaw', 'Jaw angle'))}:</b> ${Math.round(m.jawAngle)}° &nbsp;<span class="muted">(${escHtml(gt('g.jawHint', 'above 145° = round, below 130° = square'))})</span></div>`,
        `<div><b>${escHtml(gt('g.chin', 'Chin / jaw width'))}:</b> ${pct(m.chinWidth / m.Wj)}</div>`,
        `<div><b>${escHtml(gt('g.zones', 'Three zones'))}:</b> ${z1} / ${z2} / ${z3} % ${escHtml(gt('g.ofLength', 'of face length'))} &nbsp;<span class="muted">(${escHtml(gt('g.zoneDev', 'deviation'))} ${pct(m.zoneSpread)})</span></div>`,
        `<div><b>${escHtml(gt('g.fiveEye', 'Five-eye rule'))}:</b> ${m.fiveEye.toFixed(2)} &nbsp;<span class="muted">(${escHtml(gt('g.eyeWidth', 'eye width'))} ${eyePct}% ${escHtml(gt('g.ofWidth', 'of face width'))}, ${escHtml(gt('g.gap', 'inner gap'))} ${m.gapRatio.toFixed(2)}×)</span></div>`
    ];
    rows.innerHTML = lines.join('');
    box.style.display = 'block';
}

function renderShoppingList() {
    const el = document.getElementById('shopping-list');
    if (!el) return;
    const rows = selectedShoppingRows();
    const budget = window.currentBudget || 0;
    const total = rows.reduce((s, r) => s + r.price, 0);
    const boughtCount = rows.filter(r => window.shoppingBought.has(r.stepIdx)).length;

    if (rows.length === 0) {
        el.innerHTML = '';
        return;
    }

    el.innerHTML = `
        <div style="background:#121212; border:1px solid #222; border-radius:18px; padding:16px; margin-bottom:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:6px;">
                <div class="hud-label" style="margin:0;">${T('sl.title')} · ${rows.length}</div>
                <button class="chip-alt" style="padding:6px 12px; font-size:12px; cursor:pointer;" onclick="copyShoppingList()">${T('sl.copy')}</button>
            </div>
            ${rows.map(r => {
                const got = window.shoppingBought.has(r.stepIdx);
                return `
                <div style="display:flex; gap:10px; align-items:center; padding:9px 0; border-bottom:1px solid #1c1c1c;">
                    <input type="checkbox" onchange="toggleBought(${r.stepIdx})" ${got ? 'checked' : ''} style="width:18px; height:18px; flex-shrink:0; accent-color:${cssVar('--primary')};">
                    <div style="flex:1; min-width:0; ${got ? 'opacity:.45; text-decoration:line-through;' : ''}">
                        <div style="font-size:.84rem; line-height:1.3;">${escHtml(r.title)}</div>
                        <div style="color:#888; font-size:.72rem; margin-top:2px;">${escHtml(r.category)} · ${escHtml(r.merchant)}</div>
                    </div>
                    <a href="${safeUrl(r.link)}" target="_blank" rel="noopener" style="color:${cssVar('--primary')}; font-weight:800; font-size:.8rem;">BUY ↗</a>
                    <div style="min-width:54px; text-align:right; flex-shrink:0;">
                        <div class="brand-glow" style="font-weight:bold;">$${r.price.toFixed(2)}</div>
                    </div>
                </div>`;
            }).join('')}
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; padding-top:10px;">
                <div style="font-size:.8rem; color:#aaa;">${boughtCount}/${rows.length} ${T('sl.bought')} · <span style="color:${total <= budget ? '#7cffb2' : '#ff5c5c'};">${T('sl.total')} $${total.toFixed(2)}${budget ? ` / $${budget}` : ''}</span></div>
                <button class="chip-alt" style="padding:6px 12px; font-size:12px; cursor:pointer; background:#161616;" onclick="clearShoppingBought()">${T('sl.reset')} ✓</button>
            </div>
        </div>`;
}

window.toggleBought = (stepIdx) => {
    if (window.shoppingBought.has(stepIdx)) window.shoppingBought.delete(stepIdx);
    else window.shoppingBought.add(stepIdx);
    persistShoppingBought();
    renderShoppingList();
};

window.clearShoppingBought = () => {
    window.shoppingBought.clear();
    persistShoppingBought();
    renderShoppingList();
};

function shoppingListText() {
    return selectedShoppingRows().map((r, i) =>
        `${i + 1}. [${r.category}] ${r.title} (${r.merchant || 'n/a'}) — $${r.price.toFixed(2)} — ${r.link}`
    ).join('\n');
}

window.copyShoppingList = async () => {
    const text = shoppingListText();
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(text); return; } catch (e) {}
    }
    prompt('Copy your shopping list:', text);
};
function renderTutorial(data) {
    const container = document.getElementById('tutorial-steps');
    if(!container) return;

    const steps = data.steps || [];
    container.innerHTML = steps.map((s, i) => {
        // Fallback: if the AI returns the old {title, detail} format
        if (s.title && s.detail && !s.product) {
            return `
            <div class="step-card">
                <div class="step-num">${i + 1}</div>
                <h3 class="brand-glow">${escHtml(s.title)}</h3>
                <p>${escHtml(s.detail)}</p>
            </div>`;
        }

        return `
            <div class="step-card">
                <div class="step-num">${i + 1}</div>
                <div class="hud-label">${escHtml(s.category || 'Step')}</div>
                <h3 class="brand-glow">${escHtml(s.product || 'Custom step')}</h3>
                <p style="margin-top:12px;"><span class="hud-label">Where to apply</span><br>${escHtml(s.placement || '')}</p>
                ${s.technique ? `<p style="margin-top:10px;"><span class="hud-label">Technique</span><br>${escHtml(s.technique)}</p>` : ''}
                <p style="margin-top:10px;"><span class="hud-label">Shade to choose</span><br>${escHtml(s.shade || '')}</p>
                ${s.why ? `<div class="pro-tip">${escHtml(s.why)}</div>` : ''}                <div id="step-shop-${i}" style="margin-top:14px; border-top:1px solid #222; padding-top:12px;"></div>
            </div>`;
    }).join('');
}

// --- 4. VIDEO TUTORIALS (real YouTube results via Serper) ---
async function fetchTutorialVideos(data, style) {
    const container = document.getElementById('video-tutorials');
    if (!container) return;

    const query = `${style || 'natural glam'} makeup tutorial`;
    const fallbackUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

    container.innerHTML = `<p style="text-align:center; padding:15px; color:#666; font-size:0.85rem;">Finding video tutorials for this look...</p>`;

    try {
        const response = await fetch('/api/search', {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "videos", q: query, num: 4 }),
            signal: window.aiController ? window.aiController.signal : undefined
        });
        if (!response.ok) throw new Error('Video search failed (' + response.status + ')');
        const obj = await response.json();
        if (!obj.ok) throw new Error(obj.error || 'Video search failed');
        const videos = (obj.videos || []).slice(0, 4).filter(v => v.link && v.title);

        if (videos.length === 0) {
            container.innerHTML = `
                <div class="hud-label" style="margin-bottom:8px;">Video tutorial</div>
                <a class="video-card" href="${fallbackUrl}" target="_blank" rel="noopener">Open "${escHtml(query)}" on YouTube</a>`;
            return;
        }

        container.innerHTML = `
            <div class="hud-label" style="margin-bottom:8px;">Watch how to do this look</div>
            <div class="video-list">
                ${videos.map(v => `
                <a class="video-card" href="${safeUrl(v.link)}" target="_blank" rel="noopener">
                    <img src="${safeUrl(v.imageUrl) || 'https://placehold.co/96x60/222/fff?text=YT'}"
                         onerror="this.src='https://placehold.co/96x60/222/fff?text=YT'">
                    <div class="video-info">
                        <div class="video-title">${escHtml(v.title)}</div>
                        <div class="video-meta">${escHtml(v.channel || '')}${v.duration ? ' - ' + escHtml(v.duration) : ''}</div>
                    </div>
                </a>`).join('')}
            </div>
            <div class="video-more-row">
                <a href="${fallbackUrl}" target="_blank" rel="noopener">See more on YouTube</a>
            </div>`;
    } catch (err) {
        console.error("Video search error:", err);
        container.innerHTML = `
            <div class="hud-label" style="margin-bottom:8px;">Video tutorial</div>
            <a class="video-card" href="${fallbackUrl}" target="_blank">Open "${query}" on YouTube</a>`;
    }
}

// --- 5. HAIRSTYLE: Eingaben (Barber vs. Styling, Haartyp, Freitext) ---

window.hairGoal = 'either';
window.hairTypes = [];

window.toggleHairForm = function () {
    const el = document.getElementById('hair-form');
    if (!el) return;
    const open = el.style.display !== 'block';
    el.style.display = open ? 'block' : 'none';
    if (open) {
        const box = document.getElementById('hair-recommendation');
        if (box) box.style.display = 'none';
    }
};

document.addEventListener('click', function (e) {
    const btn = e.target.closest
        ? e.target.closest('.style-chip')
        : null;
    if (!btn) return;
    if (btn.dataset.goal) {
        window.hairGoal = btn.dataset.goal;
        document.querySelectorAll('#hair-goal .style-chip').forEach(
            (b) => b.classList.toggle('active', b === btn)
        );
        updateHairGoalHint();
    }
    if (btn.dataset.type) {
        const t = btn.dataset.type;
        const i = window.hairTypes.indexOf(t);
        if (i >= 0) window.hairTypes.splice(i, 1);
        else window.hairTypes.push(t);
        btn.classList.toggle('active');
    }
});

function updateHairGoalHint() {
    const hint = document.getElementById('hair-goal-hint');
    if (!hint) return;
    const key = {
        barber: 'h.goalBarberHint',
        style: 'h.goalStyleHint',
        either: 'h.goalEitherHint'
    }[window.hairGoal] || 'h.goalEitherHint';
    hint.textContent = (typeof T === 'function')
        ? T(key, '')
        : '';
    hint.style.display = hint.textContent ? 'block' : 'none';
}

/* Übersetzt die Chips in lesbare englische Begriffe für den Prompt. */
const HAIR_TYPE_LABELS = {
    long: 'long',
    short: 'short',
    medium: 'medium length',
    straight: 'straight',
    wavy: 'wavy',
    curly: 'curly',
    coily: 'coily / afro-textured',
    frizzy: 'frizzy',
    thick: 'thick / dense',
    fine: 'fine / thin',
    dry: 'dry',
    oily: 'oily / gets greasy fast',
    damaged: 'color-treated / damaged',
    grey: 'growing out grey'
};

window.collectHairDetails = function () {
    const notes = document.getElementById('hair-notes');
    return {
        goal: window.hairGoal || 'either',
        types: (window.hairTypes || []).map(
            (t) => HAIR_TYPE_LABELS[t] || t
        ),
        notes: notes ? String(notes.value || '').trim() : ''
    };
};

window.getHairRecommendation = async () => {
    const f = window.collectFeatures();
    const styleReq = document.getElementById('style-req').value || "Natural Glam";
    const box = document.getElementById('hair-recommendation');
    if (!box) return;

    const h = window.collectHairDetails();

    /*
        Ziel übersetzen:
        - barber  = es darf geschnitten / umgefärbt werden
        - style   = die vorhandene Länge und Farbe BLEIBEN, nur Styling/Produkte
        - either  = beides vorschlagen, Cut klar als optional markieren
    */
    const goalText = {
        barber: 'They WILL visit a barber/salon: cutting, reshaping and coloring are all allowed. Suggest a real cut.',
        style: 'They do NOT want a cut and do NOT want to change their length or base color. Keep their current hair as it is and ONLY propose styling, products, heat tools, accessories (headbands, clips, buns, blow-dry direction) and gentle maintenance. Never propose a cut or a color change.',
        either: 'Suggest both: a salon option (cut + color) AND a no-salon option (styling only, keeping their current length and color).'
    }[h.goal];

    const typeText = h.types.length
        ? h.types.join(', ')
        : 'not specified — infer it from the photo and say what you assumed';

    const notesText = h.notes
        ? `In the user's own words: "${h.notes}"`
        : 'The user gave no extra notes.';

    box.style.display = 'block';
    box.innerHTML = `<p style="text-align:center; color:#666; font-size:0.9rem;">Asking your stylist what suits a <b>${escHtml(f.face)}</b> face... 💇</p>`;

    const m = window.faceMetrics;
    const geo = m
        ? `Face geometry: length/width = ${m.ratio.toFixed(2)}, jaw angle = ${Math.round(m.jawAngle)}°, forehead/cheek/jaw = ${Math.round(m.Wf / m.Wc * 100)}%/${Math.round(m.Wj / m.Wc * 100)}% of cheek width, chin = ${Math.round(m.chinWidth / m.Wj * 100)}% of jaw width.`
        : '';

    try {
        // Die KI läuft auf dem Server — dadurch braucht das Handy weder
        // WebGPU noch einen großen Download für die Analyse.
        const prompt = `You are a celebrity hairstylist working with this client.
FACE: "${f.face}" face, eyes "${f.eyes}" (${f.eyeTilt} tilt), brows "${f.brows}", lips "${f.lips}", cheekbones "${f.cheekbones}", skin tone "${f.tone}". ${geo}
REQUESTED VIBE: "${styleReq}".
THEIR HAIR RIGHT NOW: ${typeText}. ${notesText}
HARD REQUIREMENT — GOAL: ${goalText}

Propose 3 DIFFERENT options that flatter these exact features. The 3 options must be genuinely different approaches (for example volume vs. sleek vs. texture-revealing; long vs. short; blunt vs. layered) — not three variations of the same idea. Each option must respect the goal above: if the goal is "style only", NO option may involve a cut or a color change. If hair type conflicts with a cut (e.g. very curly hair), pick lengths and layers that actually work with that texture and say why.

Return valid JSON ONLY (no markdown, no explanation outside JSON) in exactly this shape:
{"options":[{
"name":"clear hairstyle name",
"goodFor":"one short line: is this a salon cut or styling-only?",
"why":"2 sentences on exactly how this balances THIS face shape and feature set",
"cut":"the precise cut: lengths, layers, fringe — or 'no cut needed' if styling only",
"color":"color advice suited to ${f.tone} skin — or 'keep your color' if styling only",
"styling":"how to style it daily in 2 quick steps, with the actual tool/product",
"ask":"one exact sentence to say at the salon — or omit-friendly: give the exact at-home instruction if no salon visit",
"maintenance":"honest upkeep: how often it needs a trim, touch-ups or product",
"difficulty":"easy | medium | advanced",
"searchQuery":"one short shoppable phrase for reference photos, e.g. 'long layered cut with curtain bangs'"
},{...second...},{...third...}]}
`;

        const data = await runAi(prompt, 900);
        if (!data) throw new Error("The hair stylist returned no usable output. Tap again — it works instantly the second time.");

        /* Robust gegen beide Formate: neu {"options":[...]} und
           alt {name, why, ...} — dann einfach als einzelne Option zeigen. */
        let options = Array.isArray(data.options)
            ? data.options
            : (data.name ? [data] : []);
        options = options.filter((o) => o && (o.name || o.why));
        if (!options.length) throw new Error("The stylist sent ideas I could not read. Tap again.");

        const cards = options.map(
            (o, i) => `
        <div class="hair-card" style="background:#121212; border:1px solid #222; border-radius:20px; padding:18px; margin-top:14px;">
            <div style="display:flex; align-items:baseline; gap:8px; flex-wrap:wrap;">
                <span class="hud-label" style="margin:0;">${escHtml(t('h.option', 'Option'))} ${i + 1}</span>
                ${o.goodFor ? `<span style="color:${cssVar('--primary')}; font-size:.7rem; border:1px solid ${cssVar('--primary')}; border-radius:20px; padding:2px 9px;">${escHtml(o.goodFor)}</span>` : ''}
                ${o.difficulty ? `<span style="color:#777; font-size:.7rem;">${escHtml(t('h.difficulty', 'difficulty'))}: ${escHtml(o.difficulty)}</span>` : ''}
            </div>
            <h3 class="brand-glow" style="margin:6px 0 10px; font-size:19px;">${escHtml(o.name || 'Layered Cut')}</h3>
            ${o.why ? `<p style="font-style:italic; color:#bbb; line-height:1.65; margin:0;">"${escHtml(o.why)}"</p>` : ''}
            ${o.cut ? `<p style="margin-top:11px;"><span class="hud-label">${escHtml(t('h.cut', 'The Cut'))}</span><br>${escHtml(o.cut)}</p>` : ''}
            ${o.color ? `<p style="margin-top:9px;"><span class="hud-label">${escHtml(t('h.color', 'Color'))}</span><br>${escHtml(o.color)}</p>` : ''}
            ${o.styling ? `<p style="margin-top:9px;"><span class="hud-label">${escHtml(t('h.styling', 'Daily Styling'))}</span><br>${escHtml(o.styling)}</p>` : ''}
            ${o.maintenance ? `<p style="margin-top:9px;"><span class="hud-label">${escHtml(t('h.upkeep', 'Upkeep'))}</span><br>${escHtml(o.maintenance)}</p>` : ''}
            ${o.ask ? `<div class="pro-tip" style="background:rgba(20,184,166,0.06); border-left:3px solid ${cssVar('--primary')}; padding:13px; border-radius:0 12px 12px 0; margin-top:13px;"><span class="hud-label">${escHtml(t('h.say', 'Say this at the salon'))}</span><br>${escHtml(o.ask)}</div>` : ''}
            <div class="hair-imgs" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(88px,1fr)); gap:9px; margin-top:14px;"></div>
        </div>`
        ).join('');

        box.innerHTML = `
            <div style="margin-bottom:4px;">
                <div class="hud-label">${escHtml(t('h.matches', 'Your matches'))} · ${escHtml(f.face)} ${escHtml(t('h.face', 'face'))} · ${escHtml(f.tone)}</div>
                <h3 class="brand-glow" style="margin:6px 0 0; font-size:20px;">${escHtml(t('h.pickOne', 'Which one is yours?'))}</h3>
            </div>
            ${cards}`;

        /* Referenzbilder je Vorschlag nachladen */
        const grids = box.querySelectorAll('.hair-imgs');
        await Promise.all(
            options.map(
                (o, i) => fetchHairstyleImages(
                    o.searchQuery || o.name || 'layered haircut',
                    grids[i]
                )
            )
        );
    } catch (e) {
        console.error("Hair AI error:", e);
        box.innerHTML = `<p style="color:red; text-align:center;">${escHtml(t('h.err', 'The hair stylist had a hiccup'))}: ${escHtml(e.message)}</p>`;
    }
};

/* Übersetzungs-Helfer mit Fallback (T kommt aus i18n.js). */
function t(key, fallback) {
    return (typeof T === 'function') ? T(key, fallback) : fallback;
}

async function fetchHairstyleImages(query, box) {
    if (!box) return;
    const grid = box;
    try {
        const response = await fetch('/api/search', {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "images", q: query, num: 6 })
        });
        if (!response.ok) throw new Error('Image search failed (' + response.status + ')');
        const obj = await response.json();
        if (!obj.ok) throw new Error(obj.error || 'Image search failed');
        const imgs = (obj.images || []).slice(0, 6).filter(i => i.imageUrl);
        if (imgs.length === 0) throw new Error('none');
        grid.innerHTML = imgs.map(i => `
            <a href="${safeUrl(i.imageUrl)}" target="_blank" rel="noopener" title="${escHtml(i.title || '').replace(/'/g, '&#39;')}" style="display:block; border-radius:12px; overflow:hidden; border:1px solid #222;">
                <img src="${safeUrl(i.imageUrl)}" style="width:100%; height:84px; object-fit:cover; display:block;" onerror="this.parentElement.style.display='none'">
            </a>`).join('');
    } catch (e) {
        grid.innerHTML = `<p style="color:#666; font-size:0.8rem; grid-column:1/-1;">${escHtml(t('h.refs', 'Find reference photos by searching'))} "${escHtml(query)}" ${escHtml(t('h.online', 'online'))}.</p>`;
    }
}

// Standard-Budget-Chip sichtbar vorauswählen ($30 - $100, entspricht dem Default).
// Die Skripte laufen am Seitenende, das DOM ist also schon fertig geparst.
(function () {
    const chip = document.querySelector('.budget-chip[data-default="true"]');
    if (chip) window.setBudget(100, chip);
})();

// ============================================================
//   FACE MAP  —  dein Foto + farbige Zonen, WO welches Make-up hin kommt
//   ============================================================
// Die Zonen werden auf Basis der Face-Mesh-Landmarks gezeichnet, die beim
// Scan des Kamerabildes gefunden wurden (window._lastLandmarks). Das Bild
// wird gespiegelt dargestellt (wie am Spiegel), also spiegeln wir auch den
// Canvas — so sitzen alle Zonen exakt am richtigen Ort auf dem Foto.
