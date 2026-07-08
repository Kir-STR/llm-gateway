# Дизайн: core-managed timeout/abort (`@kir-str/llm-gateway`, этап 2 · Spec A)

Дата: 2026-07-08. Статус: черновик на ревью. Первый под-проект этапа 2 (см. роадмап; сплит: **A — core-timeout**, затем B — Anthropic-адаптер).

## Цель

Дать ядру **гарантию таймаута LLM-вызова, не доверяя провайдеру**: `runTurn` перестаёт ждать после `timeout_ms`, даже если реализация `LlmCaller` игнорирует переданный `AbortSignal`; при этом кооперативный адаптер получает сигнал и может реально оборвать HTTP/SDK-запрос. Закрывает уже найденный gap публичного контракта `LlmCaller.call(req, signal?)` (сейчас `signal` зарезервирован и не используется, таймаут делегирован адаптеру). Definition of done: любой будущий адаптер получает корректный `signal`, а ядро гарантирует timeout-поведение без знания провайдера.

Вне скоупа Spec A: сам `@anthropic-ai/sdk` адаптер (Spec B), таймаут кастомных `ScenarioHandler`, per-turn общий дедлайн.

## Config-контракт (обратно совместимо, opt-in)

Новое:

- Топ-уровень `llm?: { timeout_ms?: number }` — глобальный дефолт таймаута LLM-вызова.
- `ModelTier` расширяется опциональным `timeout_ms?: number` — override по тиру.

```yaml
llm:
  timeout_ms: 30000
models:
  cheap: { model: model-cheap, max_tokens: 1024, temperature: 0.3, timeout_ms: 10000 }
  expensive: { model: model-expensive, max_tokens: 2500, temperature: 0.3, timeout_ms: 60000 }
```

**Разрешение (в `doLlmCall`, по `modelRef`):**

1. `config.models[modelRef].timeout_ms`, если задан;
2. иначе `config.llm.timeout_ms`, если задан;
3. иначе — **core-managed таймаута нет** (вызов без сигнала, поведение как сейчас).

**Валидация (в `createGateway`, fail-loud at init):** каждое заданное `timeout_ms` (в `llm` и в любом `models.*`) — целое ≥ 1; иначе `ConfigError`. `llm` — объект с `additionalProperties: false`. Старые конфиги без `llm.timeout_ms` и без `models.*.timeout_ms` сохраняют текущее поведение.

## Механизм (per-call, в `doLlmCall`)

Таймаут применяется к **каждому** вызову `deps.llm.call` — первичному, транспортному ретраю, structured-correction и output-эскалации (каждый вызов бандится своим таймаутом).

- `timeoutMs === undefined` → `deps.llm.call(req)` (без второго аргумента), поведение неизменно.
- Иначе:
  1. создать `AbortController`;
  2. вызвать `deps.llm.call(req, controller.signal)`;
  3. параллельно поставить таймер на `timeoutMs`;
  4. гонка вызова против таймера:
     - **вызов резолвится/реджектится первым** → `clearTimeout` (без висящих таймеров), обычная обработка;
     - **таймер первым** → `controller.abort(reason)` (кооперативный адаптер оборвёт запрос); ядро завершает ожидание как timeout; **поздняя provider-promise глушится `.catch(() => {})`** (нет unhandled rejection после того, как гонка уже вернула timeout).

`AbortController`/`setTimeout`/`clearTimeout` — глобалы; ядро остаётся **рантайм-агностичным** (без `node:*`).

**Граница гарантии (честно, без ложного обещания по биллингу).** Ядро гарантирует только **bounded `runTurn`**: после `timeout_ms` фасад перестаёт ждать. Оно **не** гарантирует фактическую отмену provider-запроса и **точный cost accounting** без кооперативного адаптера: если адаптер игнорирует `signal`, реальный HTTP/SDK-запрос теоретически может доехать и быть затарифицирован на стороне провайдера, а ядро об этом не узнает (ответа/usage нет). Проброс `signal` — механизм, дающий кооперативному адаптеру возможность реально оборвать и не платить; без кооперации остаётся только временна́я граница.

## Классификация ошибок и таксономия исходов

**Таксономия исключений `doLlmCall`** (сейчас два класса — `BudgetExceeded`, `TransportExhausted`; добавляется третий):

- `BudgetExceeded` — worst-case per-request бюджет превышен (до вызова).
- `CoreTimeout` — core-race timeout **или** адаптерный `LlmCallError` с `code: 'timeout'` (обе разновидности «таймаута» классифицируются одинаково); `retryable: false`.
- `TransportExhausted` — исчерпание транспортного ретрая retryable-ошибок либо иная non-retryable ошибка (не timeout).

`CoreTimeout` **не ретраится** (существующий транспортный цикл уже так обрабатывает `retryable: false`).

