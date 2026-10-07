#!/usr/bin/env python3
"""Statische Pruefungen fuer Aestra — ohne Node, ohne Installation.

Aufruf:   python3 tools/check_syntax.py
Ergebnis: eine Zeile je Pruefung (PASS/FAIL/WARN), Exit-Code 1 bei FAIL.

Was geprueft wird:
  1. JavaScript-Syntax (esprima) aller Dateien in static/
  2. i18n-Vollstaendigkeit: alle Sprachen muessen dieselben Schluessel haben
  3. Querverbindung Messkarte <-> Kennzahlen: die keys der MAP_*-Tabellen
     muessen in window.faceMetrics vorkommen (sonst fehlt still ein Label)
  4. Landmark-Indizes < 468
  5. Python-Sichtbarkeitsanalyse von app.py (finde "Name, der nirgends gebunden ist")
  6. Laufzeitprobe: _gemini_describe() darf keinen NameError werfen

Grund: Der teuerste Fehler der letzten Phase (das leere Formular) erzeugt
keine Fehlermeldung. Diese Pruefungen sollen genau diese stille Klasse
treffen, bevor jemand die App dafuer testen muss.
"""

import ast
import builtins
import glob
import os
import py_compile
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILTINS = set(dir(builtins)) | {
    "__file__", "__name__", "__package__", "__spec__", "__loader__",
    "__builtins__", "__doc__", "__cached__", "__debug__",
}
RESULTS = []


def report(status, name, detail=""):
    RESULTS.append(status)
    print(f"{status:4} {name}" + (f" — {detail}" if detail else ""))


# ---------------------------------------------------------------- 1. JS
def check_js_syntax():
    try:
        import esprima
    except ImportError:
        report("SKIP", "JavaScript-Syntax", "esprima nicht installiert")
        return {}
    files = sorted(
        glob.glob(os.path.join(ROOT, "static", "**", "*.js"), recursive=True)
        + glob.glob(os.path.join(ROOT, "tools", "*.js"))
    )
    trees, bad = {}, []
    for path in files:
        src = open(path, encoding="utf-8").read()
        try:
            trees[os.path.relpath(path, ROOT)] = esprima.parseScript(src)
        except Exception as exc:            # noqa: BLE001
            bad.append(f"{os.path.relpath(path)}: {str(exc).splitlines()[0]}")
    if bad:
        report("FAIL", "JavaScript-Syntax", "; ".join(bad))
    else:
        report("PASS", "JavaScript-Syntax", f"{len(files)} Dateien")
    return trees


# ------------------------------------------------- 2. i18n-Vollstaendigkeit
def _children(node):
    if isinstance(node, dict):
        return list(node.values())
    if isinstance(node, list):
        return [n for n in node if isinstance(n, (dict, list)) or hasattr(n, "type")]
    if hasattr(node, "__dict__"):
        return [v for v in vars(node).values()]
    return []


def _type_of(node):
    if isinstance(node, dict):
        return node.get("type")
    return getattr(node, "type", None)


def _get(node, key, default=None):
    if isinstance(node, dict):
        return node.get(key, default)
    return getattr(node, key, default)


def _walk_esprima(node):
    stack = [node]
    while stack:
        n = stack.pop()
        yield n
        stack.extend(_children(n))


def _object_keys(node):
    keys = set()
    for prop in _get(node, "properties", []) or []:
        key = _get(prop, "key", None)
        name = _get(key, "value", None) or _get(key, "name", None)
        if isinstance(name, str):
            keys.add(name)
    return keys


