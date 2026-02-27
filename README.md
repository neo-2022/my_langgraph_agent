# my_langgraph_agent

Локальный агент на **LangGraph** с **Ollama** + локальная панель настроек.  
Цель проекта: удобный “локальный Studio-подобный” интерфейс и расширяемый агент с инструментами (файлы/shell/поиск), без конфликтов зависимостей.

---

## Что уже работает

### 1) LangGraph сервер (агент)
- Запускается локально через `langgraph dev --no-browser`
- API доступен на: **http://127.0.0.1:2024**
- Документация API: **http://127.0.0.1:2024/docs**

### 2) Локальная панель настроек (Settings UI)
- Запускается локально на: **http://127.0.0.1:8088**
- Возможности:
  - выбор модели Ollama (выпадающий список)
  - проверка поддержки `tool_calls` по моделям (с анимацией прогресса)
  - “Сохранить выбор” + “Перезапустить LangGraph сервер”
  - favicon (логотип графа)

### 3) Запуск “одной командой”
- Скрипт: `run.sh`
- Он запускает (или не дублирует, если уже запущено):
  - tmux-сессию `langgraph`
  - tmux-сессию `settings_ui`

---

## Структура проекта

- `agent/` — LangGraph проект (Python)
- `run.sh` — “одной командой” поднять всё в фоне
- `venv/` — виртуальное окружение Python (не хранится в git)
- (будет позже) `ui/` — React UI “как Studio” (локально)

---

## Требования

### Обязательное
- Linux
- Python 3.12+
- tmux
- Ollama

Проверка:
```bash
python3 --version
tmux -V
ollama --version
ollama list

Первый запуск (самый простой)
1) Перейти в папку проекта
cd ~/my_langgraph_agent
2) Запустить всё одной командой
bash run.sh

После запуска открой в браузере:

Settings UI: http://127.0.0.1:8088

LangGraph Docs: http://127.0.0.1:2024/docs

Как правильно менять модель (важно)

Открой Settings UI: http://127.0.0.1:8088

Выбери модель → нажми Сохранить выбор

Нажми Перезапустить LangGraph сервер

Важно про список моделей

Если ты установил/удалил модель:

ollama pull ...

ollama rm ...

то для обновления списка в UI достаточно просто нажать F5 (обновить страницу).
Перезапуск LangGraph для списка моделей не нужен.

Проверка: какая модель реально отвечает сейчас
curl -s -X POST http://127.0.0.1:2024/runs/wait \
  -H 'Content-Type: application/json' \
  -d '{
    "assistant_id": "fe096781-5601-53d2-b2f6-0d3403f7e9ca",
    "input": { "messages": [ { "role": "user", "content": "Скажи одним словом: ping" } ] }
  }' | python3 -c "import sys,json; r=json.load(sys.stdin); msgs=r.get('messages',[]); last=msgs[-1] if msgs else {}; meta=last.get('response_metadata',{}); print('MODEL=', (meta.get('model') or meta.get('model_name')), 'ANSWER=', last.get('content'))"
Управление процессами (tmux)
Посмотреть запущенные сессии
tmux ls
Подключиться к сессии (посмотреть логи)
tmux attach -t langgraph
# выйти не останавливая: Ctrl+B затем D
Логи Settings UI
tmux attach -t settings_ui
# выйти: Ctrl+B затем D
Остановить процессы
tmux kill-session -t langgraph
tmux kill-session -t settings_ui