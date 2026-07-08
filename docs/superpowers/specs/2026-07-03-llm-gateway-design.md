# Дизайн: `@kir-str/llm-gateway`, этап 1

Дата: 2026-07-03. Статус: утверждён на дизайн-ревью.

## Цель

Переиспользуемый скелет обработки одного хода LLM-чата как чистая библиотека (npm-пакет):
нормализация входа → параллельные быстрые гварды → агрегатор вердиктов → роутер сценариев →
LLM-вызов со structured-output и декларативными retry → выходные гварды → роутер выдачи →
телеметрия на каждом шаге. Пакет проектно-агностичен и config-driven: все доменные вещи
(паттерны, пороги, тексты заглушек, тиры моделей, correction-промпты) приходят конфигом.
Промпты, тулы, RAG, сессии, FSM, HTTP-слой, стриминг — остаются в проектах-потребителях.

## Утверждённые решения дизайн-ревью

1. **Рантайм-агностичное ядро.** Entry point `.` не импортирует `node:*`; вся Node-специфика
   (файловый конфиг-лоадер, JSONL-sink телеметрии, файловое хранилище дневных лимитов) —
   в отдельном entry point `./node`. Ядро работает в Node 22+, браузере и edge.
2. **Адаптер `@anthropic-ai/sdk` — не в этапе 1.** В этапе 1 только интерфейс `LlmCaller`
   и фейковый caller в примере. Интерфейс проектируется с оглядкой на будущий адаптер
   (usage-токены, классифицированные retryable-ошибки, abort).
3. **Лицензия MIT** (copyright Kir-STR).
4. **README.ru.md не делаем в этапе 1** — только английский README, пока API нестабилен.
5. **Форма API — фасад-оркестратор**: `createGateway(config, deps)` → `gateway.runTurn(...)`.
   Стадии пайплайна — внутренние модули, наружу не экспортируются (экспорт позже — обратимое
   решение без ломки API).

## Структура монорепо

```
llm-gateway/
  pnpm-workspace.yaml               # packages: packages/*, examples/*
  package.json                      # private; скрипты lint / typecheck / test / format:check
  tsconfig.base.json                # strict, NodeNext, ES2022
  eslint.config.js                  # flat config
  .prettierrc
  LICENSE                           # MIT, Kir-STR
  README.md                         # EN: описание, mermaid-схема пайплайна, quick start, early stage
  packages/
    gateway/                        # @kir-str/llm-gateway
      package.json                  # exports: "." (ядро) и "./node"
      src/
        index.ts                    # публичный API ядра
        node.ts                     # Node-only API
        core/                       # gateway, guards-runner, aggregate, router, retry,
                                    # structured, delivery, config-schema, telemetry, templates,
                                    # pattern-engine
        guards/                     # normalize (пре-стадия), injection, pii, limits
        node/                       # config-file loader, jsonl-sink, file-limits-store
      tests/
      README.md                     # контракт Guard, формат конфига, словарь событий, встраивание
  examples/
    minimal/                        # private workspace-пакет: конфиг + фейковый LlmCaller + прогон
```

Место под `packages/entitlements` зарезервировано workspace-глобом, каталог не создаётся.

**Зависимости runtime:** `ajv`, `ajv-formats` (ядро — валидация конфига), `yaml` (только `./node`).
Dev: typescript, vitest, eslint (flat) + typescript-eslint, prettier, @types/node.
Никаких SDK LLM-провайдеров в dependencies.

## Типы ядра (публичный API)