def check_i18n(tree_js):
    tree = tree_js.get("static/js/i18n.js")
    if tree is None:
        report("FAIL", "i18n-Vollstaendigkeit", "static/js/i18n.js nicht geparst")
        return

    # const DICTS = { en: {...}, de: {...}, ... }
    found = None
    for node in _walk_esprima(tree):
        if _type_of(node) == "VariableDeclarator" \
                and _get(_get(node, "id"), "name", "") == "DICTS":
            found = _get(node, "init")
            break
    if found is None:
        report("FAIL", "i18n-Vollstaendigkeit", "DICTS nicht gefunden")
        return

    langs = {}
    for prop in _get(found, "properties", []) or []:
        key = _get(prop, "key")
        lang = _get(key, "value") or _get(key, "name")
        if isinstance(lang, str):
            langs[lang] = _object_keys(_get(prop, "value"))
    if not langs:
        report("FAIL", "i18n-Vollstaendigkeit", "keine Sprachen gefunden")
        return

    union = set().union(*langs.values()) if langs else set()
    missing = {lang: sorted(union - keys) for lang, keys in langs.items()
               if union - keys}
    if missing:
        detail = "; ".join(
            f"{lang}: {', '.join(v[:6] + ['…'] if len(v) > 6 else v)}"
            for lang, v in missing.items())
        report("FAIL", "i18n-Vollstaendigkeit", detail)
    else:
        report("PASS", "i18n-Vollstaendigkeit",
               f"{len(langs)} Sprachen, je {len(union)} Schluessel")


# --------------------------------------- 3./4. Messkarte <-> faceMetrics
def _member_path(node):
    if node is None:
        return ""
    t = _type_of(node)
    if t == "Identifier":
        return _get(node, "name") or ""
    if t == "MemberExpression":
        prop = _get(_get(node, "property"), "name") or _get(_get(node, "property"), "value")
        base = _member_path(_get(node, "object"))
        return f"{base}.{prop}" if base else ""
    return ""


def _find_assignment(tree, target_expr):
    """Liefert den Init-Knoten von `target_expr = ...` (z.B. 'window.faceMetrics')."""
    for node in _walk_esprima(tree):
        if _type_of(node) != "AssignmentExpression" or _get(node, "operator") != "=":
            continue
        if _member_path(_get(node, "left")) == target_expr:
            return _get(node, "right")
    return None


def _props_of(obj_node):
    if obj_node is None or _get(obj_node, "properties") is None:
        return set()
    out = set()
    for prop in _get(obj_node, "properties"):
        key = _get(prop, "key", None)
        name = _get(key, "value", None) or _get(key, "name", None)
        if isinstance(name, str):
            out.add(name)
    return out





def check_map_keys(tree_js):
    tree = tree_js.get("static/js/camera.js")
    if tree is None:
        report("FAIL", "Messkarte <--> Kennzahlen", "camera.js nicht geparst")
        return

    metrics = _props_of(_find_assignment(tree, "window.faceMetrics"))

    # MAP_SEGMENTS / MAP_APERTURE / ... aus dem Quelltext lesen (einfacher
    # und robuster als der generische Baumlauf).
    src = open(os.path.join(ROOT, "static", "js", "camera.js"), encoding="utf-8").read()

    def const_array(name):
        start = src.find(f"const {name} =")
        if start < 0:
            return None
        return src[src.find("[", start): src.find("];", start) + 1]

    seg_src = const_array("MAP_SEGMENTS")
    if not seg_src:
        report("FAIL", "Messkarte <--> Kennzahlen", "MAP_SEGMENTS nicht gefunden")
        return

    keys = []
    for chunk in seg_src.split("{")[1:]:
        field = chunk.split("key:")
        if len(field) > 1:
            keys.append(field[1].split(",")[0].strip().strip("'\""))

    missing = [k for k in keys if k not in metrics]
    if missing:
        report("FAIL", "Messkarte <--> Kennzahlen",
               f"kein Eintrag in window.faceMetrics fuer: {', '.join(missing)} "
               f"(dort stehen: {', '.join(sorted(metrics))})")
    else:
        report("PASS", "Messkarte <--> Kennzahlen", f"{len(keys)} Segmente")

    # Landmark-Indizes in den MAP_*-Tabellen muessen ins FaceMesh passen.
    import re
    out_of_range = set()
    for name in ("MAP_SEGMENTS", "MAP_APERTURE", "MAP_LIP_HEIGHT",
                 "MAP_BROWS", "MAP_TONE"):
        block = const_array(name)
        if not block:
            continue
        for num in re.findall(r"\b(\d{1,3})\b", block):
            if int(num) >= 468:
                out_of_range.add(f"{name}:{num}")
    if out_of_range:
        report("FAIL", "Landmark-Bereich", ", ".join(sorted(out_of_range)))
    else:
        report("PASS", "Landmark-Bereich", "alle Indizes < 468")


