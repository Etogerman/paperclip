# Движок создания ТЗ

MVP-плагин Paperclip для детерминированного цикла создания технических заданий через пару GPT/Claude.

Этот пакет намеренно остаётся небольшим каркасом движка процесса, а не полным агентским циклом. Он задаёт форму устанавливаемого плагина и модель состояния, которую будет использовать полный процесс.

## Текущий объём MVP

- манифест плагина и устанавливаемый worker-пакет;
- собственное пространство имён Postgres для плагина;
- авторитетная таблица состояния `tz_process_runs`;
- append-only журнал событий `tz_process_events`;
- приватная таблица черновиков `tz_process_artifacts` для слепого раунда;
- таблицы `tz_repo_inventories`, `tz_fact_checks` и `tz_readiness_gates` для проверки фактов кодом;
- read-only локальная папка `project-repo` для чтения репозитория;
- ограниченные API-маршруты:
  - `POST /issues/:issueId/tz-process/start`;
  - `GET /issues/:issueId/tz-process`;
  - `POST /issues/:issueId/tz-process/readiness-check`;
- действия и данные плагина:
  - `start-cycle`;
  - `status`;
  - `run-readiness-check`;
- документ трассы процесса `tz-process-trace`;
- документ отчёта готовности `tz-readiness-report`;
- обработчик событий по ответам оператора.

## Чего ещё нет в этом каркасе

- вызовов сессий GPT/Claude-агентов;
- полноценных ping-pong раундов авторов;
- проверки схождения;
- синтеза финального ТЗ;
- кросс-вендорного QA;
- отдельных ворот оператора в интерфейсе.

## Repo Inventory / Fact Ledger

`run-readiness-check` проверяет утверждения о коде через код плагина, а не через текст агента.

Оператор настраивает для компании локальную папку `project-repo`. После этого плагин читает эту папку через Paperclip SDK и проверяет предикаты фактов:

- `file_exists`;
- `text_search`;
- `regex_search`.

Только этот кодовый путь может записать статус `confirmed` в `tz_fact_checks`. Если совпадение не найдено, факт остаётся в статусе `missing`, а gate готовности остаётся `blocked`, пока все обязательные факты не подтверждены.

Следующие слои нужно добавлять поверх этого пакета после проверки установки плагина и базового потока start/status в реальном экземпляре Paperclip.

## Разработка

```bash
pnpm --filter @paperclipai/plugin-tz-process-engine typecheck
pnpm --filter @paperclipai/plugin-tz-process-engine test
pnpm --filter @paperclipai/plugin-tz-process-engine build
```

## Локальная установка

Во время разработки используй абсолютный локальный путь:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip/packages/plugins/plugin-tz-process-engine","isLocalPath":true}'
```
