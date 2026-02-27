my_langgraph_agent

Локальный LangGraph-агент (ReAct) с Ollama + локальные панели управления (Settings UI) и React UI.

Проект устроен так, чтобы:

локальная часть (Ollama) жила в одном виртуальном окружении без “облачных” зависимостей;

облачные провайдеры (OpenAI/Anthropic и т.д.) позже добавлялись в отдельном окружении (без конфликтов пакетов).

Быстрый старт (одна команда)

Из корня проекта:

~/my_langgraph_agent/run.sh

Скрипт поднимет (или оставит запущенными) сервисы в tmux:

LangGraph API

Settings UI (настройки/модели)

React UI (основной UI)

UI Proxy (единая точка входа для React UI)

Адреса (что где открывать)

LangGraph API: http://127.0.0.1:2024

Документация API: http://127.0.0.1:2024/docs

Settings UI (FastAPI): http://127.0.0.1:8088

React UI (Vite): http://127.0.0.1:5174

UI Proxy (проксирует /api/* и /ui/* в React): http://127.0.0.1:8090

Важно:

В React UI запросы к LangGraph идут через /api/...

Модели/настройки идут через /ui/... (например /ui/models)

Как смотреть логи (tmux)

Посмотреть логи конкретного сервиса:

tmux attach -t langgraph
tmux attach -t settings_ui
tmux attach -t ui_proxy
tmux attach -t ui

Выйти из tmux (не останавливая сервис): Ctrl+B, затем D.

Как остановить сервисы

Остановить конкретную tmux-сессию:

tmux kill-session -t langgraph
tmux kill-session -t settings_ui
tmux kill-session -t ui_proxy
tmux kill-session -t ui

Проверить, что запущено:

tmux ls
Как выбрать модель Ollama
Вариант 1 (рекомендуется): через Settings UI

Открой Settings UI: http://127.0.0.1:8088

Выбери модель → Сохранить выбор

Нажми Перезапустить LangGraph сервер

Обнови страницу (или React UI)

Вариант 2: через React UI

Открой React UI: http://127.0.0.1:5174

Панель Локальные модели (Ollama) → выбери модель → Сохранить выбор

(Если нужно) Перезапустить LangGraph сервер

Обнови страницу

Структура проекта (важное)

agent/ — LangGraph проект (Python)

ui/ — React UI (Vite)

run.sh — запуск всего одной командой

ROADMAP.md — план развития

TASKS.md — текущие задачи/статус

ВАЖНО: как продолжать работу в новом чате

Если чат будет новый, начни так:

“Продолжаем проект my_langgraph_agent”

“Текущая задача: …”

(по желанию) вставь вывод:

tmux ls
~/my_langgraph_agent/run.sh
git log -1 --oneline

Вся история зафиксирована в репозитории (код + README/TASKS/ROADMAP), поэтому продолжать можно без старой переписки.