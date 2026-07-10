# Guard contract/config hardening — инкремент A (enablers)

**Статус:** на ревью (brainstorming) — ожидает финального «ок» пользователя.
**Дата:** 2026-07-10.
**Этап:** 2, под-проект «security contract hardening», **инкремент A** (enablers). Разблокирует output judge (B) и guard sources (D). Порядок: A → B → C (telemetry hygiene + leakage-тесты) → D.
**Контракт ядра `Guard`:** **не меняется** (никакого `run(ctx, signal?)` — он в D, только если появятся внешние async-гварды). Все изменения — init-валидация + один рантайм баг-фикс.

## 1. Цель, скоуп, не-цели

Закрыть швы контракта/конфига гвардов, из-за которых судья (B) и внешние гварды (D) получились бы с дырами по таймаутам, конфигу и корректности output-пути. Всё — на init (fail-fast, инвариант «падение сразу и громко») плюс одна рантайм-правка (A4).

**Не-цели (в B/C/D):** сам судья; `Guard.run(signal)`; evidence-политика `omit|safe|full`; leakage-тесты по sink'ам; phase-aware pii (маскирующий выход built-in); полная discriminated-схема всех built-in гвардов; structured-маскировка; overlay `route` для custom-гвардов.

## 2. A1 — `deterministic: false ⇒ timeoutMs` обязателен

В `buildEntries` (`core/gateway.ts:206-231`), после материализации `guard`: если `guard.deterministic === false && (guard.timeoutMs === undefined || guard.timeoutMs < 1)` → `ConfigError`. Причина: `guards-runner.ts:37` использует **truthy-check** `guard.timeoutMs ? withTimeout(...) : await run` — при `undefined` **и при `0`** идёт прямой `await run` без гонки таймера, и недетерминированный гвард (в т.ч. будущий LLM-судья) подвешивает `runTurn` на неограниченное время. Поэтому проверка — на **положительный** effective `timeoutMs` (`>= 1`), не просто `!== undefined`. Проверка — на effective значении (после применения A3 к custom-гвардам). A5 закрывает `cfg.timeout_ms: 0` схемой, но напрямую инжектированный custom-гвард с `timeoutMs: 0` схему обходит — поэтому runtime-проверка `< 1` обязательна.

## 3. A2 — секция ≠ `guard.phase` → `ConfigError`

В `buildEntries`: `if (guard.phase !== phase) throw ConfigError` (где `phase` — секция, `'input'`/`'output'`). Ловит **встроенный** гвард в чужой секции: `pii` зашит `phase:'input'` (`guards/pii.ts:13`), в `guards.output` он молча сканировал бы вход. Custom-гварды уже защищены: `deps.guards.find(g => g.name===cfg.name && g.phase===phase)` (`gateway.ts:215`) — при несовпадении phase гвард «не найден» → существующий `ConfigError`.

## 4. A3 — custom-гварды: `cfg.timeout_ms` накладывать, `cfg.route` запретить

Ветка custom-гварда (`gateway.ts:214-220`):

- **`cfg.timeout_ms` — применять**, но **без мутации `deps.guards`** (aliasing-риск: один и тот же инжектированный гвард переиспользуется между gateway-инстансами/конфигами и получил бы скрытое состояние). Строить **effective guard делегирующим wrapper'ом**, не присваивать в объект из `deps.guards`:

  ```ts
  const effective: Guard =
    cfg.timeout_ms === undefined
      ? custom
      : {
          name: custom.name,
          phase: custom.phase,
          deterministic: custom.deterministic,
          transforms: custom.transforms,
          timeoutMs: cfg.timeout_ms,        // cfg.timeout_ms ?? custom.timeoutMs
          run: (ctx) => custom.run(ctx),
        };
  ```

  Wrapper реконструирует поля `Guard` + делегирует `run` — spread `{...custom}` **нельзя** (ломает прототипные методы у class-инстанс-гвардов). Точная форма — деталь плана; принцип: не мутировать инжектированный объект.

