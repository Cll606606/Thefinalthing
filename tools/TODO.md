# Review + ToDo — aktueller Stand (uncommitteter Diff)

Stand: Diff über 6 Dateien (`app.py`, `camera.js`, `ai-logic.js`, `i18n.js`,
`beauty.html`, `style.css`) + neu `templates/webllm-test.html`.
Zuletter Commit: `6a11b2f` (05.10.2026) — alles danach ist noch nicht committet.

Prüfungen laufen mit:

```sh
./tools/run_checks.sh      # 7 statisch + 20 Browser + 1 CDN + 3 E2E, Exit 0 = gruen
```

`check_syntax.py` (statisch, ohne Browser): JS-Syntax per esprima, i18n-Parität
en/de/es/fr, Messkarte↔Kennzahlen, Landmark-Indizes < 468, Python-Compile,
Python-Sichtbarkeit, Laufzeit-Stub für `_gemini_describe`.
`check_browser.html` (echtes Headless-Chrome): lädt die echten
`i18n.js` + `camera.js` + `ai-logic.js`, spielt 468 synthetische Landmarks mit
bekannter Geometrie in `handleResults()` ein und prüft daraus Kennzahlen,
Zeichnung, Verlauf, Sprachregel, Umfangs-Regel, Chips und die Frame-Diagnose
(Gnadenfrist, Warnung mit echter Ursache, Zurücksetzen nach Erfolg).
`check_e2e.html` (Schritt 4, braucht Netz): echtes CDN + echtes Gesichtsfoto →
468 Punkte, Status-Punkt, gezeichnete Pixel. Das Ergebnis kommt per POST über
`check_server.py` an, nicht über `--dump-dom`.

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
| Status-Punkt im Bild (`FACE · 468 POINTS` / `SEARCHING …` / `NO RESULTS – RELOAD PAGE`) | `setDetectBadge()`, `#detect-badge` |
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
6. **Gelöst: warum beim Nutzer Status-Punkt und Punkte komplett fehlten.**
   Zwei Lücken haben den Fehlerfall unsichtbar gemacht:
   (a) `guideLoop()` rendert im Foto-Modus nur bei neuem `_landmarksAt` und im
   Live-Modus nur bei `video.videoWidth > 0`. Ohne Rücklauf kam `renderOverlay()`
   nie an → `#detect-badge` behielt den statischen HTML-Text `SEARCHING FOR A
   FACE…` (beauty.html, immer englisch) und die Punkte fehlten komplett.
   (b) Die 60-Frames-Warnung greift nur, wenn `send()` einen Fehler **wirft**
   (`frameStreamFailed`). Hängt das Promise (WASM-Absturz / doppeltes `send()`),
   gibt es **keinen** Hinweis — genau der Fall „Badge und Punkte weg, aber keine
   Meldung".
   **Fix:** `window._resultsAt` (Rücklauf in `handleResults`), 
   `window._photoScanAt` (Scanstart), `detectStalled()` + dritter Badge-Zustand
   `stalled` (Key `beauty.detectStalled` in 4 Sprachen, CSS `.stalled`,
   `window._stalled`, `console.error` beim Übergang). `guideLoop()` rendert im
   Fehlerfall mindestens 1× pro Sekunde (`renderStalledOnce()`), auch ohne
   Videogröße. Schwelle: `MP_STALL_MS` (10 s, per `window.MP_STALL_MS`
   überschreibbar), Start/Modell-Download laufen über die bestehende
   `MP_GRACE_MS`. Geprüft in `check_browser.html` („Status-Punkt: frisch vs.
   veraltet" erweitert).

## Fehlerbild „60 camera frames could not be processed" (eingeengt)

Ursache des Nutzer-Screenshots: `faceMesh.send()` schlägt 60× hintereinander
fehl. Zwei nachgewiesene Auslöser:

1. **Zwei parallele `send()`** stürzen das WASM-Modul ab mit
   `Module.arguments has been replaced with plain arguments_`
   (Einzelbeleg: `mptest/t5.html`). Deshalb gibt
   `useUploadedPhoto()` jetzt sein `send()`-Promise zurück — wer nachsendet,
   muss vorher awaiten. Empfänger: `check_e2e.html`, ggf. `analyse.js`.
2. **Ad-Blocker/Netz blockiert `cdn.jsdelivr.net`** — `frameStreamFailed()`
   nennt nach der Gnadenfrist die echte Fehlermeldung, `probeMediaPipeAssets()`
   hängt blockierte Dateien an `#mediapipe-note-detail`.

Neu in `camera.js` (Frame-Diagnose): `MP_GRACE_MS`/`MP_FAIL_LIMIT`/
`MP_OK_CLEAR` (per `window.*` überschreibbar), `mpResetFrameStats()`,
`window.__mpExpireGrace()` als Test-Hook, `frameStreamOk()`/
`frameStreamFailed()`, `probeMediaPipeAssets()`, `mediaPipeClear()` blendet
nur Warnungen der Quelle `frames` wieder aus.

**Dritter Zustand, nicht in der Warnung abgedeckt: `send()` hängt.** Wenn das
Promise nie zurückkehrt (WebGL tot, Modul blockiert), wirft nichts, `mpFailStreak`
bleibt 0 — die 60-Frames-Meldung kommt nie, die Oberfläche bleibt einfach leer.
Erkennung über `detectStalled()`/`MP_STALL_MS` → roter Badge
`beauty.detectStalled` + `window._stalled` + `console.error` (siehe offener
Punkt 6, jetzt gelöst).

E2E-Fallstricke, die bereits wehgetan haben — bitte nicht rückbauen:

- **Kein `--disable-gpu`** beim E2E-Schritt: ohne WebGL hängt `send()`
  ewig, es kommt nie ein Ergebnis (nur `Created TensorFlow Lite XNNPACK
  delegate` im Log, dann Stille).
- **Kein `document.write` der CDN-Tags**: lädt das WASM-Modell doppelt und
  endet in `Module.arguments has been replaced`.
- **Kein zweites `new FaceMesh(...)`** auf einer Seite.
- **Kein `--dump-dom`** für die E2E-Seite: Chrome dumpt beim Laden, bevor
  das Modell fertig ist. Stattdessen POST → `tools/.e2e-result.txt`
  (Anhänge, weil LOG-Zeilen das Ergebnis sonst überschreiben).
- **Kein automatischer Kamerastart** im Check: `window.AESTRA_NO_AUTO_CAMERA`
  (gesetzt in `check_e2e.html`), sonst läuft der Videostream nie zu Ende.
- `tools/face-fixture.png` (Screenshot eines Nutzers, seit `7987bb7` im Repo)
  bleibt bewusst als E2E-Fixture liegen — Repo ist privat, das Bild liefert den
  468-Punkte-Beweis. Ohne ihn meldet der Foto-Test sauber `uebersprungen`,
  der Lauf bleibt grün.
- Läuft der E2E-Test mit falschem Port oder hängendem Server, meldet
  `run_checks.sh` `FAIL E2E-Check | kein Ergebnis vom Browser`.

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
- `send()` nie parallel aufrufen, immer awaiten; `useUploadedPhoto()` gibt
  das Promise zurück.
