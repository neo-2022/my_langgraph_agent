#!/usr/bin/env python3
# scripts/verify_integrity.py
# Проверка инвариантов репозитория (минимальный "gate"):
# - ключевые якоря в документах (Debugger Level 0 / чеклист)
# - Level 0 реально инициализируется в ui/src/main.jsx до React render
# - в git нет мусора типа __pycache__/ *.pyc в отслеживаемых файлах
#
# Запуск:
#   python3 scripts/verify_integrity.py

from __future__ import annotations
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def read(p: str) -> str:
    return (ROOT / p).read_text(encoding="utf-8")


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def ok(msg: str) -> None:
    print(f"OK: {msg}")


def git(*args: str) -> str:
    r = subprocess.run(["git", *args], cwd=str(ROOT), text=True, capture_output=True)
    if r.returncode != 0:
        fail(f"git {' '.join(args)}: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout


def require_contains(text: str, needle: str, where: str) -> None:
    if needle not in text:
        fail(f"{where}: missing required text: {needle!r}")


def require_regex(text: str, pattern: str, where: str) -> None:
    if not re.search(pattern, text, flags=re.M | re.S):
        fail(f"{where}: missing required pattern: {pattern!r}")


def main() -> None:
    # --- 1) Docs anchors ---
    checklist = read("CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md")
    require_contains(checklist, "#### 1.0.1 Цель и принцип", "CHECKLIST")
    require_contains(checklist, "Bootstrap Debugger (до React)", "CHECKLIST")
    require_contains(checklist, "#### 1.0.9 Сквозной Debugger", "CHECKLIST")
    require_contains(checklist, "DebugEvent", "CHECKLIST")
    require_contains(checklist, "debug_ref", "CHECKLIST")

    # Спека переехала в ui/src/debugger/README.md
    spec_path = "ui/src/debugger/README.md"
    spec = read(spec_path)
    require_contains(spec, "## 0.1) Bootstrap Layer (Level 0)", spec_path)
    require_contains(spec, "Точка интеграции в этом репозитории", spec_path)
    require_contains(spec, "ui/src/main.jsx", spec_path)

    ok("docs anchors present")

    # --- 2) Level 0 before render in ui/src/main.jsx ---
    main_js = read("ui/src/main.jsx")

    # must import initDebuggerLevel0 from ./debugger/level0.js
    require_regex(
        main_js,
        r'import\s+\{\s*initDebuggerLevel0\s*\}\s+from\s+"\.\/debugger\/level0\.js"\s*;',
        "ui/src/main.jsx",
    )

    # must call init before createRoot(...).render
    pos_init = main_js.find("initDebuggerLevel0();")
    if pos_init < 0:
        fail("ui/src/main.jsx: missing initDebuggerLevel0(); call")

    m = re.search(
        r'createRoot\(\s*document\.getElementById\("root"\)\s*\)\.render\(',
        main_js,
    )
    if not m:
        fail('ui/src/main.jsx: missing createRoot(document.getElementById("root")).render(')

    pos_render = m.start()
    if not (pos_init < pos_render):
        fail("ui/src/main.jsx: initDebuggerLevel0() is NOT before React render (violates Level 0 requirement)")

    ok("Level 0 init is before React render")

    # --- 3) No tracked pycache/pyc ---
    tracked = git("ls-files")
    bad = []
    for line in tracked.splitlines():
        if "__pycache__/" in line or line.endswith(".pyc"):
            bad.append(line)
    if bad:
        fail("tracked python cache files found:\n" + "\n".join(bad))
    ok("no tracked __pycache__/pyc")

    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