```ts
type Outcome = 'PASS' | 'DEGRADE' | 'REJECT';

type Verdict = {
  outcome: Outcome;
  code?: string;          // например E_INJECTION_DETECTED
  evidence?: unknown;     // безопасно для логов: никаких немаскированных ПД и секретов
  route?: string;         // форс-ключ сценария (например pii → short-circuit)
  transform?: string;     // изменённый текст входа (маскировка)
};

interface TurnContext {
  traceId: string;
  input: { raw: string; text: string };            // text — после normalize и transform
  output?: { text: string; structured?: unknown }; // заполнен на фазе output
  meta: Readonly<Record<string, unknown>>;         // проектные данные (sessionId и т.п.)
}

interface Guard {
  name: string;
  phase: 'input' | 'output';
  deterministic: boolean;  // true → без сети/LLM, обязан быть быстрым
  transforms?: boolean;    // объявляет право возвращать transform
  timeoutMs?: number;
  run(ctx: TurnContext): Promise<Verdict> | Verdict;
}

interface LlmCaller {
  call(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}
type LlmRequest = {
  modelRef: string;               // ключ тира из config.models
  model: string;                  // конкретное имя модели
  input: string;                  // текст хода; системный промпт и историю проект
                                  // собирает сам внутри своей реализации LlmCaller
  correction?: string;            // correction-промпт retry-политики
  maxTokens?: number;
  temperature?: number;
  toolSchema?: object;            // JSON Schema для structured output
};
type LlmResponse = {
  text?: string;
  structured?: unknown;           // сырой структурный ответ (до валидации ядром)
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
};
class LlmCallError extends Error {
  code: 'rate_limit' | 'overloaded' | 'server' | 'timeout' | 'auth' | 'bad_request' | 'unknown';
  retryable: boolean;             // rate_limit / overloaded / server → true; timeout → false
}

interface TelemetrySink {
  event(e: TelemetryEvent): void; // fire-and-forget; ошибки sink'а глотаются, ход не валят
}
type TelemetryEvent = {
  event: string;                  // из словаря событий
  traceId: string;
  configVersion: string;
  data: Record<string, unknown>;  // без немаскированных ПД; ts проставляет sink
};

interface LimitsStore {           // персистентность дневного счётчика лимитов
  load(): Promise<DailyState | null>;
  save(state: DailyState): Promise<void>;
}
type DailyState = { date: string; costUsd: number; requestCount: number }; // date — YYYY-MM-DD UTC

type ScenarioResult = { text: string; structured?: unknown };
type ScenarioHandler = (ctx: TurnContext) => Promise<ScenarioResult>; // kind: custom

type GatewayDeps = {
  llm: LlmCaller;
  telemetry: TelemetrySink;
  guards?: Guard[];                                  // кастомные гварды проекта
  customScenarios?: Record<string, ScenarioHandler>;
  limitsStore?: LimitsStore;                         // default: in-memory
  idGenerator?: () => string;                        // default: globalThis.crypto.randomUUID
};

function createGateway(config: GatewayConfig, deps: GatewayDeps): Gateway;
interface Gateway {
  runTurn(input: string, meta?: Record<string, unknown>): Promise<TurnResult>;
  close(): Promise<void>;         // финальный flush лимитов/телеметрии
}

type TurnResult = {
  traceId: string;
  outcome: 'delivered' | 'rejected' | 'failed';
  kind: 'llm' | 'stub' | 'custom';
  text: string;                   // финальный текст (ответ или отрендеренный шаблон)
  structured?: unknown;           // при structured_output
  scenario: string;
  flags: string[];                // degrade-флаги для логики проекта
  degradeReason?: 'upstream_unavailable' | 'cost_cap' | 'guard_error';
  usage: { inputTokens: number; outputTokens: number; costUsd: number; llmCalls: number };
};
```

## Поток `runTurn`

1. `turn_started` → генерация `traceId`.
2. **normalize** — синхронная пре-стадия, не гвард: trim, пустота, лимит длины.
   REJECT (`E_NORMALIZE_EMPTY` / `E_NORMALIZE_TOO_LONG`) — до запуска гвардов, отдаётся
   шаблон `normalize_reject`. Гварды видят уже нормализованный текст.
3. **Входные гварды параллельно** — `Promise.allSettled`, per-guard таймаут
   (`AbortSignal.timeout`-семантика; результат опоздавшего гварда игнорируется).
