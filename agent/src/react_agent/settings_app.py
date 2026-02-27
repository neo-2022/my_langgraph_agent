"""Local Settings UI for Ollama model selection (fast UI + sequential probing).

Run:
  cd ~/my_langgraph_agent/agent
  source ../venv/bin/activate
  python -m react_agent.settings_app

Open:
  http://127.0.0.1:8088
"""

from __future__ import annotations

import subprocess
import time
from typing import Dict, List, Tuple

from fastapi import FastAPI, Form
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse

from react_agent.tools import list_ollama_models, probe_tool_calls, set_ollama_model

app = FastAPI(title="LangGraph Agent Settings (Ollama)")

_PROBE_CACHE: Dict[str, Dict[str, float | bool]] = {}
CACHE_TTL_SECONDS = 60 * 60  # 1 hour


def _get_models_and_current(selected: str | None = None) -> Tuple[List[str], str]:
    data = list_ollama_models.invoke({})
    models: list[str] = data.get("models", [])
    current_env: str = data.get("current") or ""
    current: str = selected or current_env or (models[0] if models else "")
    return models, current


def _render_page(message: str | None = None) -> str:
    models, current = _get_models_and_current()

    options_html = "\n".join(
        [
            f'<option value="{m}" {"selected" if m == current else ""}>{m}</option>'
            for m in models
        ]
    )

    table_rows = "\n".join(
        [
            f"<tr><td>{m}</td><td id='tc-{i}' style='text-align:center'><span class='spinner'></span></td></tr>"
            for i, m in enumerate(models)
        ]
    )

    msg_html = f"<p><b>{message}</b></p>" if message else ""

    models_js_array = "[" + ",".join([f'"{m}"' for m in models]) + "]"

    favicon_svg = (
        "data:image/svg+xml;utf8,"
        "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'>"
        "<rect width='64' height='64' rx='12' fill='%23111111'/>"
        "<circle cx='18' cy='20' r='6' fill='%23ffffff'/>"
        "<circle cx='46' cy='18' r='6' fill='%23ffffff'/>"
        "<circle cx='44' cy='46' r='6' fill='%23ffffff'/>"
        "<circle cx='18' cy='44' r='6' fill='%23ffffff'/>"
        "<circle cx='32' cy='32' r='6' fill='%23ffffff'/>"
        "<path d='M18 20 L32 32 L46 18 M18 44 L32 32 L44 46 M18 20 L18 44 M46 18 L44 46' "
        "stroke='%23ffffff' stroke-width='3' fill='none' stroke-linecap='round'/>"
        "</svg>"
    )

    return f"""
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Agent Settings (Ollama)</title>
  <link rel="icon" href="{favicon_svg}">
  <style>
    body {{ font-family: sans-serif; max-width: 980px; margin: 24px auto; padding: 0 16px; }}
    .card {{ border: 1px solid #ddd; border-radius: 10px; padding: 16px; margin-bottom: 16px; }}
    select, button {{ font-size: 16px; padding: 8px; }}
    table {{ border-collapse: collapse; width: 100%; }}
    th, td {{ border: 1px solid #ddd; padding: 8px; }}
    th {{ background: #f5f5f5; text-align: left; }}
    .hint {{ color: #555; }}
    .row {{ display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }}
    .row form {{ margin: 0; }}
    .status {{ padding: 8px 12px; border-radius: 8px; background: #f7f7f7; display: inline-block; }}
    .btn {{ border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer; }}
    .btn:hover {{ background: #f3f3f3; }}
    .spinner {{
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid #bbb;
      border-top-color: #333;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
    }}
    @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
    .ok {{ font-weight: 700; }}
    .bad {{ font-weight: 700; }}
    .mono {{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }}
  </style>
</head>
<body>
  <h1>Настройки агента (Ollama)</h1>

  <div class="card">
    {msg_html}

    <div class="row">
      <form method="post" action="/set-model" class="row">
        <label for="model"><b>Модель</b></label>
        <select id="model" name="model">
          {options_html}
        </select>
        <button class="btn" type="submit">Сохранить выбор</button>
      </form>

      <form method="post" action="/restart-langgraph">
        <button class="btn" type="submit">Перезапустить LangGraph сервер</button>
      </form>
    </div>

    <p class="hint">
      <b>Как применить новую модель:</b> выбери модель → нажми <b>«Сохранить выбор»</b> → затем нажми <b>«Перезапустить LangGraph сервер»</b>.
      <br>
      <b>Если установил/удалил модели в Ollama:</b> просто обнови эту страницу (F5), чтобы обновился список.
    </p>
  </div>

  <div class="card">
    <h2>Поддержка tool_calls</h2>

    <div class="row">
      <div class="status" id="probe-status"><span class="spinner"></span> Идёт опрос моделей…</div>
      <button class="btn" id="reprobe">Перепроверить сейчас</button>
      <span class="hint">Результаты кэшируются на {CACHE_TTL_SECONDS // 60} минут.</span>
    </div>

    <p class="hint">
      ✅ = модель корректно делает tool_calls (можно для tools: файлы/shell/поиск).<br/>
      ❌ = модель не делает tool_calls (подходит для задач без инструментов).
    </p>

    <table>
      <thead><tr><th>Модель</th><th>tool_calls</th></tr></thead>
      <tbody>
        {table_rows}
      </tbody>
    </table>
  </div>

<script>
const models = {models_js_array};

function setCellSpinner(i) {{
  const cell = document.getElementById("tc-" + i);
  cell.innerHTML = "<span class='spinner'></span>";
}}

function setCellResult(i, ok) {{
  const cell = document.getElementById("tc-" + i);
  if (ok === true) {{
    cell.innerHTML = "<span class='ok'>✅</span>";
  }} else if (ok === false) {{
    cell.innerHTML = "<span class='bad'>❌</span>";
  }} else {{
    cell.textContent = "—";
  }}
}}

async function probeSequential(force=false) {{
  const statusEl = document.getElementById("probe-status");
  statusEl.innerHTML = "<span class='spinner'></span> Идёт опрос моделей…";

  for (let i = 0; i < models.length; i++) {{
    const m = models[i];
    setCellSpinner(i);
    statusEl.innerHTML = `<span class='spinner'></span> Проверяю ${{i+1}}/${{models.length}}: <span class="mono">${{m}}</span>`;

    try {{
      const resp = await fetch("/probe-one", {{
        method: "POST",
        headers: {{"Content-Type": "application/json"}},
        body: JSON.stringify({{model: m, force: force}})
      }});
      const data = await resp.json();
      setCellResult(i, data.ok);
    }} catch (e) {{
      setCellResult(i, null);
    }}
  }}

  statusEl.textContent = "Опрос завершён.";
}}

document.getElementById("reprobe").addEventListener("click", (e) => {{
  e.preventDefault();
  probeSequential(true);
}});

probeSequential(false);
</script>

</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
def index(saved: str | None = None) -> str:
    if saved == "1":
        return _render_page("Сохранено. Теперь нажми «Перезапустить LangGraph сервер».")
    if saved == "0":
        return _render_page("Не удалось сохранить. Проверь модель/логи.")
    if saved == "R1":
        return _render_page("LangGraph сервер перезапущен.")
    if saved == "R0":
        return _render_page("Не удалось перезапустить LangGraph сервер. Проверь наличие tmux-сессии langgraph и логи.")
    return _render_page()


@app.post("/set-model")
def set_model(model: str = Form(...)) -> RedirectResponse:
    res = set_ollama_model.invoke({"model": model})
    if res.get("ok"):
        return RedirectResponse(url="/?saved=1", status_code=303)
    return RedirectResponse(url="/?saved=0", status_code=303)


@app.post("/probe-one", response_class=JSONResponse)
def probe_one(payload: dict) -> dict:
    model = str(payload.get("model", "")).strip()
    force = bool(payload.get("force", False))
    if not model:
        return {"ok": None, "error": "missing model"}

    now = time.time()
    cached = _PROBE_CACHE.get(model)
    if (not force) and cached and (now - float(cached["ts"])) < CACHE_TTL_SECONDS:
        return {"ok": bool(cached["ok"]), "cached": True}

    pr = probe_tool_calls.invoke({"model": model})
    ok = bool(pr.get("supports_tool_calls"))
    _PROBE_CACHE[model] = {"ok": ok, "ts": now}
    return {"ok": ok, "cached": False}


@app.post("/restart-langgraph")
def restart_langgraph() -> RedirectResponse:
    try:
        has = subprocess.run(["tmux", "has-session", "-t", "langgraph"], check=False)
        if has.returncode != 0:
            return RedirectResponse(url="/?saved=R0", status_code=303)

        subprocess.run(["tmux", "send-keys", "-t", "langgraph", "C-c"], check=False)
        cmd = "cd ~/my_langgraph_agent/agent && source ../venv/bin/activate && langgraph dev --no-browser"
        subprocess.run(["tmux", "send-keys", "-t", "langgraph", cmd, "Enter"], check=False)

        return RedirectResponse(url="/?saved=R1", status_code=303)
    except Exception:
        return RedirectResponse(url="/?saved=R0", status_code=303)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8088)