- **`cfg.route` — запретить для custom:** если у custom-гварда в конфиге задан `route` → `ConfigError` «route поддержан только для встроенных гвардов». Overlay-семантика неоднозначна (у встроенного pii `route` крепится к вердикту **условно, только при находке** — `pii.ts:34`; безусловный `route` из конфига форсировал бы сценарий на каждом ходу). Сейчас `route` валидируется referential-integrity для всех гвардов (`gateway.ts:108-110`), но `buildEntries` его к custom не применяет — убираем иллюзию. Overlay — в D, если внешним гвардам реально понадобится.

## 5. A4 — применить output-transform (баг-фикс), только `text`

`Verdict.transform` несёт **сам трансформированный текст** (не ключ реестра): pii возвращает `{ outcome:'PASS', transform: <masked text>, ... }` (`pii.ts:33`). Input применяет его: `gateway.ts:368 → ctx.input.text = agg.transform`. Output-путь этого **не делает** — non-reject ветка отдаёт `c.output?.text` сырым, `outAgg.transform` вычисляется, но игнорируется (`gateway.ts:587-597`). Без этого маскирующий output-гвард невозможен в принципе.

Правка — симметрия input'у: в non-reject ветке отдавать `outAgg.transform ?? c.output?.text ?? ''`.

**Ограничение (known limitation, документируем):** маскируется **только `output.text`**. `output.structured` не трансформируется — `Verdict.transform` строковый, а structured уходит в `TurnResult`/потребителю как есть. Sentinel-ПД может утечь через `structured`. Structured-маскировка — отдельный разговор (не в A; возможно вообще не нужна).

## 6. A5 — ужесточить ajv-схему (`core/config-schema.ts`)

Точечно, **без превращения схемы в полный реестр гвардов**.

**Элементы `guards.input[]`/`guards.output[]` — остаются открытыми по умолчанию** (guard-specific ключи `patterns`/`rules`/`mask`/`per_day` намеренно произвольны — `config-schema.ts:29`), но:
- `required: ['name']`;
- типы общих ключей: `name: string`, `on_error: enum('reject'|'degrade')`, `timeout_ms: integer, minimum: 1` (ужесточение до `>=1`: `timeout_ms:0` формально «задан», но `guards-runner.ts:37` truthy-check его отключает — это подрывает A1), `reject_template: string`, `route: string`;
- `additionalProperties` **не** закрывать.

**Targeted discriminated-схема для `name: 'limits'`** (единственный built-in, где опечатка выключает cost-control инвариант — дневной кап `per_day.hard_cap_usd` живёт в открытом элементе limits-гварда: `gateway.ts:194,196`, `limits.ts:15,31`): для элемента с `name === 'limits'` добавить `then`, где:
- `per_day`: `additionalProperties: false`, разрешены только `hard_cap_usd` и `soft_warning_usd`, оба `number`, `minimum: 0`;
- общие ключи всё ещё валидируются общим слоем.

Это **не** полная discriminated-схема всех built-ins — только targeted hardening `limits.per_day`.

**Топ-секция `config.limits`** (`config-schema.ts:94` сейчас просто `type:'object'`): дать схему — `per_request: { additionalProperties:false, properties:{ max_cost_usd:number } }`, `prices: type:'object'` (ключи-модели произвольны — открыто), `additionalProperties:false` на самом `limits`. Ловит опечатки топ-уровня (`per_requst` и т.п.).

**`routing.rules`** (`config-schema.ts:95` — `type:'array'` без схемы элементов): дать схему элемента по **фактическим** полям (тип `{ when?: { flags_any: string[] }; scenario?: string; default?: string }`): `when` (`object`, `additionalProperties:false`, `flags_any: array<string>` required), `scenario: string`, `default: string`, `additionalProperties:false`. (`escalate_to_model` — поле `RetryRule`, `config-schema.ts:43`, **не** routing; в схему routing не входит.)

