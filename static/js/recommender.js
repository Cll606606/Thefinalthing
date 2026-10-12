/* ============================================================
   AESTRA EIGENES EMPFEHLUNGSMODELL  (recommender.js)

   Ein lineares Präferenzmodell mit Online-Lernen — der Teil von
   Aestra, der NICHT ein vortrainiertes Drittmodell ist:

     Merkmalsvektor   phi(item, ctx)   je Kleidungsstück (+0/+1)
     Basisbewertung   prior(item, ctx) deterministische Regeln
     Lerngewichte     w[f]             Offsets, aus Feedback gelernt
     Gesamtscore      s = prior + w · phi

   Training:  logistischer Gradientenabstieg je Feedback
              (Daumen hoch/runter auf den vorgeschlagenen Look).
   Inferenz:  Rangliste über den eigenen Bestand, der Look wird
              aus den Top-Teilen kategorien-divers zusammengesetzt.

   Die Gewichte werden pro Konto auf dem Server abgelegt
   (/api/reco/prefs); ohne Login bleiben sie lokal im Browser.
   ============================================================ */

(function () {
    'use strict';

    var VERSION = 1;
    var LR = 0.15;            // Lernrate des logistischen Updates
    var WEIGHT_CLIP = 5;      // Gewichte hart begrenzen (kein Drift)
    var PRUNE_ABS = 1e-3;     // unsichtbare Features beim Speichern streichen
    var MAX_ITEMS_LOOK = 4;   // Größe eines zusammengesetzten Looks

    var CATEGORIES = [
        'Tops', 'Bottoms', 'Dresses', 'Outerwear', 'Shoes',
        'Bags & Accessories', 'Activewear', 'Loungewear', 'Swimwear'
    ];

    /* Farbgruppen: der erste Treffer in Name/Beschreibung zählt. */
    var COLOR_TABLE = [
        { id: 'black', words: ['black', 'schwarz'] },
        { id: 'white', words: ['white', 'weiss', 'weiß', 'cream', 'ivory'] },
        { id: 'gray', words: ['gray', 'grey', 'grau'] },
        { id: 'navy', words: ['navy', 'dark blue'] },
        { id: 'blue', words: ['blue', 'blau', 'denim'] },
        { id: 'brown', words: ['brown', 'braun', 'tan', 'beige', 'camel'] },
        { id: 'green', words: ['green', 'grün', 'gruen', 'olive'] },
        { id: 'red', words: ['red', 'rot', 'burgundy', 'bordeaux'] },
        { id: 'pink', words: ['pink', 'rosa'] },
        { id: 'yellow', words: ['yellow', 'gelb'] },
        { id: 'purple', words: ['purple', 'violett', 'lila', 'plum'] },
        { id: 'orange', words: ['orange'] }
    ];

    function _words(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9äöüß\s-]/gi, ' ')
            .split(/\s+/)
            .filter(function (w) { return w.length > 2; });
    }

    function _itemText(item) {
        return [item.name, item.desc, item.tags].join(' ');
    }

    function _color(item) {
        var text = _itemText(item).toLowerCase();
        for (var i = 0; i < COLOR_TABLE.length; i++) {
            var c = COLOR_TABLE[i];
            for (var j = 0; j < c.words.length; j++) {
                if (text.indexOf(c.words[j]) >= 0) return c.id;
            }
        }
        return 'neutral';
    }

    /* Harte Wetterfilter: unpassende Kategorien gar nicht vorschlagen. */
    function _weatherOK(cat, tempC) {
        if (tempC == null) return true;
        if (tempC >= 28 && cat === 'Outerwear') return false;
        if (tempC <= 10 && cat === 'Swimwear') return false;
        return true;
    }

    /* Basisbewertung: dokumentierte Regeln (Wetter, Anlass, Jahreszeit).
       Das ist bewusst KEIN gelerntes Modell, sondern die Start-Heuristik. */
    function _prior(item, ctx) {
        var s = 0;
        var cat = item.cat || '';
        var text = _itemText(item).toLowerCase();
        var tempC = ctx.tempC;

        if (tempC != null) {
            if (tempC >= 25) {
                if (['Tops', 'Dresses', 'Bottoms', 'Shoes', 'Swimwear'].indexOf(cat) >= 0) s += 1.2;
            } else if (tempC >= 15) {
                if (['Tops', 'Bottoms', 'Dresses', 'Shoes'].indexOf(cat) >= 0) s += 0.9;
            } else if (tempC >= 8) {
                if (['Tops', 'Bottoms', 'Outerwear', 'Shoes'].indexOf(cat) >= 0) s += 0.7;
            } else {
                if (['Outerwear', 'Bottoms', 'Tops', 'Shoes'].indexOf(cat) >= 0) s += 0.8;
            }
        }

        if (ctx.occasion) {
            var occWords = ctx.occasion.toLowerCase().split(/[\s.,:;!?/_+&()\-]+/).filter(function (w) {
                return w.length > 2;
            });
            for (var i = 0; i < occWords.length; i++) {
                if (text.indexOf(occWords[i]) >= 0) s += 0.5;
            }
        }

        if (ctx.season) {
            var map = {
                hot: ['Swimwear', 'Dresses', 'Tops', 'Bottoms', 'Shoes'],
                mild: ['Tops', 'Bottoms', 'Dresses', 'Outerwear', 'Shoes'],
                cold: ['Outerwear', 'Bottoms', 'Tops', 'Shoes', 'Loungewear']
            };
            if ((map[ctx.season] || []).indexOf(cat) >= 0) s += 0.6;
        }

        return s;
    }

    /* Merkmalsvektor phi(item, ctx): kategoriale Merkmale + Textwörter.
       "cat:Outerwear" ist genau die One-Hot-Darstellung der Kategorien. */
    function _features(item, ctx) {
        var f = {};
        var cat = item.cat || 'unknown';
        f['cat:' + cat] = 1;
        f['col:' + _color(item)] = 1;

        var text = _itemText(item);
        var words = _words(text);
        var added = 0;
        for (var i = 0; i < words.length && added < 8; i++) {
            var key = 'kw:' + words[i];
            if (!(key in f)) { f[key] = 1; added++; }
        }

        if (ctx && ctx.occasion) {
            var ow = _words(ctx.occasion);
            var tl = text.toLowerCase();
            for (var j = 0; j < ow.length; j++) {
                if (tl.indexOf(ow[j]) >= 0) { f['occ:' + ow[j]] = 1; break; }
            }
        }
        return f;
    }

    function _emptyModel() {
        return { weights: {}, meta: { version: VERSION, updates: 0, lastAt: 0 } };
    }

    function _cloneModel(m) {
        return {
            weights: Object.assign({}, (m && m.weights) || {}),
            meta: Object.assign({}, _emptyModel().meta, (m && m.meta) || {})
        };
    }

    function _score(m, item, ctx) {
        var s = _prior(item, ctx);
        var phi = _features(item, ctx);
        for (var key in phi) {
            if (m.weights[key]) s += m.weights[key];
        }
        return s;
    }

    /* Logistisches Update:  w <- w + eta * y * phi * sigmoid(-y*s) */
    function _learn(m, items, ctx, y) {
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var phi = _features(item, ctx);
            var s = _score(m, item, ctx);
            var cost = y * s;
            var sig = 1 / (1 + Math.exp(-cost));
            var g = LR * y * (1 - sig);
            for (var key in phi) {
                var nw = (m.weights[key] || 0) + g;
                if (nw > WEIGHT_CLIP) nw = WEIGHT_CLIP;
                if (nw < -WEIGHT_CLIP) nw = -WEIGHT_CLIP;
                m.weights[key] = nw;
            }
        }
        m.meta.updates = (m.meta.updates || 0) + 1;
        m.meta.lastAt = Date.now();
        return m;
    }

    function _prune(m) {
        var out = {};
        for (var k in m.weights) {
            if (Math.abs(m.weights[k]) >= PRUNE_ABS) out[k] = +m.weights[k].toFixed(4);
        }
        m.weights = out;
    }

    /* ---- Persistenz: Server pro Konto, sonst localStorage ---- */
    function _localKey() { return 'aestra_reco_model_v' + VERSION; }

    var _cached = null;
    var _saveTimer = null;

    function getModel() {
        return _cached ? _cloneModel(_cached) : _emptyModel();
    }

    function _saveLocal(m) {
        try { localStorage.setItem(_localKey(), JSON.stringify(m)); } catch (e) { /* Quota */ }
    }

    function _persist(m) {
        _saveLocal(m);
        if (!window.loggedIn) return;
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(function () {
            fetch('/api/reco/prefs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: m })
            }).catch(function () { /* offline ok, beim nächsten Mal wieder */ });
        }, 250);
    }

    /* Lädt das Modell einmal am Anfang: Server gewinnt, sonst lokal. */
    function ensureModel() {
        if (_cached) return Promise.resolve(_cached);
        var m = null;
        try {
            var raw = localStorage.getItem(_localKey());
            if (raw) m = JSON.parse(raw);
        } catch (e) { m = null; }
        if (m && m.meta && m.meta.version === VERSION) _cached = _cloneModel(m);

        if (window.loggedIn) {
            return fetch('/api/reco/prefs', { headers: { 'Accept': 'application/json' } })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (data && data.ok && data.model && data.model.meta &&
                        data.model.meta.version === VERSION) {
                        _cached = _cloneModel(data.model);
                        _saveLocal(_cached);
                    } else if (data && data.ok && !data.model && _cached) {
                        // Server leer: lokales Modell einmalig hochladen.
                        _persist(_cached);
                    }
                    if (!_cached) _cached = _emptyModel();
                    return _cached;
                })
                .catch(function () {
                    if (!_cached) _cached = _emptyModel();
                    return _cached;
                });
        }
        if (!_cached) _cached = _emptyModel();
        return Promise.resolve(_cached);
    }

    /* Feedback eines Likes/Dislikes in das Modell einlernen. */
    function applyFeedback(model, items, ctx, liked) {
        var m = _cloneModel(model);
        _learn(m, items, ctx, liked ? 1 : -1);
        _prune(m);
        _cached = m;
        _persist(m);
        return m;
    }

    function seasonOf(tempC) {
        if (tempC == null) return 'mild';
        if (tempC >= 25) return 'hot';
        if (tempC >= 10) return 'mild';
        return 'cold';
    }

    /* Inferenz: Rangliste des eigenen Bestands für einen Kontext. */
    function rank(wardrobe, ctx) {
        var model = _cached || _emptyModel();
        var list = (wardrobe || []).filter(function (i) {
            return i && i.name && (i.cat || i.desc);
        });
        var scored = list.map(function (i) {
            return { item: i, score: _score(model, i, ctx) };
        });
        scored.sort(function (a, b) { return b.score - a.score; });
        return scored;
    }

    /* Baut aus der Rangliste einen Look: eine Kategorie pro Teilstück,
       Wetterfilter vorher; wenn zu wenig übrig bleibt, alle nehmen. */
    function buildLook(wardrobe, ctx) {
        var ranked = rank(wardrobe, ctx);
        var usable = ranked.filter(function (r) {
            return _weatherOK(r.item.cat, ctx.tempC);
        });
        var pool = usable.length >= 2 ? usable : ranked;
        var chosen = [];
        var usedCats = {};
        for (var i = 0; i < pool.length; i++) {
            if (chosen.length >= MAX_ITEMS_LOOK) break;
            var cat = pool[i].item.cat || '';
            if (cat && usedCats[cat]) continue;
            if (cat) usedCats[cat] = true;
            chosen.push(pool[i].item);
        }
        return { chosen: chosen, ranked: ranked };
    }

    /* Lückenanalyse für den Shopping-Modus: NUR fehlende Basics nennen.
       Das ersetzt das frühere "immer genau 4 kaufen". */
    function missingBasics(wardrobe, ctx) {
        var have = {};
        (wardrobe || []).forEach(function (i) {
            if (i && i.cat) have[i.cat] = true;
        });
        var req = ['Tops', 'Bottoms', 'Shoes'];
        if (ctx.tempC != null && ctx.tempC <= 14) req.push('Outerwear');
        var labels = {
            Tops: (ctx.tempC != null && ctx.tempC <= 12)
                ? 'warm knit top or long-sleeve tee'
                : 'light top or t-shirt',
            Bottoms: (ctx.tempC != null && ctx.tempC <= 12)
                ? 'warm trousers or jeans'
                : 'light trousers or shorts',
            Outerwear: 'jacket or coat for cold weather',
            Shoes: (ctx.tempC != null && ctx.tempC <= 12)
                ? 'closed shoes or boots'
                : 'light shoes or sneakers'
        };
        var missing = [];
        for (var i = 0; i < req.length; i++) {
            if (!have[req[i]]) missing.push({ cat: req[i], label: labels[req[i]] });
        }
        return missing;
    }

    window.AestraReco = {
        VERSION: VERSION,
        getModel: getModel,
        ensureModel: ensureModel,
        applyFeedback: applyFeedback,
        rank: rank,
        buildLook: buildLook,
        missingBasics: missingBasics,
        seasonOf: seasonOf,
        weatherOK: _weatherOK,
        features: _features
    };
})();