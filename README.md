# my_langgraph_agent

Локальный LangGraph-агент (ReAct) с Ollama + локальные панели управления:
- Settings UI (FastAPI)
- React UI (Vite) — “мини-Studio”

Проект устроен так, чтобы:
- локальная часть (Ollama) жила в одном виртуальном окружении без “облачных” зависимостей
- облачные провайдеры (OpenAI/Anthropic и т.д.) позже добавлялись в отдельном окружении (без конфликтов пакетов)

---

## Быстрый старт (одна команда)

Из корня проекта:

~~~bash
~/my_langgraph_agent/run.sh
~~~

Скрипт поднимет (или оставит запущенными) сервисы в tmux:
- LangGraph API
- Settings UI (настройки/модели)
- React UI (основной UI)
- UI Proxy (единая точка входа для React UI)

---

## Адреса (что где открывать)

- LangGraph API: http://127.0.0.1:2024
- Документация API: http://127.0.0.1:2024/docs
- Settings UI (FastAPI): http://127.0.0.1:8088
- React UI (Vite): http://127.0.0.1:5174
- UI Proxy (проксирует `/api/*` и `/ui/*`): http://127.0.0.1:8090

Важно:
- React UI запросы к LangGraph делает через `/api/...` (через UI Proxy)
- модели/настройки идут через `/ui/...` (например `/ui/models`)

---

## Как смотреть логи (tmux)

Подключиться к конкретному сервису:

~~~bash
tmux attach -t langgraph
tmux attach -t settings_ui
tmux attach -t ui_proxy
tmux attach -t ui
~~~

Выйти из tmux (не останавливая сервис): Ctrl+B, затем D.

Прокрутка логов вверх (copy-mode):
- Ctrl+B, затем [
- листать стрелками / PageUp / PageDown
- выйти: q

Проверить, что запущено:

~~~bash
tmux ls
~~~

---

## Как выбрать модель Ollama

### Вариант 1 (рекомендуется): через Settings UI
1) Открой Settings UI: http://127.0.0.1:8088
2) Выбери модель → Сохранить
3) Нажми “Перезапустить LangGraph”
4) Обнови React UI

### Вариант 2: через React UI
1) Открой React UI: http://127.0.0.1:5174
2) Панель “Локальные модели (Ollama)” → выбери модель → “Сохранить”
3) (Если нужно) “Перезапустить LangGraph”
4) Обнови страницу

---

## Структура проекта (важное)

- `agent/` — LangGraph проект (Python)
- `ui/` — React UI (Vite)
- `run.sh` — запуск всего одной командой

Документация:
- `CHECKLIST.md` — единый источник правды по UI/Graph/Run/Debugger
- `TASKS.md` — трекер прогресса (по чеклисту)
- `ROADMAP.md` — план “что и зачем” (по этапам)

---

## Как продолжать работу в новом чате

Если чат будет новый, начни так:
- “Продолжаем проект my_langgraph_agent”
- “Текущая задача: …”

(по желанию) вставь вывод:

~~~bash
tmux ls
git log -1 --oneline
~~~

Вся история зафиксирована в репозитории (код + README/TASKS/ROADMAP/CHECKLIST).