## 7. Файлы

- `packages/gateway/src/core/gateway.ts` — `buildEntries` (A1/A2/A3), outputStage non-reject ветка (A4).
- `packages/gateway/src/core/config-schema.ts` — A5.
- `packages/gateway/package.json` + `README.md` + `CHANGELOG.md` — версии (§10).
- `examples/entitlements-basic/*` — fold-in follow-up типчека (§10).

## 8. Ошибки

A1/A2/A3(route)/A5 — init-time `ConfigError` (существующий класс; `createGateway` — единственное место, бросающее исключения). A4 — рантайм-поведение (применение transform к выдаче). Штатные ходы `runTurn` по-прежнему не бросают.

## 9. Тесты

- **A1:** конфиг с `deterministic:false`-гвардом (custom из `deps.guards`) без `timeoutMs` → `createGateway` бросает `ConfigError`; **инжектированный custom-гвард с `timeoutMs: 0`** (обходит схему) → тоже `ConfigError` (проверка `< 1`); с `timeoutMs >= 1` — ок.
- **A2:** `pii` в `guards.output` → `ConfigError` (секция≠phase).
- **A3:** custom-гвард с `cfg.route` → `ConfigError`; `cfg.timeout_ms` применён к custom-гварду **без мутации исходного объекта** (проверить: `deps.guards[0].timeoutMs` не изменился; effective соблюдает таймаут — наблюдаемо через timeout-поведение в runGuards).
- **A4:** кастомный **трансформирующий output-гвард** (fixture; встроенного, маскирующего выход, нет) → выдача содержит `transform`-текст, не сырой `output.text`. Тест-документация: `structured` уходит немаскированным (known limitation).
- **A5:** ajv отвергает — `hard_cap_uds` внутри `guards.input[].per_day` (name:'limits'); элемент гварда без `name`; `timeout_ms: 0` в элементе гварда (нарушает `minimum:1`); опечатку топ-уровня (`normalize.max_input_charss` — `normalize` закрыт, `config-schema.ts:86`; `limits.per_requst`). Принимает валидный конфиг + произвольные guard-specific ключи у не-limits гвардов.

## 10. Версионирование и follow-up

- Формально **ужесточающий** инкремент: конфиги с опечатками и `deterministic:false`-гварды без таймаута, «работавшие» ранее, начнут падать на init. Конфиг `version` **`1.1.0 → 1.2.0`** (семантика валидации). Пакет `@kir-str/llm-gateway` **`0.4.0 → 0.5.0`** (ломающее в minor допустимо до 1.0.0 — зафиксировать строкой в CHANGELOG/README). См. [[versioning]].
- **Fold-in follow-up:** `examples/entitlements-basic` падает `pnpm typecheck` без предварительного `build` зависимого пакета (пре-существующее, из entitlements-PR). Закрыть здесь же (типчек примера против исходников / build-before-typecheck в gate / исключить examples из workspace-typecheck) — см. [[llm-gateway-followup-examples-typecheck]].

## 11. Инварианты

1. Контракт `Guard` не меняется (`run(ctx)` без signal).
2. Init-валидация fail-fast: невалидный конфиг → `ConfigError` из `createGateway`, `runTurn` штатно не бросает.
3. `deps.guards` не мутируется — effective guard через wrapper.
4. Output-transform применяется к `text`; `structured` не маскируется (документированное ограничение).
5. ajv не закрывает guard-specific ключи произвольных гвардов; `limits.per_day` — targeted-исключение.

## 12. Вне скоупа A

Судья (B); `Guard.run(signal)` и evidence-политика и leakage-тесты (C/D); phase-aware pii; structured-маскировка; overlay `route` для custom; полная discriminated-схема всех built-in гвардов; детальная prices-схема (ключи-модели произвольны — остаётся открытым `type:'object'`); precompile/ReDoS pattern-engine и телеметрия конфликтов route (отдельные мелочи вне под-проекта).
