# my_langgraph_agent

Локальный агент на LangGraph с Ollama + удобная панель настроек (локально) и основа для будущего UI.

## Что это
- **LangGraph агент** запускается локально (API на `http://127.0.0.1:2024`)
- **Settings UI** запускается локально (UI на `http://127.0.0.1:8088`)
  - выбор модели Ollama
  - проверка `tool_calls` по моделям
  - кнопка перезапуска LangGraph сервера
  - список моделей обновляется после `ollama pull/rm` обычным F5

## Структура проекта
- `agent/` — LangGraph проект (Python)
- `venv/` — виртуальное окружение Python (не хранится в git)
- (будет позже) `ui/` — React UI “как Studio” (локально)

## Требования
- Linux
- Python 3.12+
- Ollama установлен и запущен
- tmux установлен

Проверка Ollama:
```bash
ollama --version
ollama list