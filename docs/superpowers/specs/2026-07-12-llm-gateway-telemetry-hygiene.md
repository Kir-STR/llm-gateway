# Telemetry hygiene — инкремент C

**Статус:** на ревью (brainstorming) — ожидает финального «ок» пользователя.
**Дата:** 2026-07-12.
**Этап:** 2, security-hardening **инкремент C** (после A/PR #8, B/PR #9). Предусловие для D (внешние guard-паки). Контракт `Guard` не меняется (`Verdict.evidence` остаётся `unknown` — structured-evidence-контракт `{safe,full}` отложен в D, если понадобится).

## 1. Цель, скоуп, не-цели

Закрыть утечку `evidence` в телеметрию (предусловие для внешних guard-паков D) + leakage-тесты по всем sink'ам + phase-aware pii (маскирующий выход — реальный потребитель output-transform из A4). Три части, одна тема — гигиена наружу (инвариант 5: немаскированные ПД/секреты не в evidence/телеметрию).

**Не-цели (в D/позже):** structured evidence-контракт `{safe,full}` (аддитивен, добавить если viability-check D покажет нужду внешним пакам); `Guard.run(signal)` (D); внешние guard-паки (D); последовательные output-гварды (сейчас параллельны — см. §5).

## 2. Evidence-политика — единый chokepoint

- **Один санитайзер на границе emit** — `sanitizeEvidence(evidence, policy)` (файл `core/sanitize-evidence.ts`). Оба `guard_result`-emit-сайта (`gateway.ts:442` input, `:663` output) прогоняют `r.verdict.evidence` через него. **Гвард о политике не знает** — иначе дисциплина размазывается по гвардам.
- Уровни:
  - **`full`** — evidence as-is.
  - **`omit`** — поля `evidence` в событии нет (`undefined`).
  - **`safe`** — рекурсивная санитизация:
    - `boolean` / `number` / `null` — сохранить;
    - `string` — заменить на фиксированный sentinel `'[omitted:string]'` (НЕ молчаливый дроп — shape объекта сохранён: видно «гвард положил строковое поле, политика вырезала» vs «гвард ничего не положил»);
    - `undefined` / function / symbol — вырезать (несериализуемы);
    - object — **ключи сохраняются**, рекурсия по значениям; array — рекурсия по элементам;
    - **cap глубины/размера**: глубина > 4 или число узлов > лимит → значение заменяется на `'[omitted:depth]'` / `'[omitted:size]'` (против bloat телеметрии от глубоко вложенного/огромного evidence).
- **Дефолты (в `buildEntries`):** built-in гвард → `full` (дисциплина evidence — собственность ядра, проверяется leakage-тестами §6); custom (`deps.guards`) → `safe` (чужой код по определению). Конфиг `evidence: 'omit'|'safe'|'full'` переопределяет per-guard.
- **Граница гарантии `safe` (threat model, как `meta` в architectural-invariants):** санитизируются **значения**, не **ключи объектов**. Небрежный/злонамеренный гвард может положить пользовательский текст в ключ (`{"a@b.co": true}`) — интроспекцией это не ловим (осознанный компромисс; ключи в практике code-authored). Leakage-тест фиксирует: встроенные гварды динамических (данных-производных) ключей не порождают.

## 3. Конфиг

Per-guard `evidence: 'omit' | 'safe' | 'full'` (опционально). ajv (`config-schema.ts`):
- Добавить `evidence: { enum: ['omit','safe','full'] }` в типы **общих** ключей `$defs.guardConfig` (открытые элементы — рядом с `on_error`/`timeout_ms`).
- **Добавить тот же `evidence` в обе ЗАКРЫТЫЕ discriminated-схемы** — `name:'limits'` (A5) и `name:'judge'` (B) `then.properties` (у них `additionalProperties:false`, иначе `evidence:'omit'` на них упадёт init-ошибкой ajv, противореча «переопределяет per-guard»). Оператор законно может хотеть `omit`/`safe` и на limits, и на judge.

`GuardEntry` получает resolved `evidencePolicy: 'omit'|'safe'|'full'` (в `buildEntries`: `cfg.evidence ?? (isBuiltIn(cfg.name) ? 'full' : 'safe')`), пробрасывается через `guards-runner`/`aggregate` до emit-сайтов.

## 4. Phase-aware pii

`createPiiGuard(cfg, phase)` — секция передаётся из `buildEntries` (уже знает `phase`; A2 требует совпадения `guard.phase === section`).
- **input** (текущее поведение): маскирует `ctx.input.text` → `transform`, опц. `route` (short-circuit до LLM).
- **output** (новое): маскирует `ctx.output.text` → `transform` (A4 доставляет маскированный текст), `outcome: PASS`, evidence `{email,phone}`. **`route` в output-pii → init `ConfigError`** (маршрутизация после LLM бессмысленна; дисциплина как A3).
- Тот же built-in `pii`; фабрика параметризуется секцией. `transforms:true` (A4: один трансформирующий output-гвард — проверка `transformers>1` уже есть).

## 5. Параллелизм output-гвардов (граница C, threat model)

`runGuards` = `Promise.all` (`guards-runner.ts:63`) — все гварды фазы бегут **параллельно** против одного `ctx.output.text`. Transform применяется **после** агрегации, только к **доставляемому** тексту (A4, `gateway.ts:618`). Следствие:

- Порядок output-гвардов в конфиге **не влияет** на то, что видит соседний гвард — output-pii и judge оба видят **сырой** (немаскированный) `output.text`.
- **Граница гарантии:** output-pii маскирует **доставляемый** выход, но НЕ то, что concurrent-гвард наблюдает или шлёт дальше. **Судья (или любой output-гвард с внешним вызовом) в одной фазе с output-pii отправляет НЕмаскированный `output.text` в свой внешний LLM.** Пары output-pii + external-LLM-судья это не решает в v1 (потребовало бы последовательных output-гвардов — вне C). Записать в README/threat model, чтобы ожидание «pii на выходе всё маскирует» не стало скрытым.

## 6. Judge reason (микро-правка)

Судья остаётся `evidence: {decision}` **навсегда** (не «до C»). В `guards/judge.ts` снять комментарий-обещание «→C» (заменить на «reason намеренно не форвардится в evidence/телеметрию»). C **не** реактивирует forward reason — политика даёт механизм, но у судьи reason — model-generated free-text, не форвардится по дизайну.

## 7. Leakage-тесты

Sentinel-ПД (email + phone форматы) прогоняется через ход; проверяется, что **не появляется ни в одном событии ни одного sink'а**:
- **jsonl-sink** (node) — sentinel не в записанных payload'ах.
- **Langfuse-адаптер** (смержен, PR #7) — sentinel не в вызовах клиента. Тривиально зелёный (адаптер whitelist-only, `guard_result` вообще не форвардит), но **фиксирует инвариант** против будущих расширений маппинга.
- `guard_result.evidence` под `safe`: custom-гвард с sentinel-текстом в evidence → в событии sentinel-текста нет (только `'[omitted:string]'`); под `full` встроенного — evidence проходит (дисциплина).
- **guard-error message**: custom-гвард **бросает** `Error(sentinel)` → sentinel не появляется ни в одном событии (verified: `guards-runner` не кладёт `err.message` в вердикт; тест фиксирует инвариант против регресса).
- `structured_parse.detail`: sentinel в structured-входе → не в `detail` (подтверждает path+constraint-only; заодно enum-ошибки ajv не тащат строковые значения схемы).
- Пути retry/эскалации (correction-повторы) — sentinel не просачивается ни на одной итерации.

## 8. Файлы

- Create: `packages/gateway/src/core/sanitize-evidence.ts` — `sanitizeEvidence(evidence, policy)`.
- Modify: `packages/gateway/src/core/gateway.ts` — оба `guard_result`-emit через санитайзер; `buildEntries` резолвит `evidencePolicy` + `createPiiGuard(cfg, phase)`; route-на-output-pii → ConfigError.
- Modify: `packages/gateway/src/guards/pii.ts` — phase-aware.
- Modify: `packages/gateway/src/core/config-schema.ts` — `evidence` в общих ключах **и** в закрытых схемах limits/judge.
- Modify: `packages/gateway/src/core/guards-runner.ts` (+ `aggregate.ts` при необходимости) — `GuardEntry`/outcome несёт `evidencePolicy` до emit.
- Modify: `packages/gateway/src/guards/judge.ts` — комментарий reason.
- Modify: `packages/gateway/README.md` + `CHANGELOG.md` — версии, evidence-политика (уровни/дефолты), safe-граница (ключи), output-pii (+ «structured НЕ маскируется», §5-параллелизм), availability.
- Tests: `sanitize-evidence` (unit), `leakage` (jsonl+langfuse+guard-error+structured+retry), `pii` (output-phase masking + route ConfigError), `config-schema` (evidence на open/limits/judge; невалидный enum).

## 9. Ошибки

`route` на output-pii → init `ConfigError`. Невалидный `evidence`-enum → ajv init-ошибка. Рантайм-поведение (`runTurn`) не меняется; санитизация — чистая функция на границе emit.

## 10. Версионирование

Аддитивно (новый опц. per-guard ключ `evidence` + pii-в-output). Пакет `@kir-str/llm-gateway` **`0.6.0 → 0.7.0`**; конфиг **`1.3.0 → 1.4.0`** (новая опц. поверхность). CHANGELOG/README.

## 11. Инварианты

1. Контракт `Guard`/`Verdict` не меняется (`evidence: unknown`).
2. Немаскированные ПД/секреты не уходят в телеметрию: `evidence` через `sanitizeEvidence` на границе emit; default custom→safe.
3. `safe` санитизирует значения, не ключи (документированная граница); строки → sentinel (не молчаливый дроп); cap глубины/размера.
4. Санитайзер — единственный chokepoint (оба guard_result-emit); гвард политику не знает.
5. Guard-error message не форвардится в телеметрию (verified + leakage-тест).
6. Output-pii маскирует доставляемый `output.text`, НЕ structured и НЕ то, что видят параллельные гварды (§5 граница).
7. Судья: `evidence:{decision}`, reason не форвардится (навсегда).

## 12. Вне скоупа C

structured evidence-контракт `{safe,full}`; `Guard.run(signal)`; внешние guard-паки (D); последовательные output-гварды / маскирование входа судьи; structured-output маскирование (A4 known limitation); санитизация ключей объектов evidence.
