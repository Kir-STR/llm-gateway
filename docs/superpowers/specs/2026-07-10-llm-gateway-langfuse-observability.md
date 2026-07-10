# Observability — Langfuse-адаптер `TelemetrySink` (`@kir-str/llm-gateway/langfuse`)

**Статус:** на ревью (brainstorming) — ожидает финального «ок» пользователя.
**Дата:** 2026-07-10.
**Этап:** 2, под-проект «observability» (третий; provider adapter — PR #4/#5, entitlements — PR #6 — смержены).
**Контракт ядра `@kir-str/llm-gateway`:** **не меняется.** Адаптер — потребитель публичного `TelemetrySink`/`TelemetryEvent`. Источники: `packages/gateway/src/core/types.ts` (`TelemetrySink`, `TelemetryEvent`), `packages/gateway/src/core/telemetry-events.ts` (`EVENTS` + `*Data`-шейпы), `packages/gateway/src/core/emit.ts` (fire-and-forget эмиссия), `packages/gateway/src/core/gateway.ts:252` (`turn_completed` в `finish()`).

## 1. Цель

Поставить реализацию `TelemetrySink` поверх Langfuse как **опциональный subpath-entry** `@kir-str/llm-gateway/langfuse`. Адаптер переводит плоский поток `TelemetryEvent` в Langfuse trace-модель: **trace = ход** (по `traceId`), **generation = `llm_call`** (модель / токены / стоимость / латентность), итог хода — на trace. Событийная модель ядра с самого начала спроектирована под Langfuse (design-спека этапа 1). Никакой доменной логики; никакого владения lifecycle клиента.

## 2. Скоуп и не-цели

**Не-цели v1:**

- **Вложенные spans стадий** (normalize / guards / structured / retry как waterfall) — текущие события не дают чистых start/end пар для всех стадий; синтетические timestamps + span-состояние легко протекают при незавершённых ходах. → v2.
- **Форвардинг не-core событий** (`guard_result`, `route_decision`, `guards_aggregated`, `structured_parse`, `retry`, `cost_cap`, `normalize`, `delivery`) — v1 мапит **только три core-события** (`turn_started` / `llm_call` / `turn_completed`); прочие **игнорируются** (их per-event маппинг и counters — v2). Итоговая история хода (outcome / flags / degradeReason / totals) уже на trace через `turn_completed`.
- **`maxOpenTraces` guard** — `turn_completed` гарантирован на всех нормальных путях `runTurn` (см. §6); утечка возможна только от бага ядра / смерти процесса — вне зоны адаптера. → v2 (опция).
- **Конструирование SDK-клиента из env**, чтение env, владение `flush`/`shutdown` — всё у потребителя.
- **Отправка текстов промптов/ответов** — их нет в событиях (ядро кладёт только длины/токены), и v1 их не реконструирует.
- **Форвардинг `event.data` целиком** — см. whitelist-политику §7.

## 3. Упаковка и инъекция (наследует Anthropic-адаптер, PR #5)

- Новый опциональный subpath `@kir-str/llm-gateway/langfuse`. Базовые entry `.`/`./node` SDK не касаются.
- Langfuse SDK — **optional peerDependency** (declared compatibility) + **devDependency** (typecheck/conformance против реального типа). `import type` только — ноль SDK в runtime `dist/langfuse.js`.
- **Клиент инъектируется готовым:** `createLangfuseSink(client, options?)`. Адаптер не читает env, не создаёт клиента, не владеет lifecycle. `flush()`/`shutdown()` — потребитель (совпадает с тем, что `gateway.close()` телеметрию не флашит).
- Зона: **рантайм-агностична** (не `./node`) — адаптер только зовёт методы инъектированного клиента; `node:*` не нужен. `Date` разрешён (ядро уже использует `Date.now()`).

```jsonc
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./node": { "types": "./dist/node.d.ts", "import": "./dist/node.js" },
    "./anthropic": { "types": "./dist/anthropic.d.ts", "import": "./dist/anthropic.js" },
    "./langfuse": { "types": "./dist/langfuse.d.ts", "import": "./dist/langfuse.js" }
  }
}
```

## 4. Публичный API

```ts
export function createLangfuseSink(
  client: LangfuseClientLike,
  options?: LangfuseSinkOptions,
): TelemetrySink;

export interface LangfuseSinkOptions {
  /** Источник времени (тесты + generation timestamps). Дефолт: () => new Date(). */
  now?: () => Date;
  /** Имя trace. Дефолт: "llm-gateway turn". */
  traceName?: string;
  /** Имя generation. Дефолт: "llm call". */
  generationName?: string;
}

// hand-rolled минимальный structural-интерфейс — только методы/поля, которые адаптер зовёт.
export interface LangfuseTraceLike {
  generation(body: Record<string, unknown>): unknown; // возврат игнорим (v1 без вложенных spans)
  update(body: Record<string, unknown>): unknown;
}
export interface LangfuseClientLike {
  trace(body: {
    id?: string;
    name?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): LangfuseTraceLike;
}
```

**Рантайм адаптера не зависит от типов SDK** (чтобы не зацементировать внутренние builder-body типы, хрупкие к минорным ревизиям SDK). Защита от дрейфа — отдельный **type-level conformance-тест**: реальный `Langfuse` присваивается в `LangfuseClientLike` (точная форма — `const _c: LangfuseClientLike = new Langfuse(...)` либо `const _conforms = (c: Langfuse): LangfuseClientLike => c` — пинуется под установленный SDK при реализации; §10).

## 5. Маппинг событий → Langfuse

Мапинг v1 — **trace + generation + outcome**, ровно три core-события. Форвардятся только whitelist-поля (§7). Все прочие события **игнорируются** (v2).

| Событие | Действие | Форвардим (whitelist) |
|---|---|---|
| одно из трёх core (первое по `traceId`) | `getOrCreate` → `client.trace({ id: traceId, name: traceName })` **ровно один раз**, handle в map | — |
| `turn_started` | обогащает trace (`update` или в `trace()` при создании) | `metadata: { inputLen, configVersion }` |
| `llm_call` | `handle.generation({ name: generationName, model, … })` | `modelRef, attempt, outcome, errorCode?`, usage `{ inTokens, outTokens, cacheReadTokens?, cacheWriteTokens? }`, `costUsd`, `startTime`/`endTime` (§8) |
| `turn_completed` | `handle.update(...)` **+ evict из map** | `metadata: { outcome, scenario, flags, degradeReason?, totalLatencyMs, totalCostUsd }` |
| **все прочие** (`guard_result`, `structured_parse`, `route_decision`, `retry`, `cost_cap`, `normalize`, `guards_aggregated`, `delivery`) | **игнорируются** — ни `trace`, ни любой другой вызов клиента | ничего (их поля, включая `evidence`/`detail`, не покидают адаптер) |

Точные имена полей SDK (`usage` vs `usageDetails`/`costDetails`; casing `startTime`/`endTime`) — **implementation-gate под установленную версию SDK** (§10): timestamps и usage мапятся на принятые именами поля установленного SDK.

Замечание по lazy-create: «первое событие по `traceId`» на практике — `turn_started` (эмитится первым, `gateway.ts:239`). Но create-if-absent срабатывает и на первом `llm_call`/`turn_completed`, если `turn_started` почему-то не пришёл — робастность к переупорядочиванию/пропуску. Не-core события `getOrCreate` **не** триггерят (они игнорируются целиком).

## 6. Состояние и поток

`Map<traceId, LangfuseTraceLike>`:

1. **lazy-create** на первом **core-событии** с данным `traceId` (`getOrCreate` зовёт `client.trace({ id })` один раз, кладёт handle в map). Не-core события `getOrCreate` не триггерят (§5). `turn_started` не является обязательной точкой создания — лишь обогащает (create-if-absent сработает и на первом `llm_call`/`turn_completed`).
2. `turn_started` → обогащает trace input-метаданными.
3. `llm_call` → `handle.generation(...)`.
4. `turn_completed` → `handle.update(...)` c итогом + **delete из map** (evict).

**Без `maxOpenTraces`.** `turn_completed` эмитится внутри `finish()` (`gateway.ts:252`) — единственной точки сборки `TurnResult`; `runTurn` штатные отказы не бросает, все исходы (`delivered`/`rejected`/`failed`) проходят через `finish()`, поэтому map самоочищается. Утечка возможна только при неожиданном throw-баге ядра или смерти процесса (map умирает с процессом).

**Late-событие после eviction** (out-of-order после `turn_completed`) → lazy-create воскресит orphan-trace. Принято как v1-трейд-офф: события синхронны и упорядочены в пределах хода (редкий край).

## 7. Ошибки и hygiene

### Ошибки
- `emit.ts` оборачивает `sink.event(...)` в try/catch — но `event` **синхронный**, так что это ловит только **синхронный** throw. Если метод установленного SDK вернёт thenable и он reject-нется, emit.ts его **не поймает** → unhandled promise rejection (в Node может уронить процесс).
- Поэтому адаптер оборачивает **каждый** вызов клиента (`trace`/`generation`/`update`) в helper `callClient(fn)`, который: (а) ловит синхронный throw (глотает); (б) если возврат — thenable, навешивает `.catch(() => {})`. **Не** async/await — `event` остаётся синхронным fire-and-forget; ход не падает и нет unhandled rejection независимо от того, синхронны методы SDK или нет.
- Адаптер **defensive на форму данных**: не бросает на событиях с отсутствующими optional-полями (`errorCode?`, `cacheReadTokens?`, `degradeReason?` и т.п.).

### Hygiene — whitelist-only (инвариант 5: в телеметрию не попадают немаскированные ПД/секреты)
- Адаптер **не форвардит `TelemetryEvent.data` целиком.** Для трёх core-событий он мапит **whitelist** PII-минимизированных полей: длины, счётчики токенов, стоимости, id моделей, outcomes, коды, flags, имена сценариев, totals (перечислены в §5).
- Потенциально опасные поля **`guard_result.evidence` (`unknown`) и `structured_parse.detail` (`string`)** в v1 не покидают адаптер **вдвойне**: (а) их события целиком игнорируются (§5); (б) даже когда эти события начнут мапиться в v2, `evidence`/`detail` останутся вне whitelist.
- Тексты промптов/ответов в Langfuse **не уходят** — их нет в событиях (ядро кладёт только `inputLen`/токены), и v1 их не реконструирует. Следствие whitelist-политики и отсутствия текста в источнике.

## 8. Timestamps

Generation в Langfuse принимает start/end. У адаптера есть `latencyMs` на завершении `llm_call`:

```
endTime = now();
startTime = new Date(endTime.getTime() - latencyMs);
```

`now` инъектируется через `options.now` (дефолт `() => new Date()`) — детерминизм в тестах и рантайм-агностичность. Точные имена/casing полей timestamp — implementation-gate (§10).

## 9. Тесты

- **Fake `LangfuseClientLike`**, записывающий вызовы (стиль `createFakeLlm`):
  - trace создаётся **ровно один раз** на `traceId` (несколько событий → один `client.trace`).
  - `turn_started` → trace-метаданные `{ inputLen, configVersion }`.
  - `llm_call` → `generation` с whitelist usage/cost и детерминированными `startTime`/`endTime` (через инъектированный `now`).
  - `turn_completed` → `update` c итогом **и evict**: последующее событие с тем же `traceId` создаёт **новый** trace (доказывает удаление из map).
  - несколько `llm_call` в одном ходе → несколько `generation` под одним trace.
- **Hygiene-тест:** `guard_result` с sentinel-секретом в `evidence` и `structured_parse` с sentinel в `detail` **не порождают ни одного вызова клиента** (события игнорируются), и sentinel не появляется ни в одном вызове (стиль `trusted-context.test.ts`). Проверяем, что форвардятся только whitelist-поля трёх core-событий.
- **Non-core ignore-тест:** поток из не-core событий между `turn_started` и `turn_completed` не добавляет вызовов клиента сверх trace/generation/update от core-событий.
- **Defensive-тест:** событие с отсутствующими optional-полями не бросает.
- **Async-reject-тест:** fake-клиент, чей метод возвращает **reject-нутый Promise**, не приводит к unhandled rejection и `sink.event(...)` не бросает (проверяет `callClient` `.catch()`-обёртку). Плюс: метод, бросающий **синхронно**, тоже не роняет `event`.
- **Type-level conformance-тест** с реальным SDK (§4).
- **Import-zone инвариант:** Langfuse SDK только за `./langfuse`; базовые entry (`core/`, `index.ts`, `node.ts`, `anthropic.ts`) его не импортируют — расширить существующий `no-sdk-import.test.ts` (или зеркальный тест).

## 10. Implementation-gates (в план, не блокеры дизайна)

Пинуются при реализации против **установленной версии Langfuse SDK**:
- Точные сигнатуры `client.trace(...)`, `trace.generation(...)`, `trace.update(...)` и форма conformance-теста (`const _c: LangfuseClientLike = new Langfuse()` vs `_conforms`).
- Имена/casing полей usage/cost (`usage` vs `usageDetails`+`costDetails`) и timestamp (`startTime`/`endTime`).
- Идемпотентность `trace({ id })` при повторном вызове (адаптер зовёт один раз — на всякий случай задокументировать).

## 11. Инварианты

1. Контракт ядра не меняется; адаптер — чистый потребитель `TelemetrySink`.
2. Langfuse SDK не в runtime-зависимостях; только за `./langfuse`, `import type`.
3. Клиент инъектируется; адаптер не читает env, не создаёт клиента, не владеет flush/shutdown.
4. **Whitelist-only:** `event.data` целиком не форвардится; `evidence`/`detail` и любой сырой текст не уходят в Langfuse.
5. Исключение адаптера не роняет ход: `emit.ts` ловит sync-throw, а `callClient` дополнительно глотает sync-throw **и** async-reject (`.catch()` на thenable); адаптер defensive на форму данных.
6. `trace` создаётся один раз на `traceId`; evict на `turn_completed`.

## 12. Вне скоупа v1

Форвардинг не-core событий (`guard_result`/`route_decision`/`retry`/`cost_cap`/`normalize`/`guards_aggregated`/`structured_parse`/`delivery`) и counters; вложенные spans стадий (waterfall); `maxOpenTraces`; отправка текстов промптов/ответов; scores/evals Langfuse; конструирование клиента из env; sampling; батч-настройки SDK; мульти-проектный роутинг.

## 13. Версионирование и зависимости

- **npm-пакет `@kir-str/llm-gateway`: minor bump `0.3.0` → `0.4.0`** — добавление опционального subpath `./langfuse` (additive, не ломающее). README (список subpath-entry) + CHANGELOG обновляются (как при добавлении `./anthropic` в 0.3.0). См. [[versioning]].
- **Langfuse SDK** — точное имя пакета и версия пинуются при реализации против установленного SDK (§10). Декларируется как **`peerDependencies` + `peerDependenciesMeta.optional: true`** (declared compatibility, не runtime-зависимость) и **`devDependency`** (typecheck + conformance-тест против реального типа). Базовые entry `.`/`./node`/`./anthropic` его не касаются.
- Конфиг gateway (`version`) **не меняется** — адаптер не трогает формат/семантику конфига.