# --------------------------------------------------- 5. Python-Sichtbarkeit
class Scope:
    def __init__(self, parent, kind):
        self.parent = parent
        self.kind = kind                  # 'module' | 'func' | 'class' | 'comp'
        self.binds = set()
        self.decl_global = set()


def _targets(node, scope):
    if node is None:
        return
    if isinstance(node, ast.Name):
        scope.binds.add(node.id)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for e in node.elts:
            _targets(e, scope)
    elif isinstance(node, ast.Starred):
        _targets(node.value, scope)
    elif isinstance(node, ast.Attribute):
        pass
    elif isinstance(node, ast.Subscript):
        pass


def _collect_binds(body, scope):
    """Pass 1: welche Namen bindet dieser Block? (Verschachtelte Defs: nur Name)"""
    stack = list(body) if isinstance(body, list) else [body]
    while stack:
        node = stack.pop()
        if not isinstance(node, ast.AST):
            continue
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            scope.binds.add(node.name)
            continue                      # Koerper gehoert zu einem Kind-Scope
        if isinstance(node, ast.Lambda):
            continue                      # bindet nichts aussen
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            scope.binds.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                scope.binds.add((alias.asname or alias.name).split(".")[0])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            scope.binds.add(node.name)
        elif isinstance(node, ast.Global):
            scope.decl_global.update(node.names)
        elif isinstance(node, ast.Nonlocal):
            scope.binds.update(node.names)
        for _field, val in ast.iter_fields(node):
            if isinstance(val, list):
                stack.extend(v for v in val if isinstance(v, ast.AST))
            elif isinstance(val, ast.AST):
                stack.append(val)


def _check_loads(body, scope, problems, fname):
    stack = [(body, scope)]
    while stack:
        node, sc = stack.pop()
        if isinstance(node, list):
            for n in node:
                if isinstance(n, ast.AST):
                    stack.append((n, sc))
            continue
        if not isinstance(node, ast.AST):
            continue

        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # Signatur/Dekoratoren in der Aussenwelt pruefen:
            for part in (node.decorator_list, node.args.defaults,
                         [d for d in node.args.kw_defaults if d],
                         [node.returns] if node.returns else []):
                stack.append((part, sc))
            child = Scope(sc, "func")
            for a in ast.walk(node.args):
                if isinstance(a, ast.arg) and a.arg:
                    child.binds.add(a.arg)
            _collect_binds(node.body, child)
            for d in node.decorator_list + node.args.defaults:
                _check_loads(d, sc, problems, fname)
            stack.append((node.body, child))
            continue

        if isinstance(node, ast.Lambda):
            child = Scope(sc, "func")
            for a in ast.walk(node.args):
                if isinstance(a, ast.arg) and a.arg:
                    child.binds.add(a.arg)
            stack.append((node.body, child))
            continue

        if isinstance(node, ast.ClassDef):
            for d in node.decorator_list:
                _check_loads(d, sc, problems, fname)
            child = Scope(sc, "class")
            _collect_binds(node.body, child)
            stack.append((node.body, child))
            continue

        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            # Aeusseres iterable wird in der Aussenwelt ausgewertet.
            for gen in node.generators:
                stack.append((gen.iter, sc))
            child = Scope(sc, "comp")
            for gen in node.generators:
                _collect_binds(gen.target, child)
                _check_loads(gen.iter, sc, problems, fname)
            if isinstance(node, ast.DictComp):
                stack.extend([(node.key, child), (node.value, child)])
            else:
                stack.append((node.elt, child))
            for gen in node.generators:
                _check_loads(gen.ifs, child, problems, fname)
            continue

        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            name = node.id
            probe, found = sc, False
            while probe is not None:
                if name in probe.binds or name in probe.decl_global:
                    found = True
                    break
                probe = probe.parent
            if not found and name in BUILTINS:
                found = True
            if not found:
                problems.append((fname, node.lineno, name))
            continue

        for field, val in ast.iter_fields(node):
            if isinstance(val, list):
                for item in val:
                    if isinstance(item, ast.AST):
                        stack.append((item, sc))
            elif isinstance(val, ast.AST):
                stack.append((val, sc))