4. **Агрегатор**: любой hard REJECT → отказ (код и шаблон первого REJECT-гварда по порядку
   конфига; ключ шаблона — `reject_template` в конфиге гварда, у встроенных дефолты:
   injection → `injection_reject`, limits → `degrade`, pii → `pii_detected`);
   DEGRADE → флаги для роутера; `route` от гварда → форс-сценарий (приоритет над правилами);
   `transform` → подмена `ctx.input.text`.
5. **Роутер**: форс-route → иначе первое правило `routing.rules` по порядку
   (`flags_any`) → иначе `default`. Результат — сценарий: `stub` | `llm` | `custom`.
6. **Сценарий llm**: pre-check per-request бюджета (оценка worst-case стоимости по prices)
   → вызов `LlmCaller` (таймаут + транспортный retry по политике) → при `structured_output`:
   parse/validate по ajv-схеме с коррекционным retry → инкремент дневного счётчика по факту usage.
7. **Выходные гварды** (последовательность как у входных, phase `output`) — встроенный `policy`
   (regex deny/require + json_schema) + кастомные.
8. **Роутер выдачи**: PASS → deliver; hard REJECT → retry-политика `output_guard_rejected`
   (correction-промпт, опциональная эскалация модели) → при исчерпании stub `policy_reject`;
   DEGRADE → deliver с флагами.
9. `turn_completed`.

### Утверждённые решения по потоку

- **normalize — пре-стадия, не гвард.**
- **Не более одного гварда с `transforms: true` на фазу** — валидация в `createGateway`,
  громкое падение. Параллельные transform'ы одного входа корректно не сливаются; в этапе 1
  трансформирует только pii. Ослабление — потом, если понадобится.
- **Сбой/таймаут гварда** — per-guard `on_error: reject | degrade`. Дефолты: встроенные
  pii, injection, limits → `reject` (fail-closed: упавший pii-гвард не имеет права пропустить
  немаскированные ПД в LLM); кастомные → `degrade` (флаг `guard_error` + телеметрия).
- **Транспортный retry — в ядре**, декларативно; `LlmCaller` — тонкий однократный вызов
  с классифицированными ошибками. Timeout не ретраится.
- **BRANCH-ветвление по полям структурного ответа (уточняющий вопрос, низкая уверенность
  и т.п.) — вне пакета**: доменная интерпретация `structured` — на стороне проекта.
- Штатные отказы не бросают исключений из `runTurn` — это `outcome: 'rejected' | 'failed'`
  с текстом-шаблоном. Исключения — только из `createGateway` (невалидный конфиг/зависимости).

## Формат конфига

Ядро принимает объект `GatewayConfig`; валидация единой ajv JSON Schema при `createGateway`
(`additionalProperties: false` — опечатки не тонут), падение — сразу и громко.
`./node`-лоадер читает YAML/JSON с диска. Версия в имени файла (`gateway.v1.0.0.yaml`) —
конвенция; обязательна версия в поле `version`, она пишется в каждое telemetry-событие.

Полный пример:

