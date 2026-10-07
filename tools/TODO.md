# Review + ToDo — aktueller Stand (uncommitteter Diff)

Stand: Diff über 6 Dateien (`app.py`, `camera.js`, `ai-logic.js`, `i18n.js`,
`beauty.html`, `style.css`) + neu `templates/webllm-test.html`.
Zuletter Commit: `6a11b2f` (05.10.2026) — alles danach ist noch nicht committet.

Prüfungen laufen mit:

```sh
./tools/run_checks.sh      # 7 statisch + 17 Browser + 1 CDN, Exit 0 = gruen
```

`check_syntax.py` (statisch, ohne Browser): JS-Syntax per esprima, i18n-Parität
en/de/es/fr, Messkarte↔Kennzahlen, Landmark-Indizes < 468, Python-Compile,
Python-Sichtbarkeit, Laufzeit-Stub für `_gemini_describe`.
`check_browser.html` (echtes Headless-Chrome): lädt die echten
`i18n.js` + `camera.js` + `ai-logic.js`, spielt 468 synthetische Landmarks mit
bekannter Geometrie in `handleResults()` ein und prüft daraus Kennzahlen,
Zeichnung, Verlauf, Sprachregel, Umfangs-Regel und Chips.

---

## Erledigt (im laufenden Diff gefunden und inzwischen gefixt)

| # | Fundstelle | Status |
|---|---|---|
| 1 | `_gemini_describe` nutzte `resp.json(...)`, `resp` existierte nicht → `NameError` bei **jedem** Kleider-Upload (`app.py` alte Zeile 1145) | gefixt (`_gemini_call` liefert den Text; Kommentar im Code) |
| 2 | `MAP_SEGMENTS`-Key `chin` fehlte in `window.faceMetrics` (dort `chinWidth`) → stummes Label | gefixt (`camera.js:101`) |
| 3 | `aiLangRule()` las `window.currentLang` (existiert nie) → „Like the app" fiel immer auf Englisch | gefixt: liest jetzt `window.I18N.lang` / `document.documentElement.lang` (`ai-logic.js:60`) |
| 4 | Auto-Chip ohne `onclick` → Auswahl wirkte nicht | gefixt: `loadAiModels()` setzt `onclick` und ruft danach `I18N.apply()`; `refreshToggleLabels` hält Guide-/Messkarten-Text beim Sprachwechsel aktuell |
| 5 | Modellwahl landete nie beim Server | gefixt: `serverJson` schickt `model: window.aiModel`, Server prüft gegen `GEMINI_MODELS` (`_model_order`), Antwort enthält `model` (`window.aiModelUsed`) |

## Landmark-Ebene (neu: Gesicht wirklich sichtbar machen)

Zuvor sah man nur die statischen Hilfslinien — ein gedrucktes Oval, das
nichts mit dem Gesicht zu tun hat. Jetzt zeichnet `camera.js` das, was
MediaPipe wirklich liefert:

| Baustein | Stelle |
|---|---|
| 468 Punkte + Masche (2528 Kanten) + Konturen + Irisringe | `drawLandmarkDots()` (camera.js, nach `MAP_USED`) |
| Punkte standardmäßig an, Schalter `toggleLandmarks()` | `window.showLandmarks`, Button in `beauty.html` |
| Status-Punkt im Bild (`FACE · 468 POINTS` / `SEARCHING …`) | `setDetectBadge()`, `#detect-badge` |
| Gespiegelte Vorschau (`mapX`) — sonst lägen die Punkte seitenverkehrt | `window.mirrorPreview = true` |
| `object-fit:cover` des Videos nachgebildet (`overlayTransform`) — sonst bis zu 100 px daneben | `renderOverlay()` |
| Punkte nur bei frischem Frame (700 ms), Standbild dauerhaft | `renderOverlay()` |
| Hochgeladenes Foto wird im Rahmen gezeigt statt eingefrorenem Video | `showPhotoPreview()`, `#photo-preview` |
| Iris-Erkennung an (`refineLandmarks`, Punkte 468–477) | `initMediaPipe()` |

Der Schalter liegt zwischen Guide und Messkarte; der Sprachwechsel hält
ihn über `refreshToggleLabels()` aktuell (beauty.html).

**Neue Checks:** `overlayTransform`, gespiegelte statt rohe Punktelage
(Pixelvergleich im 300×400-Rahmen bei 640×480-Bild), Status-Punkt frisch
vs. veraltet, Schalter an/aus ohne bzw. mit Punkten, Foto-Modus ohne
frischen Frame, plus `check_mediapipe_cdn.py` (echte `FACEMESH_*`-Listen
als Globale, Indizes < 468).

## Offene Punkte (niedrige Priorität, nichts davon blockiert)

1. **`const history = {...}` in `camera.js:795` shadowt `window.history` global.**
   Jedes künftige bare `history.pushState()` / `history.back()` auf der Seite wirft
   `history.pushState is not a function`. Aktuell betroffen: nichts (App nutzt keine
   History-API, MediaPipe-CDN auch nicht) — deshalb grün, aber als Fundstelle
   gefährlich. Sauber wäre `measHistory` (plus `VALID_HISTORY`/`pushSample`/`drawTrend`
   anpassen). **Empfehlung: vor dem nächsten Feature umbenennen.**
2. **`templates/wardrobe.html:772 describeClothing()` schickt kein `model`.**
   Der Server akzeptiert es (`app.py:1304`) und validiert es, der Client ignoriert
   die Modellwahl → Kleiderbeschreibungen laufen immer auf „auto". Entweder
   `window.aiModel` mit senden oder als bewusste Entscheidung kommentieren.
3. **Statischer Auto-Chip in `beauty.html` (~Zeile 216) hat kein `onclick`** —
   anders als die von `loadAiModels()` eingefügte Variante. Greift nur, wenn
   `/api/ai-models` nicht liefert (kein Login), dann ist Auto aber auch die einzige
   Option. Kosmetisch; `onclick="setAiModel('auto', this)"` ergänzen wäre konsistent.
4. **Neue i18n-Schlüssel `b.ai*` in `i18n.js` ohne Einrückung** eingefügt
   (Zeilen ~120/339/558/781) — reine Optik, Parität ist geprüft und korrekt.
5. **Chrome beendet sich nach `--dump-dom` nicht von selbst** (Endlosschleifen aus
   `guideLoop`/`trendLoop` halten den Prozess wach). `run_checks.sh` fängt das mit
   `perl alarm 45` ab; `check_browser.html` hält die rAF-Loops vorher an. Läuft es
   ohne Alarm leer, ist der `alarm`-Wrap entbehrlich.

## Regeln, die beim nächsten Durchgang gelten

- Kein Node/npm im Projekt — Tests bleiben bei `python3` + Chrome.
- Jede neue Messstrecke (`MAP_SEGMENTS`, `VALID_HISTORY`, `TREND_SERIES`) braucht
  einen passenden Key in `window.faceMetrics`; `check_syntax.py` schlägt sonst an.
- Landmark-Indizes bleiben < 468 (`check_syntax.py`); Iris-Punkte 468–477
  nur über `refineLandmarks`.
- Beim Zeichnen auf Landmarks: x über `mapX()` (Vorschaubild ist
  gespiegelt), Koordinaten in BILD-Pixeln durch `overlayTransform()` —
  nicht `canvas.width`.
- Sprachregel und Schrittzahl kommen aus `aiLangRule()`/`aiModeCfg()` — nicht
  hartkodiert in den Prompt (`ai-logic.js:350`).
