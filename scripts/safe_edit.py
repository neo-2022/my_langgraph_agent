#!/usr/bin/env python3
# scripts/safe_edit.py
# Универсальный безопасный редактор текстовых файлов:
# - строгая проверка expected_delta (изменение количества строк)
# - проверка инвариантов/маркеров/кол-ва вхождений
# - файл перезаписывается только если все проверки прошли
#
# Использование (пример):
#   from scripts.safe_edit import SafeEdit
#   ed = SafeEdit("ui/src/App.jsx")
#   ed.require_once("export default function App()", "App() must exist")
#   ed.insert_after_once("const [x, setX] = useState(0);\n", "  const [y, setY] = useState(false);\n")
#   ed.assert_expected_delta()
#   ed.write()

from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import re
import tempfile

def _nlines(s: str) -> int:
    # Кол-во строк по splitlines (как wc -l для текста без финальной \n чуть отличается),
    # поэтому нормализуем: считаем по \n.
    if s == "":
        return 0
    # Если файл заканчивается \n, то число строк = count("\n")
    # Иначе = count("\n")+1
    return s.count("\n") if s.endswith("\n") else s.count("\n") + 1

@dataclass
class Change:
    kind: str
    removed: str
    added: str
    note: str = ""

class SafeEdit:
    def __init__(self, path: str, encoding: str = "utf-8") -> None:
        self.path = Path(path)
        self.encoding = encoding
        self.orig = self.path.read_text(encoding=self.encoding)
        self.text = self.orig
        self.changes: list[Change] = []
        self._require_checks: list[tuple[str, str, int | None]] = []  # (needle_or_regex, msg, mode)
        # mode: None=contains, 1=once substring, 2=once regex match

    # ---------- требования/инварианты ----------
    def require_contains(self, needle: str, msg: str) -> None:
        if needle not in self.text:
            raise SystemExit(msg)

    def require_once(self, needle: str, msg: str) -> None:
        c = self.text.count(needle)
        if c != 1:
            raise SystemExit(f"{msg} (expected 1, got {c})")

    def require_regex(self, pattern: str, msg: str) -> None:
        if not re.search(pattern, self.text, re.M):
            raise SystemExit(msg)

    def require_regex_once(self, pattern: str, msg: str) -> None:
        ms = list(re.finditer(pattern, self.text, re.M | re.S))
        if len(ms) != 1:
            raise SystemExit(f"{msg} (expected 1, got {len(ms)})")

    # ---------- операции изменения текста (строго 1 место) ----------
    def insert_after_once(self, marker: str, ins: str, note: str = "") -> None:
        self.require_once(marker, f"marker not unique for insert_after_once: {marker!r}")
        before = self.text
        self.text = self.text.replace(marker, marker + ins)
        self.changes.append(Change("insert_after", removed="", added=ins, note=note))

    def insert_before_once(self, marker: str, ins: str, note: str = "") -> None:
        self.require_once(marker, f"marker not unique for insert_before_once: {marker!r}")
        before = self.text
        self.text = self.text.replace(marker, ins + marker)
        self.changes.append(Change("insert_before", removed="", added=ins, note=note))

    def replace_once(self, old: str, new: str, note: str = "") -> None:
        self.require_once(old, f"old text not unique for replace_once: {old!r}")
        self.text = self.text.replace(old, new)
        self.changes.append(Change("replace", removed=old, added=new, note=note))

    def regex_sub_once(self, pattern: str, repl: str, note: str = "") -> None:
        ms = list(re.finditer(pattern, self.text, re.M | re.S))
        if len(ms) != 1:
            raise SystemExit(f"regex_sub_once expects 1 match, got {len(ms)} for pattern: {pattern!r}")
        removed = ms[0].group(0)
        self.text = re.sub(pattern, repl, self.text, count=1, flags=re.M | re.S)
        self.changes.append(Change("regex_sub", removed=removed, added=repl, note=note))

    # ---------- строгая проверка expected_delta ----------
    def expected_delta_lines(self) -> int:
        # Считаем суммарную дельту по изменениям: (added_lines - removed_lines)
        # Для insert_before/after removed = "".
        delta = 0
        for ch in self.changes:
            delta += _nlines(ch.added) - _nlines(ch.removed)
        return delta

    def actual_delta_lines(self) -> int:
        return _nlines(self.text) - _nlines(self.orig)

    def assert_expected_delta(self) -> None:
        exp = self.expected_delta_lines()
        act = self.actual_delta_lines()
        if act != exp:
            raise SystemExit(f"INVARIANT FAIL: expected_delta={exp} lines, actual_delta={act} lines")

    # ---------- запись ----------
    def write(self) -> None:
        # Финальные базовые проверки: файл не должен стать пустым, если был непустой
        if self.orig and not self.text:
            raise SystemExit("INVARIANT FAIL: file became empty")

        # expected_delta обязан совпасть
        self.assert_expected_delta()

        # Атомарная запись
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", delete=False, encoding=self.encoding, dir=str(self.path.parent)) as tf:
            tf.write(self.text)
            tmp = Path(tf.name)
        tmp.replace(self.path)

def demo_help() -> str:
    return """\
SafeEdit: строгий редактор файлов.
- Все операции: insert_after_once / insert_before_once / replace_once / regex_sub_once
- Проверка: assert_expected_delta()
- Запись: write()

Совет: перед write() добавляй require_* проверки ключевых маркеров, чтобы не сломать файл.
"""

if __name__ == "__main__":
    print(demo_help())