**Телеметрия таймаута:** `llm_call` → `outcome: 'error', errorCode: 'timeout', costUsd: 0, latencyMs ≈ timeout_ms`. Здесь `costUsd: 0` — «стоимость, не известная ядру» (usage не получен), а **не** гарантия отсутствия фактического счёта у провайдера (см. «Граница гарантии»).

**Маппинг на исход `runTurn`:**

| причина | outcome | degradeReason | шаблон |
|---|---|---|---|
| `BudgetExceeded` | `rejected` | `cost_cap` | `degrade` |
| `CoreTimeout` | `failed` | `upstream_unavailable` | `llm_fail` |
| `TransportExhausted` | `failed` | `upstream_unavailable` | `llm_fail` |

Первичный llm-путь и output-эскалация уже так и мапят (`BudgetExceeded` → cost_cap; всё прочее → upstream). `CoreTimeout` как отдельный класс туда ложится без изменений (он не `instanceof BudgetExceeded` → идёт в upstream).

## Правка структурного пути (обязательна — иначе timeout теряется как parse-ошибка)

Сейчас `resolveStructured` при ошибке `doLlmCall` на correction-ретрае возвращает generic `{ failed: true }`, и оба call-site мапят это в `parse_fail`. С core-timeout это станет **неверной классификацией**: таймаут (или транспортный отказ, или бюджет) во время structured-correction — это не parse failure.

**Изменение:** `resolveStructured` возвращает **причину**:

```ts
Promise<{ resp: LlmResponse; value: unknown } | { failed: 'parse' | 'upstream' | 'cost_cap' }>
```

- `catch (BudgetExceeded)` → `{ failed: 'cost_cap' }`;
- `catch (CoreTimeout | TransportExhausted)` → `{ failed: 'upstream' }`;
- schema-исчерпание (валидация не прошла, ретраи structured исчерпаны, **без** исключения от вызова) → `{ failed: 'parse' }`.

Оба call-site фасада мапят причину:

- `'parse'` → `stub('parse_fail', 'failed', …)`;
- `'upstream'` → `stub('llm_fail', 'failed', …, 'upstream_unavailable')`;
- `'cost_cap'` → `stub('degrade', 'rejected', …, 'cost_cap')`.

**Побочный эффект:** эта правка закрывает отложенный Minor #4 из финального ревью этапа 1 (`BudgetExceeded` в structured-correction терял `cost_cap`) — теперь он классифицируется верно.

## Тесты (фейковый `LlmCaller`)

Дополняют существующий набор (числа не фиксируем):

- **opt-in:** без `llm.timeout_ms` и без `models.*.timeout_ms` — `call` зовётся без второго аргумента; поведение неизменно (регресс существующего набора зелёный).
- **таймаут срабатывает:** медленный fake (не резолвится либо резолвится за ~100мс) при `timeout_ms: 10` → `outcome: 'failed'`, `degradeReason: 'upstream_unavailable'`, текст `llm_fail`; `llm_call` с `errorCode: 'timeout'`; отсутствие unhandled rejection от поздней provider-promise.
- **signal проброшен и aborted:** fake фиксирует, что получил `AbortSignal` и что он `.aborted === true` после таймаута (кооперативная отмена).
- **не ретраится:** `timeout_ms` + транспортная retry-политика → ровно **один** вызов (таймаут не множит попытки).
- **разрешение tier > global:** заданы оба; fake фиксирует, что для тира с override взят его `timeout_ms`.
- **валидация:** `timeout_ms: 0` / отрицательное / дробное (в `llm` или в `models.*`) → `createGateway` бросает `ConfigError`.
- **классификация в structured-correction (ключевой тест правки):** таймаут (и транспортный отказ) во время correction-ретрая → `llm_fail` / `failed` / `upstream_unavailable`, **не** `parse_fail`. Отдельно: чистое schema-исчерпание (валидный транспорт, невалидная схема, ретраи исчерпаны) → `parse_fail`. Плюс: `BudgetExceeded` в correction → `degrade` / `cost_cap`.

## Версионирование

- npm-пакет: **minor-бамп** (0.1.0 → 0.2.0; API early-stage, ломающих изменений нет — поле опционально).
- Пример-конфиги: бамп `version` (1.0.0 → 1.1.0) — формат конфига расширен опциональным полем.
- README пакета: заменить текущую заметку «adapter owns timeout» на «core-managed timeout (opt-in); `signal` передаётся адаптеру; таймаут не ретраится → `upstream_unavailable`». Сохранить контракт «адаптер может дополнительно навязывать свой таймаут и рапортовать `LlmCallError('timeout')`».

## Инварианты (не нарушаются)

1. `createGateway` — единственная точка исключений (валидация `timeout_ms` — там же).
2. `runTurn` штатные отказы не бросает — таймаут это `outcome: 'failed'`, не throw.
3. Ядро рантайм-агностично (`AbortController`/`setTimeout` — глобалы, не `node:*`).
4. Ядро не знает провайдера — таймаут задаётся конфигом, механика провайдер-агностична.
5. Телеметрия на каждом шаге; `errorCode: 'timeout'` в `llm_call`.