```yaml
version: 1.0.0

models:                              # тиры; ссылки по ключу из сценариев и retry
  cheap:     { model: claude-haiku-4-5, max_tokens: 1024, temperature: 0.3 }
  expensive: { model: claude-sonnet-5, max_tokens: 2500, temperature: 0.3 }

normalize:
  max_input_chars: 4000

guards:
  input:
    - name: injection                # встроенный, pattern-engine
      on_error: reject
      timeout_ms: 50
      patterns:
        - { id: ignore_previous_en, kind: substring, pattern: 'ignore previous', case_sensitive: false, severity: hard }
        - { id: base64_chunk,       kind: regex, pattern: '[A-Za-z0-9+/]{200,}={0,3}', case_sensitive: true, severity: soft }
    - name: pii                      # встроенный, transforms: true
      on_error: reject
      rules: [ru_phone, email]       # встроенные наборы; свои — через patterns
      mask: { ru_phone: '[PHONE_MASKED]', email: '[EMAIL_MASKED]' }
      route: pii_short_circuit       # форс-сценарий при срабатывании
    - name: limits                   # встроенный: дневной cap через LimitsStore
      on_error: reject
      per_day: { hard_cap_usd: 10, soft_warning_usd: 5 }
    # кастомные гварды приходят кодом через deps.guards;
    # их конфиг — свободная секция custom: {...} по имени гварда
  output:
    - name: policy                   # встроенный, конфиг-дривен правила
      on_error: degrade
      rules:
        - { id: no_prompt_leak, kind: regex_deny,    pattern: '(?i)system prompt', severity: hard }
        - { id: has_disclaimer, kind: regex_require, pattern: 'consult a specialist', severity: soft }
        - { id: shape_ok,       kind: json_schema,   schema: { type: object, required: [answer] }, severity: hard }

limits:                              # общие лимиты стоимости
  per_request: { max_cost_usd: 0.15 }
  prices:                            # USD за MTok; cache_read = input*0.1, cache_write = input*1.25
    claude-haiku-4-5: { input: 1.0, output: 5.0 }
    claude-sonnet-5:  { input: 3.0, output: 15.0 }

routing:                             # порядок = приоритет; форс-route гварда — выше правил
  rules:
    - { when: { flags_any: [injection] }, scenario: cautious }
    - default: main
scenarios:
  main:              { kind: llm, model: expensive, structured_output: answer_v1 }
  cautious:          { kind: llm, model: cheap }
  pii_short_circuit: { kind: stub, template: pii_detected }
  # kind: custom, handler: <имя> → deps.customScenarios[имя]

structured_output:
  answer_v1:
    schema: { type: object, required: [answer, confidence],
              properties: { answer: { type: string }, confidence: { type: number } } }

retry:                               # max_attempts — число ПОВТОРОВ сверх первичной попытки
  - { trigger: llm_transport_error,    max_attempts: 2, backoff_ms: 250 }  # экспоненциальный
  - { trigger: structured_parse_failed, max_attempts: 1,
      correction_prompt: 'Previous reply failed schema validation. Reply strictly via the tool.' }
  - { trigger: output_guard_rejected,  max_attempts: 1,
      correction_prompt: 'Previous reply violated output policy. Follow the policy strictly.',
      escalate_to_model: expensive }

templates:                           # {{trace_id_short}} — единственная переменная
  llm_fail:         'Service temporarily unavailable. Code: {{trace_id_short}}'
  parse_fail:       'Could not process the reply. Code: {{trace_id_short}}'
  policy_reject:    'I cannot answer that directly. Code: {{trace_id_short}}'
  injection_reject: 'The request contains elements I cannot process.'
  normalize_reject: 'The message is too long or empty.'
  pii_detected:     'I do not store personal data.'
  degrade:          'Service is degraded, please try again later. Code: {{trace_id_short}}'
```

## Встроенные гварды

- **normalize (пре-стадия):** trim; пустой вход → `E_NORMALIZE_EMPTY`; длина >
  `max_input_chars` → `E_NORMALIZE_TOO_LONG` (сырой длинный текст в телеметрию не пишется).
- **injection:** общий pattern-engine (`substring` | `regex`, `case_sensitive`,
  `severity: hard|soft`). Любой hard-хит → REJECT `E_INJECTION_DETECTED`; только soft →
  DEGRADE (флаг `injection`); evidence — id сработавших паттернов (не текст входа).
- **pii:** встроенные наборы правил `ru_phone` (+7/8 с разделителями), `email`;
  маскирование всех вхождений (email первым, затем телефон). Срабатывание — это НЕ отказ:
  вердикт `outcome: 'PASS'` с `transform` (замаскированный текст) и `route` из конфига
  (short-circuit без LLM). evidence — только булевы флаги наличия (`phone: true`),
  никогда сырые значения. `on_error: reject` относится к сбою самого гварда.