def check_python_scope(path):
    try:
        tree = ast.parse(open(path, encoding="utf-8").read())
    except SyntaxError as exc:
        report("FAIL", "Python-Syntax", f"{path}: {exc}")
        return
    module = Scope(None, "module")
    _collect_binds(tree.body, module)
    # Imports auf Modulebene pruefen wir gesondert (Attribut-Zugriffe erlaubt).
    problems = []
    _check_loads(tree.body, module, problems, os.path.relpath(path, ROOT))
    if problems:
        shown = "; ".join(f"{f}:{ln} → {name}" for f, ln, name in problems[:5])
        more = f" (+{len(problems) - 5} mehr)" if len(problems) > 5 else ""
        report("FAIL", "Python-Sichtbarkeit", shown + more)
    else:
        report("PASS", "Python-Sichtbarkeit", os.path.relpath(path, ROOT))


# -------------------------------------------------- 6. Laufzeit: Beschreibung
def _find_line(path, needle, after=None):
    """Erste Zeile mit `needle`, ab der Zeile in der `after` gefunden wird."""
    seen_after = after is None
    for no, text in enumerate(open(path, encoding="utf-8"), 1):
        if not seen_after:
            if after in text:
                seen_after = True
            continue
        if needle in text:
            return no
    return "?"


def check_describe_runtime():
    sys.path.insert(0, ROOT)
    try:
        import app as app_module
    except Exception as exc:               # noqa: BLE001
        report("SKIP", "describe-clothing (Laufzeit)", f"app.py nicht importierbar: {exc}")
        return
    app_module._downscale_jpeg = lambda url: {"mime_type": "image/jpeg", "data": "AA"}
    app_module._gemini_call = lambda *a, **k: ('{"type":"tee","color":"blue"}', "stub")
    try:
        out = app_module._gemini_describe("data:image/jpeg;base64,AA", "Tee")
        if isinstance(out, dict) and out.get("type"):
            report("PASS", "describe-clothing (Laufzeit)", "liefert JSON zurueck")
        else:
            report("FAIL", "describe-clothing (Laufzeit)", f"unerwartetes Ergebnis: {out!r}")
    except Exception as exc:               # noqa: BLE001
        line = _find_line(os.path.join(ROOT, "app.py"), "resp.json(",
                          after="def _gemini_describe")
        report("FAIL", "describe-clothing (Laufzeit)",
               f"{type(exc).__name__}: {exc} (app.py:{line})")


def check_compile(path):
    try:
        py_compile.compile(path, doraise=True)
        report("PASS", "Python-Compile", os.path.relpath(path, ROOT))
    except py_compile.PyCompileError as exc:
        report("FAIL", "Python-Compile", str(exc))


def main():
    trees = check_js_syntax()
    if trees:
        check_i18n(trees)
        check_map_keys(trees)
    app_path = os.path.join(ROOT, "app.py")
    check_compile(app_path)
    check_python_scope(app_path)
    check_describe_runtime()

    failed = RESULTS.count("FAIL")
    print(f"\n{len(RESULTS)} Pruefungen: {RESULTS.count('PASS')} PASS, "
          f"{failed} FAIL, {RESULTS.count('WARN')} WARN, "
          f"{RESULTS.count('SKIP')} SKIP")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
