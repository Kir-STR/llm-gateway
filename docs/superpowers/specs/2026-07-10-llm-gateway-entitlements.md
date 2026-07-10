# Entitlements — server-bound scope-примитив (`@kir-str/entitlements`)

**Статус:** на ревью (brainstorming) — ожидает финального «ок» пользователя.
**Дата:** 2026-07-10.
**Этап:** 2, под-проект «entitlements / server-bound scope» (второй по ценности после provider adapter; Spec A/B смержены — PR #4, #5).
**Контракт ядра `@kir-str/llm-gateway`:** **не меняется.** Пакет standalone, gateway не импортирует. Связан со security-инвариантом «Доверенный контекст vs недоверенный ввод» (`.claude/rules/architectural-invariants.md`).

## 1. Цель

Дать проектному коду **server-bound scope-примитив**: единый auditable chokepoint для доступа к данным/тулам, в котором scope резолвится **только из доверенного серверного контекста** (`meta` / сессия / замыкание) и **никогда** из model-controlled значений (`input`, `output`, `structured`, аргументы модели). Пакет владеет **механикой** chokepoint'а; **модель авторизации** (что такое scope, resource, кто кому разрешён) остаётся project-defined.

Threat model (из инварианта): prompt injection → cross-tenant/cross-section доступ. Enforcement данных/тулов — не задача gateway core; это отдельный слой, который данный пакет и закрывает на уровне библиотеки.

### Почему отдельный пакет, а не часть gateway

В текущем ядре **нет tool-слоя и нет data-access**: пайплайн — guards → router → scenario (`stub`/`llm`/`custom`) → structured → delivery; `LlmCaller` шлёт модели только текст хода, `meta` в `LlmRequest` не проходит (регресс `packages/gateway/tests/trusted-context.test.ts`). Точки «модель запрашивает данные/тул» внутри ядра пока не существует — enforcement'у не к чему подключаться. Реальные обращения к данным живут в проектном коде (`LlmCaller`-замыкание, `customScenario`, RAG). Правильная точка контроля — **там, где происходит доступ**, а не на границе хода. Отсюда: библиотека, которую проект оборачивает вокруг своего доступа. Решение roadmap: «проектировать отдельным пакетом, чтобы не протащить auth/RAG в gateway core».

## 2. Скоуп и не-цели

**Формулировка направления (зафиксировано в brainstorming):**

> `packages/entitlements` v1 — runtime-agnostic библиотека server-bound scope-примитивов и guarded-обёрток для проектного data/tool access. Не интегрируется в gateway core, не добавляет tool-слой, не выводит scope из model-controlled значений. Scope резолвится только из trusted server context (`meta` / серверная сессия / замыкание) и применяется в chokepoint'е доступа.

> v1 не даёт enforcement, если проект обходит обёртки. Ценность — единый auditable примитив/chokepoint, на который проектный код стандартизируется сейчас и который переиспользует будущая tool-layer интеграция.

**Anti-goals v1:**

- Без RBAC/ABAC, без claims/capabilities-матчера, без policy-DSL. Rule-of-three не выполнен (один известный потребитель) — обобщённая модель авторизации = premature abstraction.
- Без tenant/section в публичном API — это доменные понятия (инвариант «пакет не знает домена»). Живут только в примерах.
- Без зависимости от `@kir-str/llm-gateway`.
- Без `node:*` (runtime-agnostic зона, как `core/`).
- Без `guardAccess()`-обёртки функций (форма A) — второй стиль и вопросы композиции аргументов; добавляется поверх `bindScope` позже при повторной потребности.
- Без `auditFailureMode` — добавляется опцией позже без слома API, когда появится compliance-требование «нет audit → deny».
- Без `redactResource`-хука — маскирование `resource` = ответственность project-owned `AuditSink`.

## 3. Публичный API

Единственный примитив — **scope-bound context**. `S`/`R`/`O` project-defined через генерики.

```ts
export function bindScope<S, R = unknown, O = string>(
  scope: S,
  policy: EntitlementsPolicy<S, R, O>,
): Entitlements<R, O>;

export interface Entitlements<R, O> {
  access<T>(resource: R, operation: O, thunk: () => Promise<T> | T): Promise<T>;
}

export interface EntitlementsPolicy<S, R, O> {
  /** Project-defined предикат. Может быть sync или async. */
  canAccess(scope: S, resource: R, operation: O): boolean | Promise<boolean>;
  /** Опциональный аудит; project-owned sink. */
  audit?: AuditSink<R, O>;
  /** Безопасный ярлык scope для audit. НИКОГДА не сырой scope в audit — только этот ярлык. */
  scopeLabel?: (scope: S) => string;
}

export interface AuditSink<R, O> {
  record(entry: AuditEntry<R, O>): void | Promise<void>;
}

export interface AuditEntry<R, O> {
  decision: 'allow' | 'deny';
  operation: O;
  /** Project-defined; маскирование — ответственность sink (см. §6). */
  resource: R;
  /** Из policy.scopeLabel; отсутствует, если scopeLabel не задан. */
  scopeLabel?: string;
  /** Только при decision === 'deny'. */
  reason?: 'policy_denied' | 'policy_error';
}

export class EntitlementsDenied extends Error {
  constructor(
    reason: 'policy_denied' | 'policy_error',
    operation: unknown,
    options?: { cause?: unknown },
  );
  readonly reason: 'policy_denied' | 'policy_error';
  /** operation как её передал проект; тип стёрт до unknown (Error-класс не generic). */
  readonly operation: unknown;
  // `resource` не принимается конструктором и не хранится (v1) — иначе логгер,
  // сериализующий Error целиком, утечёт ПД. message generic: `Access denied`.
  // `cause` (из options) сохраняется только при reason === 'policy_error'.
}
```

**Ключевое структурное свойство:** `scope` **не является аргументом `access`**. Он захвачен в замыкании `bindScope`, вызванном один раз на серверной границе хода из trusted source. У `input`/`output`/`structured`/аргументов модели **нет канала** его переопределить — гарантия по конструкции, а не по дисциплине. Это превращает правило «не брать scope из модели» из дисциплины в структуру.

## 4. Поток данных (жизненный цикл)

1. **Серверная граница хода:** проект берёт scope из **trusted source** (`meta`, сессия, auth-middleware) и вызывает `bindScope(scope, policy)` → `entitlements`.
2. **Проектный доступ:** `LlmCaller`-замыкание / `customScenario` / RAG на каждое обращение вызывает `entitlements.access(resource, op, thunk)`.
3. **`access` решает:**
   - `await canAccess(scope, resource, op)`:
     - `true` → `await audit?.record({ decision: 'allow', … })` → `return await thunk()`.
     - `false` → `await audit?.record({ decision: 'deny', reason: 'policy_denied', … })` → `throw new EntitlementsDenied('policy_denied', operation)`.
   - `canAccess` **бросил** → **fail-closed**: `await audit?.record({ decision: 'deny', reason: 'policy_error', … })` → `throw new EntitlementsDenied('policy_error', operation, { cause })`. Ошибка в оценке политики = запрет, не разрешение.
4. **`thunk` бросил** (реальный доступ упал) — ошибка проксируется **как есть** (не оборачивается в `EntitlementsDenied`). Это не denial; audit уже записал `allow`.

Audit фиксирует **authorization-решение**, не исход `thunk`: `allow` пишется в момент решения (до `thunk`); упавший `thunk` audit не переписывает.

## 5. Обработка ошибок

- **deny → `throw EntitlementsDenied`** (fail-closed), не `Result`-возврат — проигнорировать нельзя.
- **`canAccess`-throw → deny** с `reason: 'policy_error'`, оригинал в `cause`.
- **`thunk`-throw → проброс** нетронутым.
- **`EntitlementsDenied.message`** — generic (`Access denied`), **без `resource`** (тот может нести ПД). На catch resource у проекта есть (он его передал в `access`) и он ушёл в audit sink.
- **`cause` не санитизируется пакетом.** `cause` приходит из project-owned `canAccess` и теоретически может содержать что угодно (включая ПД/секреты). Пакет гарантирует только, что **сам** не добавляет `scope`/`resource` в `message` или поля `EntitlementsDenied`; за содержимое своей брошенной ошибки отвечает проект. Та же граница гарантии, что в security-инварианте: фреймворк держит своё чисто, но не полицирует project-owned код.

## 6. Секреты и audit (secret-hygiene инвариант)

- В audit **никогда не уходит сырой `scope`** (может держать токены/tenant-секреты) — только `scopeLabel?` (project-функция, напр. `s => s.tenantId`). Структурная гарантия.
- `resource` project-defined → его маскирование — ответственность **project-owned `AuditSink`**. Пакет не знает, что в resource чувствительно, и не выдумывает эвристику. Документируется в README.
- `EntitlementsDenied` не несёт `resource` (см. §5) — защита от логгеров, сериализующих Error целиком.

### Audit-failure семантика (v1 дефолт)

- `AuditSink.record` → `void | Promise<void>`; `access` **await'ит** запись до `thunk` на allow (детерминированный порядок; sync-sink → no-op await).
- **audit-сбой best-effort: не меняет allow/deny решение.** Sink бросил → ошибка **проглатывается** (документировано); доступ решается только политикой. Обоснование: audit — сам канал репортинга, перебрасывать некуда; fail-closed на audit-сбой — policy-решение, не механика.
- Расширяемость: `auditFailureMode: 'ignore' | 'deny'` добавляется опцией в `policy` позже без слома API (см. anti-goals).

## 7. Упаковка и структура

- Новый workspace-пакет `@kir-str/entitlements`, версия `0.1.0`. Короткое имя намеренно — standalone-дизайн не тянет зависимость от gateway; связь видна по `packages/entitlements` + README.
- `type: module`, ESM, `exports` только `.` (`types` + `import`), `files: ["dist"]`.
- **Zero runtime dependencies** (чистая логика). devDeps: `vitest`, TypeScript через корень.
- tsconfig extends `tsconfig.base.json` (strict, NodeNext, ES2022, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`). Build: `tsconfig.build.json` (`outDir: dist`, `rootDir: src`) → `.js` + `.d.ts`.
- Скрипты как у gateway: `build` / `typecheck` / `test`.

**Файлы `src/`:**

- `types.ts` — контракт: `EntitlementsPolicy`, `Entitlements`, `AuditSink`, `AuditEntry`.
- `errors.ts` — `EntitlementsDenied`.
- `entitlements.ts` — `bindScope` + `access`-механика.
- `index.ts` — публичные ре-экспорты.

(При малом объёме `types`/`errors` могут слиться в `entitlements.ts` — решить при реализации по фактическому размеру; API-поверхность от этого не меняется.)

**Note по `exactOptionalPropertyTypes`:** опциональные поля (`policy.audit`, `policy.scopeLabel`, `AuditEntry.scopeLabel`/`reason`) при сборке entry либо присутствуют со значением, либо не добавляются вовсе (не `undefined`-присваивание).

## 8. Тесты (по инвариантам, не под вывод)

- **deny-by-default:** policy запрещает → `EntitlementsDenied`, **thunk не вызван** (spy).
- **allow:** thunk вызван ровно раз, значение возвращено.
- **async `canAccess`** (Promise) — обе ветки.
- **`canAccess`-throw:** fail-closed deny, thunk не вызван, `cause` сохранён, `reason: 'policy_error'`.
- **`thunk`-throw:** ошибка проксируется, не оборачивается в `EntitlementsDenied`.
- **audit-hygiene:** сырой scope-sentinel (секрет) отсутствует во всех audit-payload'ах и в `EntitlementsDenied.message`/сериализации Error — стиль как `trusted-context.test.ts`. `scopeLabel` присутствует, когда задан. (В этом тесте sentinel **не** кладётся в брошенный `canAccess`-`cause` — пакет `cause` не санитизирует, см. §5; проверяем только, что пакет сам не добавляет scope.)
- **audit-failure best-effort:** sink `record` бросает → на allow доступ **проходит** (thunk вызван, значение вернулось); на deny — `EntitlementsDenied` (решение не изменилось).
- **audit-порядок:** на allow `record('allow')` вызван **до** `thunk`.
- **import-zone инвариант:** в `src/**` нет `node:*` (стиль `packages/gateway/tests/no-sdk-import.test.ts`).

## 9. Пример-потребитель

Отдельный workspace-пакет `examples/entitlements-basic`, зависит от `@kir-str/entitlements` (и опц. `@kir-str/llm-gateway` как потребитель). **Сам пакет entitlements gateway не импортирует** — направление зависимостей соблюдает инвариант «адаптеры не импортируют друг друга».

Показывает правильный chokepoint: `customScenario` (или RAG-like функция) получает `TurnContext.meta`, делает `bindScope(scopeFromMeta, policy)`, затем `access(resource, 'read', () => fakeGetDoc(id))` — allow и deny ветки с печатью audit. Двойная польза: документация quick-start + смоук-тест.

## 10. Инварианты

1. `scope` резолвится только из trusted server context; в `access` не передаётся — model-controlled значения структурно не могут его подменить.
2. deny-by-default, fail-closed (включая `canAccess`-throw).
3. Сырой `scope` не попадает в audit и в `EntitlementsDenied`; только `scopeLabel`.
4. Пакет не знает домена — модель авторизации (scope/resource/предикат) project-defined; tenant/section только в примерах.
5. Standalone: не импортирует `@kir-str/llm-gateway`. Runtime-agnostic: без `node:*`.
6. Audit-сбой не меняет allow/deny решение (v1 best-effort).

## 11. Вне скоупа v1

Tool-слой в gateway core; server-bound scope enforcement внутри пайплайна; RBAC/ABAC/claims-матчер; `guardAccess()`-сахар; `auditFailureMode`; `redactResource`; интеграция с `TelemetrySink` gateway; HTTP/сессии/middleware.