- **limits:** дневной счётчик (UTC-роллинг) через `LimitsStore`; hard cap → REJECT
  (`degradeReason: 'cost_cap'`, stub-шаблон `degrade`), soft-порог → событие `cost_cap`
  один раз на пересечение. Per-request бюджет проверяется в LLM-стадии (worst-case
  оценка до вызова), фактическая стоимость считается по usage и инкрементирует счётчик.
  Битое/недоступное состояние стора — fail-closed (как hard cap).
- **policy (output):** `regex_deny` (матч → нарушение), `regex_require` (нет матча →
  нарушение), `json_schema` (валидация `structured`). hard → REJECT, soft → DEGRADE.

## Словарь telemetry-событий

Каждое событие несёт `traceId` и `configVersion`. В `data`:

| event | data |
|---|---|
| `turn_started` | `inputLen` |
| `normalize` | `outcome, code?, rulesApplied` |
| `guard_result` | `guard, phase, outcome, code?, durationMs, timedOut, errored, evidence?` |
| `guards_aggregated` | `decision, flags[], forcedRoute?, rejectCode?` |
| `route_decision` | `scenario, matchedRule` |
| `llm_call` | `modelRef, model, attempt, inTokens, outTokens, cacheReadTokens?, cacheWriteTokens?, latencyMs, outcome, errorCode?, costUsd` |
| `structured_parse` | `valid, attempt, code?, detail?` |
| `retry` | `trigger, attempt, maxAttempts, escalatedTo?` |
| `cost_cap` | `state: soft\|hard, dailyCostUsd, capUsd` |
| `delivery` | `kind, scenario, textLen` |
| `turn_completed` | `outcome, scenario, flags[], totalLatencyMs, totalCostUsd, degradeReason?` |

JSONL-адаптер (`./node`): строка = `{ts, event, traceId, configVersion, ...data}`,
append-only, дневная ротация файла. Модель событий рассчитана на будущий Langfuse-адаптер
(trace = ход; события с длительностями ложатся в spans/generations) без переделки интерфейса.

## Тесты (vitest, фейковый LlmCaller)

Юнит: каждый встроенный гвард; pattern-engine; шаблоны; конфиг-валидация (невалидный
конфиг падает при init); лимиты (роллинг, fail-closed).
Оркестрация: чистый PASS; hard-reject injection; soft-degrade → маршрут `cautious`;
pii short-circuit (LLM не вызван, в телеметрии только маскированное); retry-исчерпание
structured-парса → stub; output-reject → correction-retry с эскалацией → повторный reject
→ stub; транспортные 429/5xx → backoff → исчерпание → `upstream_unavailable`; таймаут
гварда → `on_error`-политика; hard cap → stub без LLM-вызова; два `transforms: true`
гварда → падение при init.

## Пример `examples/minimal`

Конфиг YAML + фейковый `LlmCaller` + прогон одного-двух ходов с печатью telemetry-событий.
Одновременно смоук-тест и документация quick start.

## Чистота публичного репо

Перед финалом — grep-проверка всего репо: никаких названий клиентских проектов и доменов,
локальных путей, доменно-специфичных строк. Всё доменное — только в примерах конфигов
с нейтральным содержимым.

## Вне скоупа этапа 1

Langfuse-адаптер; адаптер `@presidio-dev/hai-guardrails`; LLM-судья выхода (ядро уже
позволяет: это Guard с `deterministic: false`); адаптер `@anthropic-ai/sdk`;
auth/entitlements; HTTP-слой, стриминг, сессии, FSM.

## Инварианты

1. Пакет не знает домена проекта — всё доменное в конфиге.
2. Конфиг валидируется схемой при инициализации, падение — сразу и громко.
3. Версия конфига — в каждом telemetry-событии.
4. Телеметрия на каждом шаге, `traceId` сквозной.
5. В evidence и телеметрию никогда не попадают немаскированные ПД и секреты.
6. LLM — только за интерфейсом `LlmCaller`; SDK провайдеров не в runtime-зависимостях.
