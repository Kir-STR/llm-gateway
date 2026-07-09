# Spec B — адаптер `@anthropic-ai/sdk` (Anthropic `LlmCaller`)

**Статус:** на ревью (brainstorming) — правки code-review внесены, ожидает финального «ок» пользователя.
**Дата:** 2026-07-09.
**Этап:** 2, под-проект «provider adapter», расщепление Spec A (core-timeout, смержен PR #4) → **Spec B** (этот документ).
**Контракт ядра:** не меняется. Источники: `packages/gateway/src/core/types.ts` (`LlmRequest`/`LlmResponse`/`LlmCaller`/`LlmCallError`, строки 27–72), место вызова и структурного retry — `packages/gateway/src/core/gateway.ts:442` (сборка `LlmRequest`), `:446` (`toolSchema`), `:510` (`resolveStructured`).

## 1. Цель

Поставить реализацию `LlmCaller` поверх официального `@anthropic-ai/sdk` как **опциональный subpath-entry point** `@kir-str/llm-gateway/anthropic`. Адаптер — тонкий транслятор: `LlmRequest` → `messages.create(body, options)`, ответ SDK → `LlmResponse`, ошибки SDK → `LlmCallError`. Никакой доменной логики, никаких политик retry/timeout (ими владеет ядро).

### Не-цели (out of scope Spec B v1)

- **`output_config.format` (Anthropic structured outputs).** Основной и единственный путь структурного вывода — forced tool use (см. §6). Формулировка:
  > When `req.toolSchema` is present, the Anthropic adapter uses forced tool use: it sends a single internal tool with `input_schema = req.toolSchema` and `tool_choice` forcing that tool. The adapter extracts the first matching `tool_use.input` into `LlmResponse.structured`. The core remains responsible for schema validation and structured correction retry. `output_config.format` is intentionally out of scope for Spec B v1 because support is model-dependent and would introduce provider capability policy into the adapter contract.
- **`defaultModel` / любые fallback модели.** `LlmRequest.model` required, gateway всегда его проставляет; вводить не будем (YAGNI).
- **Собственный таймаут адаптера, собственная retry-логика, потоковый режим, thinking/effort, конструирование клиента из `apiKey`.**

## 2. Упаковка

Один пакет `@kir-str/llm-gateway`, новый опциональный subpath. `@anthropic-ai/sdk` — **optional peerDependency** (declared compatibility contract) + **devDependency** (typecheck/тесты против реального типа клиента). Базовые entry `.` и `./node` SDK не касаются.

```json
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./node": { "types": "./dist/node.d.ts", "import": "./dist/node.js" },
    "./anthropic": { "types": "./dist/anthropic.d.ts", "import": "./dist/anthropic.js" }
  },
  "peerDependencies": { "@anthropic-ai/sdk": "^0.x" },
  "peerDependenciesMeta": { "@anthropic-ai/sdk": { "optional": true } },
  "devDependencies": { "@anthropic-ai/sdk": "^0.x" }
}
```

Consumer подключает явно: `pnpm add @kir-str/llm-gateway @anthropic-ai/sdk`. Точный мажор SDK (`^0.x`) фиксируется на этапе реализации по установленной версии из lock-файла (дисциплина: сверять с lock, не по памяти).

## 3. Import-зона и отсутствие runtime-зависимости от SDK

- Файл `packages/gateway/src/anthropic.ts` — новая зона. Клиент инъектируется, `new Anthropic()` **не** вызывается; тело запроса — plain-объекты; ошибки классифицируются duck-typing (§9). Поэтому SDK импортируется **только как `import type`** (типы клиента, params, response, request options). `import type` стирается компилятором → в собранном `dist/anthropic.js` нет `require('@anthropic-ai/sdk')`. Пакет не тянет SDK в runtime ни в одной зоне.
- `node:*` в `anthropic.ts` **запрещён** (адаптер рантайм-агностичен: Node 22+, edge, браузер — как `core/`).
- Инвариант: `core/`, `src/index.ts`, `src/node.ts` не импортируют `@anthropic-ai/sdk` (ни value, ни type). Покрывается тестом (§10), по образцу `packages/gateway/tests/trusted-context.test.ts`.

## 4. Публичный API

```ts
// src/anthropic.ts
import type Anthropic from '@anthropic-ai/sdk'; // type-only, стирается при сборке

// Минимальный структурный интерфейс — ровно то, что дёргает адаптер.
// Реальный Anthropic ему удовлетворяет; fake в тестах — тривиально.
// Точные типы body/options/ответа берутся из SDK type-only импортов
// (Anthropic.Messages.MessageCreateParamsNonStreaming, Anthropic.RequestOptions, Anthropic.Message)
// и верифицируются на этапе реализации (§13).
export interface AnthropicClientLike {
  messages: { create(body: MessageCreateBody, options: RequestOptionsLike): Promise<MessageLike> };
}

export interface AnthropicCallerOptions {
  /** Fallback для max_tokens, когда req.maxTokens не задан. Обязателен на проде; optional в API ради тестов. */
  defaultMaxTokens?: number;
}

export function createAnthropicLlmCaller(
  client: AnthropicClientLike,
  opts?: AnthropicCallerOptions,
): LlmCaller;
```

Фабрика не читает `process.env`, не владеет ключом / `baseURL` / `fetch` / `maxRetries` / таймаутом клиента — их конфигурирует потребитель при создании `new Anthropic(...)`.

## 5. Маппинг `LlmRequest` → `messages.create(body, options)`

`body`:

| Поле body | Источник | Правило |
|---|---|---|
| `model` | `req.model` | обязателен; пуст/undefined → `new LlmCallError('Missing req.model', 'bad_request', false)` **до сети** |
| `max_tokens` | `req.maxTokens ?? opts.defaultMaxTokens` | нет ни того, ни другого → `new LlmCallError('max_tokens is required', 'bad_request', false)` **до сети** |
| `messages` | `req.input` | `[{ role: 'user', content: req.input }]` |
| `system` | `req.correction` | задаётся **только** если `req.correction` определён; иначе поле не передаётся |
| `temperature` | `req.temperature` | прокидывается, если определён (см. caveat ниже) |
| `tools`, `tool_choice` | `req.toolSchema` | только при structured — см. §6 |

`options` (второй аргумент): `{ signal, maxRetries: 0 }` (§8).

**Caveat (не чиним в адаптере):** некоторые модели/провайдер-режимы отвергают непустой `temperature` (400). Ограничения конкретных моделей на параметры — ответственность конфигурации (`models.*.temperature`) и провайдера, не адаптера. Стабильный тезис дизайна: адаптер прокидывает `temperature` честно; провайдерский 400 маппится в `bad_request` (§9). (Актуальный перечень моделей с таким ограничением в спеку не фиксируем — скоропортящийся факт.)

**`system` и trusted-context.** `req.correction` — доверенный серверный текст из `retry.correction_prompt` конфига, не под влиянием модели и не пользовательский ввод, поэтому top-level `system` не нарушает security-инвариант «доверенный контекст vs недоверенный ввод». Семантически это instruction-override для повторной попытки — `system` точнее второго `user`-сообщения.

## 6. Структурный вывод — forced tool use

При `req.toolSchema`:

```ts
tools: [{ name: 'emit_structured_output', description: 'Return the result as structured output.', input_schema: req.toolSchema }]
tool_choice: { type: 'tool', name: 'emit_structured_output' }
```

- `req.toolSchema` передаётся как `input_schema` **как есть**, без трансформаций. Если Anthropic отвергнет схему как несовместимую — это provider 400 → `bad_request` (§9), **не** structured-correction retry (correction-retry ядра срабатывает только на *успешный* ответ с невалидным `structured`, не на сетевой 400).
- Извлечение: первый `content`-блок типа `tool_use` с `name === 'emit_structured_output'` → его `.input` → `LlmResponse.structured`. Нет такого блока → `structured: undefined` (ядро увидит невалид → correction-retry по своей политике).

## 7. Маппинг ответа → `LlmResponse`

| Поле `LlmResponse` | Источник |
|---|---|
| `usage.inputTokens` | `usage.input_tokens` |
| `usage.outputTokens` | `usage.output_tokens` |
| `usage.cacheReadTokens` | `usage.cache_read_input_tokens` |
| `usage.cacheWriteTokens` | `usage.cache_creation_input_tokens` |
| `text` | склейка всех `text`-блоков в порядке `content` через `join('')` (без добавленных символов); пусто → поле не задаётся |
| `structured` | см. §6 |

## 8. Retry / timeout / abort — ядро единственный владелец

- **Retry.** SDK по умолчанию сам ретраит 429/5xx (`maxRetries: 2`), ядро ретраит по `retry`-политике → без вмешательства был бы двойной повтор. **Основной механизм:** адаптер всегда передаёт per-request `maxRetries: 0` в `options` (адаптер владеет вторым аргументом `create`, per-request перекрывает клиентский дефолт, чужой клиент не мутируется).
  - **Compile gate:** `options` типизируется как `Anthropic.RequestOptions`; если в установленной версии SDK у `RequestOptions` нет поля `maxRetries` — код не компилируется, что форсит fallback.
  - **Fallback** (если per-request `maxRetries` недоступен): fail-fast в фабрике — duck-typing `client.maxRetries !== 0` → `throw new TypeError('Anthropic client must be constructed with maxRetries: 0')`. Фейки без поля проходят.
  - **README** в любом случае рекомендует `new Anthropic({ maxRetries: 0 })` (снижает сюрпризы вне gateway, совпадает с ownership-инвариантом).
- **Abort / timeout ownership.** `signal` из `llm.call(req, signal)` прокидывается в `options`. Политику таймаута держит ядро (`callWithTimeout`, Spec A): при заданном config-таймауте — гонка таймера + `AbortController.signal`; при отсутствии config-таймаута ядро вызов не ограничивает. Транспортный backstop — собственный таймаут инъектированного клиента (`new Anthropic({ timeout })`, дефолт SDK), им владеет потребитель. Адаптер собственного таймаута **не** заводит.
- **Cleanup doc-comment `LlmCaller` (правка комментария, не контракта).** Текущий комментарий `packages/gateway/src/core/types.ts:50` («адаптер ОБЯЗАН держать свой таймаут; `signal` — future stage-2 с реальным адаптером») устарел: Spec B и есть тот stage-2. Задача Spec B — переписать комментарий под факт (ядро владеет config-таймаутом и прокидывает `signal`; адаптер честно передаёт `signal`, свой таймаут не держит; транспортный backstop — таймаут клиента). Меняется **только текст комментария**; сигнатуры/типы `LlmCaller`/`LlmRequest`/`LlmResponse` не трогаются, так что «контракт ядра не меняется» (шапка) сохраняется.

## 9. Ошибки → `LlmCallError`

Классификация **duck-typing** (без `instanceof` на SDK-классы; по числовому `status` для HTTP, по `err.name` для connection/abort/timeout — мапер чистый, юнит-тестируемый на plain-объектах, не завязан на runtime-импорт SDK). `LlmErrorCode = 'rate_limit' | 'overloaded' | 'server' | 'timeout' | 'auth' | 'bad_request' | 'unknown'`.

| Признак ошибки | `code` | `retryable` |
|---|---|---|
| `status === 429` | `rate_limit` | ✅ |
| `status === 529` | `overloaded` | ✅ |
| `status >= 500` (500/502/503…) | `server` | ✅ |
| сетевой сбой не-таймаут (`name === 'APIConnectionError'`) | `server` | ✅ |
| таймаут SDK (`name === 'APIConnectionTimeoutError'`) | `timeout` | ❌ |
| abort по signal (`name === 'APIUserAbortError'`) | `timeout` | ❌ |
| `status === 401` / `403` | `auth` | ❌ |
| `status === 400` / `404` / `413` | `bad_request` | ❌ |
| прочее / не-API throw | `unknown` | ❌ |

Порядок проверки: сначала три ошибки без `status` по `err.name` (`APIUserAbortError`, `APIConnectionTimeoutError`, `APIConnectionError` — они никогда не несут числовой `status`, поэтому по `status`-ветке не поймаются), затем ветвление по числовому `status` (429 / 529 / ≥500 / 401 / 403 / 400 / 404 / 413), иначе `unknown`. Порядок строк в таблице выше — для читаемости; логика однозначна: no-status-имена → числовой `status` → `unknown`, так что HTTP-коды (429/529/…) сохраняются независимо от того, насколько «общее» имя у SDK-класса. `timeout` не ретраится ядром by design; согласуется с `gateway.ts:479` (`isTimeout`).

## 10. Тест-план (юнит, без живого API-ключа; fake `AnthropicClientLike`)

1. **text-путь:** `text` (join'') + `usage` со всеми токенами, включая `cacheReadTokens`/`cacheWriteTokens`.
2. **structured-путь:** `req.toolSchema` → в body один forced tool + `tool_choice`; из ответа извлекается `tool_use.input` в `structured`; ответ без `tool_use` → `structured === undefined`.
3. **correction:** `req.correction` задан → `system` в body равен correction; не задан → `system` в body отсутствует.
4. **max_tokens:** `req.maxTokens` есть → он; нет, но есть `defaultMaxTokens` → он; нет ни того ни другого → `bad_request` без обращения к сети (fake.create не вызван).
5. **model:** пустой `req.model` → `bad_request` без сети.
6. **ошибки:** каждая строка таблицы §9 → корректные `code`/`retryable`.
7. **options:** `maxRetries: 0` присутствует в переданных `options`; `signal` проброшен.
8. **инвариант-импорт:** `core/`, `index.ts`, `node.ts` не содержат импорта `@anthropic-ai/sdk` (grep-тест).
9. **фабрика-fallback (если применим путь без per-request maxRetries):** fake с `maxRetries: 2` → фабрика бросает; без поля / `0` → ok.

## 11. Known limitations

- Correction-call ядра шлёт тот же `input` + correction, но **не** передаёт предыдущий невалидный вывод модели — модель не «видит», что именно исправлять. Это limitation **ядра** (stage 1), не адаптера; фиксируется, не чинится в Spec B.

## 12. Версионирование / зависимости

- Пакет: minor bump `0.2.0` → `0.3.0` (early stage; новый опциональный API, контракт ядра не тронут). Фиксируется в README/CHANGELOG.
- Конфиг-версия не меняется (контракт `LlmCaller`/`LlmRequest`/`LlmResponse` не тронут).
- README: раздел про подключение адаптера (`pnpm add @kir-str/llm-gateway @anthropic-ai/sdk`, `new Anthropic({ maxRetries: 0 })`, `createAnthropicLlmCaller`).
- `tsconfig.build.json`/сборка включают `src/anthropic.ts`; typecheck/build требуют установленного `@anthropic-ai/sdk` (devDependency).
- Обновить doc-comment `LlmCaller` в `packages/gateway/src/core/types.ts` (см. §8) — правка **только текста** комментария, сигнатуры/типы не трогаются.

## 13. Открытые вопросы для этапа реализации

1. Точный мажор `@anthropic-ai/sdk` — по установленной версии/lock.
2. Верифицировать по исходнику/типам SDK: наличие `RequestOptions.maxRetries` (определяет основной путь §8 vs fallback), точные имена/формы полей `usage` и `tool_use`-блока, имя поля default-экспорта для type-only импорта.
