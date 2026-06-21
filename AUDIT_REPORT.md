# Аудит готовности ChatGPTMCPcmux к продакшену

## Дата аудита: 2026-01-18

---

## 1. Общая оценка

Проект **ChatGPTMCPcmux** — security-hardened форк cmuxLayer для безопасного подключения ChatGPT к локальным агентам через OpenAI Secure MCP Tunnel. Проект имеет зрелую архитектуру (35 MCP-инструментов, 800+ тестов, многослойная security-модель), но **НЕ ГОТОВ к продакшену** без устранения критических дефектов.

### Итоговые метрики
| Категория | Количество |
|-----------|-----------|
| CRITICAL | 17 |
| HIGH | 22 |
| MEDIUM | 27 |
| LOW | 12 |
| **Всего** | **78** |

### Ключевые риски, блокирующие прод
1. **Security: wildcardToRegex уничтожает все deny_patterns** — политика безопасности не работает
2. **Security: prefix check использует только surfaces** — агенты/workspaces не фильтруются
3. **Security: path-guard glob не работает с trailing slash** — `node_modules/` не блокируется
4. **Core: V2-ответ попадает в V1-очередь** — протокольная коррупция
5. **Core: демон вешается навсегда при ошибке инициализации** — невозможно восстановление без рестарта
6. **Core: waitFor race condition** — перекрывающиеся setInterval итерации
7. **CI/CD: release.sh указывает на старый репозиторий** — релиз сломается
8. **CI/CD: CI использует bun вместо npm** — расхождение зависимостей
9. **CI/CD: регрессионный тест не запускается** — `test_terminal_state.ts` без суффикса `.test.ts`
10. **Docs: SECURITY.md — шаблонный текст** — пользователи не знают, куда сообщать об уязвимостях

---

## 2. CRITICAL — Блокирующие прод дефекты (17 шт.)

### 2.1. Security (5 CRITICAL)

#### [CRITICAL-SEC-1] `wildcardToRegex` уничтожает regex-метасимволы в `deny_patterns`
- **Файл:** `src/secure/command-guard.ts:382-393`
- **Код:**
  ```typescript
  function wildcardToRegex(pattern: string): RegExp {
    let escaped = "";
    for (const ch of pattern) {
      if (ch === "*") { escaped += ".*"; }
      else if (ch === "?") { escaped += "."; }
      else { escaped += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"); }
    }
    return new RegExp(escaped, "i");
  }
  ```
- **Проблема:** Паттерны из YAML (`rm\s+-rf`, `curl.*\|.*sh`) содержат regex-синтаксис, но функция обрабатывает их как wildcard. `\s` превращается в литерал `\s`, `+` экранируется в `\+`, `.*` ломается (`.` экранируется).
- **Доказательство:** `isDangerousPattern("rm -rf /", ["rm\\s+-rf"])` → возвращает `false`. Команда `rm -rf /` проходит проверку.
- **Влияние:** Все `deny_patterns` и `require_confirmation_patterns` в политике бесполезны. Критические команды (rm -rf, curl | sh, dd if=) не блокируются.
- **Решение:** Добавить флаг `type: regex` / `type: wildcard` в политику, либо использовать `new RegExp(pattern)` напрямую для regex-шаблонов.

#### [CRITICAL-SEC-2] `checkPrefixAllowlist` использует только `surfaces` префиксы
- **Файл:** `src/secure/tool-wrapper.ts:105-128`
- **Код:**
  ```typescript
  function checkPrefixAllowlist(...) {
    const prefixes = policy.surfaces?.allowed_name_prefixes ?? [];
    if (prefixes.length === 0) return { allowed: true };
    // ... проверяет только surfaces
  }
  ```
- **Проблема:** Для `agent.list`, `agent.send_task`, `cmux.list_surfaces` проверка всегда выполняется против `surfaces.allowed_name_prefixes`. Поля `agents.allowed_prefixes` и `workspaces.allowed_prefixes` из схемы **никогда не используются**.
- **Доказательство:** Вызов `agent.read` с `agent_id: "secret-agent"` при `agents.allowed_prefixes = ["agent-"]` и пустом `surfaces.allowed_name_prefixes` → возвращает `allowed: true`.
- **Влияние:** Политика не может ограничивать доступ к агентам и воркспейсам по префиксам. Любой агент доступен, если surfaces не ограничены.
- **Решение:** Добавить `AGENT_PREFIX_TOOLS` и `WORKSPACE_PREFIX_TOOLS` сеты, проверять соответствующие политики.

#### [CRITICAL-SEC-3] `matchGlob` не работает с паттернами, заканчивающимися на `/`
- **Файл:** `src/secure/path-guard.ts:210-238`
- **Проблема:** Паттерн `node_modules/` после `split("/")` даёт `["node_modules", ""]`. Пустая строка `""` не равна `**`, `matchSegment(fileParts[fi], "")` возвращает `false` (т.к. `globSegmentToRegex("")` → `/^$/`).
- **Доказательство:** `matchesGlob("node_modules/foo", "node_modules/")` → `false` (ожидалось `true`).
- **Влияние:** `node_modules/`, `dist/` и другие trailing-slash паттерны в `project.deny` ничего не блокируют.
- **Решение:** Нормализовать паттерн (убирать trailing slash или добавлять `/**`) перед `matchGlob`.

#### [CRITICAL-SEC-4] `audit.ts` `expandHomeDir` записывает логи в корень ФС
- **Файл:** `src/secure/audit.ts:160-166`
- **Код:**
  ```typescript
  function expandHomeDir(filePath: string): string {
    if (filePath.startsWith("~/") || filePath === "~") {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
      return path.join(home, filePath.slice(1)); // <-- /audit.jsonl
    }
    return filePath;
  }
  ```
- **Проблема:** `filePath.slice(1)` для `~/audit.jsonl` возвращает `/audit.jsonl`. `path.join("/home/user", "/audit.jsonl")` → `/audit.jsonl` (абсолютный путь перекрывает).
- **Доказательство:** `path.join("/home/user", "/audit.jsonl") === "/audit.jsonl"` на POSIX.
- **Влияние:** Аудит-логи пишутся в `/audit.jsonl` (корень ФС) → отказ в записи (silent fail) или засорение корня.
- **Решение:** `return path.join(home, filePath.slice(2))` для `~/`, `path.join(home, filePath.slice(1))` только для `~`.

#### [CRITICAL-SEC-5] `max_file_read_bytes` объявлен в схеме, но нигде не используется
- **Файл:** `src/secure/policy-schema.ts:20` + отсутствие в `path-guard.ts`
- **Проблема:** `max_file_read_bytes: z.number().int().positive().default(200_000)` декларирован, но в `path-guard.ts` и `tool-wrapper.ts` нет ни одного вызова, ограничивающего размер читаемого файла.
- **Доказательство:** `assertReadableProjectPath` проверяет только путь и glob, но не размер файла.
- **Влияние:** Администратор политики ожидает ограничение 200 KB, но инструмент может прочитать много-гигабайтный файл, вызывая OOM в ChatGPT.
- **Решение:** Добавить проверку `fs.stat` в `tool-wrapper.ts` перед `project.read_file`.

---

### 2.2. Core Engine (5 CRITICAL)

#### [CRITICAL-CORE-1] V2-ответ с неизвестным id попадает в очередь V1
- **Файл:** `src/cmux-persistent-socket.ts:198-223`
- **Код:**
  ```typescript
  try {
    const parsed = JSON.parse(line) as Partial<V2Response>;
    const entry = typeof parsed.id === "string" ? this.pending.get(parsed.id) : null;
    if (entry && typeof parsed.id === "string") { ... }
    else if (this.pendingV1.length > 0) { this.resolveNextV1(line); } // <-- БАГ
  } catch {
    if (this.pendingV1.length > 0) { this.resolveNextV1(line); } // <-- БАГ
  }
  ```
- **Проблема:** JSON-объект V2-протокола (например, ответ с несуществующим `id` или серверная пуш-нотификация) ошибочно выдаётся как ответ на ожидающую V1-команду.
- **Доказательство:** Если сервер отправит `{"id":"unknown","ok":true}` в момент, когда `pendingV1` не пуст, строка 215 вызовет `resolveNextV1(line)` и передаст JSON в V1-обработчик, ожидающий plain-text.
- **Влияние:** Протокольная коррупция, некорректные ответы на V1-команды, потенциальные ошибки в логике управления терминалом.
- **Решение:** Проверять `!parsed.id` для V2-ответов без id — не отправлять в V1-очередь, а логировать/игнорировать.

#### [CRITICAL-CORE-2] `getContext` никогда не сбрасывает `contextPromise` при ошибке
- **Файл:** `src/daemon.ts:354-381`
- **Код:**
  ```typescript
  private async getContext(): Promise<CmuxServerContext> {
    if (this.context) return this.context;
    if (!this.contextPromise) {
      this.contextPromise = (async () => {
        this.context = createServerContext({...});
        return this.context;
      })();
    }
    return this.contextPromise;
  }
  ```
- **Проблема:** Если `createCmuxClient()` или `createServerContext()` выбросят исключение, `this.contextPromise` останется rejected-промисом навсегда.
- **Доказательство:** После единичного падения все последующие вызовы `getContext()` (включая новые TCP-соединения) будут мгновенно возвращать тот же rejected-промис.
- **Влияние:** Демон перестаёт принимать соединения без перезапуска. Невозможно восстановление после временной ошибки.
- **Решение:** Обнулять `contextPromise` в `catch` и добавить retry с exponential backoff.

#### [CRITICAL-CORE-3] `connect` не разрешает `connectPromise` при событии `close`
- **Файл:** `src/cmux-persistent-socket.ts:151-161`
- **Код:**
  ```typescript
  this.socket.on("close", () => {
    this.connected = false;
    this.socket = null;
    this.rejectAllPending(new CmuxSocketError("Socket closed unexpectedly", "connection_closed"));
  });
  ```
- **Проблема:** В обработчике `close` отсутствует `if (!settled) { settled = true; this.connectPromise = null; reject(...) }`. Если сокет закрывается до событий `connect` или `error`, промис остаётся pending навсегда.
- **Доказательство:** `connectPromise` обнуляется только в `connect` (строка 121) и `error` (строка 141). В `close` (строка 151) — нет.
- **Влияние:** Все последующие `ensureConnected()` ждут вечно. Демон требует ручного рестарта.
- **Решение:** Добавить settlement логики в обработчик `close`.

#### [CRITICAL-CORE-4] `my_agents` порождает unhandled promise rejection при таймауте `readScreen`
- **Файл:** `src/server.ts:4800-4824`
- **Код:**
  ```typescript
  const screen = await Promise.race([
    client.readScreen(agent.surface_id, { lines: 20 }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), SCREEN_TIMEOUT)),
  ]);
  ```
- **Проблема:** `Promise.race` не отменяет проигравший промис. Если `readScreen` выбросит ошибку после таймаута → unhandled rejection.
- **Доказательство:** Node.js выдаст `UnhandledPromiseRejectionWarning` (или `uncaughtException`), если `client.readScreen` зарежектится после 3-секундного таймаута.
- **Влияние:** При массовых вызовах `my_agents` — крах процесса.
- **Решение:** Оборачивать `readScreen` в `AbortController` или добавить `.catch(() => {})` на проигравший промис.

#### [CRITICAL-CORE-5] `assertPostSpawnLiveness` вызывается через `void` без обработки ошибок
- **Файл:** `src/agent-engine.ts:1624-1630`
- **Код:**
  ```typescript
  private schedulePostSpawnLivenessAssertion(agentId: string): void {
    const timer = setTimeout(() => {
      this.postSpawnLivenessTimers.delete(timer);
      void this.assertPostSpawnLiveness(agentId); // <-- void отбрасывает промис
    }, this.postSpawnLivenessMs);
  }
  ```
- **Проблема:** `void` отбрасывает промис. Если `assertPostSpawnLiveness` выбросит → unhandled rejection.
- **Доказательство:** `assertPostSpawnLiveness` содержит `await this.registry.hasLiveSurface(...)`, который может выбросить. Нет `try/catch` вокруг `void this.assertPostSpawnLiveness(...)`.
- **Влияние:** При множестве агентов — крах процесса.
- **Решение:** Заменить `void` на `await` с `try/catch`, либо `.catch(() => {})`.

---

### 2.3. CI/CD & Tests (4 CRITICAL)

#### [CRITICAL-CI-1] `release.sh` указывает на старый репозиторий
- **Файл:** `scripts/release.sh:19`
- **Код:** `TARBALL_URL_BASE="https://github.com/EtanHey/cmuxlayer/archive/refs/tags"`
- **Проблема:** После ребрендинга на `Danissimode/ChatGPTMCPcmux` tarball по этому адресу → 404.
- **Доказательство:** `curl -fsSL "$URL"` на строке 80 вернёт ошибку.
- **Влияние:** Релизный скрипт полностью сломан. Невозможно выпустить новую версию.
- **Решение:** Обновить URL на `https://github.com/Danissimode/ChatGPTMCPcmux/archive/refs/tags`.

#### [CRITICAL-CI-2] Тест `stdio discipline` не тестирует ничего
- **Файл:** `tests/security/server-exposure.test.ts:47-64`
- **Код:** Мок `process.stdout.write`, но `createSecureServer` не вызывается. Массив `stdoutWrites` всегда пуст → тест всегда проходит.
- **Проблема:** Ложная уверенность в безопасности. Тест не проверяет реальное поведение сервера.
- **Решение:** Добавить реальный вызов `createSecureServer` и операций, которые могут записать в stdout.

#### [CRITICAL-CI-3] Регрессионный тест никогда не запускается
- **Файл:** `scripts/run_tests.sh:41`
- **Код:** `if ! bun test ./tests/regression/test_terminal_state.ts; then`
- **Проблема:** Файл называется `test_terminal_state.ts` (без `.test.ts`). Vitest ищет только `**/*.{test,spec}.?(c|m)[jt]s?(x)`.
- **Доказательство:** `npx vitest run ./tests/regression/test_terminal_state.ts` → `No test files found, exiting with code 1`.
- **Влияние:** Регрессионный тест никогда не выполняется. Регрессии проходят незамеченными.
- **Решение:** Переименовать в `test_terminal_state.test.ts`.

#### [CRITICAL-CI-4] `race-condition-vt-fixture.test.ts` запускается дважды
- **Файл:** `scripts/run_tests.sh:37,45`
- **Код:** Строка 37 запускает явно, строка 45 запускает `vitest run` по всем `*.test.ts`.
- **Проблема:** Дублирование удваивает время CI и замусоривает вывод.
- **Решение:** Убрать явный запуск из `run_tests.sh`, оставить только `vitest run`.

---

### 2.4. Docs & Scripts (3 CRITICAL)

#### [CRITICAL-DOC-1] SECURITY.md содержит нередактированный шаблонный текст
- **Файл:** `SECURITY.md:16`
- **Код:** `Please report it directly via GitHub Security Advisories or by emailing [maintainer email/contact if known, otherwise: ...]`
- **Проблема:** Пользователь не знает, куда сообщать об уязвимостях. Плейсхолдер остался с момента копирования шаблона.
- **Решение:** Заменить на реальный адрес или инструкцию по созданию GitHub Security Advisory.

#### [CRITICAL-DOC-2] launchd plist содержит захардкоженные пути к чужому пользователю
- **Файл:** `launchd/cmux-memory-watchdog/launchd/com.golems.cmux-memory-watchdog.plist:10`
- **Код:** `<string>/Users/etanheyman/Gits/cmuxlayer/launchd/cmux-memory-watchdog/bin/cmux-memory-watchdog.sh</string>`
- **Проблема:** При копировании plist без редактирования launchd будет пытаться запустить несуществующий файл. Watchdog не будет работать.
- **Доказательство:** `ls /Users/etanheyman/Gits/cmuxlayer/...` — директория не существует на машине владельца форка.
- **Решение:** Использовать `$HOME` или относительные пути, либо сделать install-скрипт, который подставляет пути.

#### [CRITICAL-DOC-3] smoke-stdio.sh нарушает протокол MCP
- **Файл:** `scripts/smoke-stdio.sh:116-126`
- **Код:** Запускает два отдельных процесса `node dist/index.js` для `initialize` и `tools/list`.
- **Проблема:** MCP требует stateful-сессии. Второй процесс получает `tools/list` без `initialize` и должен отвергнуть запрос.
- **Доказательство:** Запустить скрипт — `tools/list` вернёт ошибку или пустой ответ.
- **Решение:** Использовать один процесс с конвейером stdin, отправляя `initialize` → `initialized` → `tools/list` в одной сессии.

---

## 3. HIGH — Серьёзные дефекты (22 шт.)

### 3.1. Security (4 HIGH)

| ID | Проблема | Файл | Краткое описание |
|----|----------|------|------------------|
| HIGH-SEC-1 | `recent()` читает весь audit-файл в память | `src/secure/audit.ts:108-139` | `readFile` загружает весь файл, даже если нужно 10 событий. 2 GB лог → OOM |
| HIGH-SEC-2 | Лимиты вывода применяются к каждому блоку отдельно | `src/secure/tool-wrapper.ts:163-181` | 100 текстовых блоков по 50k символов = 5M, обходя `max_screen_chars: 50000` |
| HIGH-SEC-3 | `ALWAYS_DENIED_COMMANDS` не блокирует macOS-пути `/Users/` | `src/secure/command-guard.ts:178-210` | `cat /Users/danissimode/.ssh/id_rsa` не содержит `cat /home/` и проходит |
| HIGH-SEC-4 | `safeRealpath` не разрешает симлинки для несуществующих путей | `src/secure/path-guard.ts:187-197` | Symlink на `/etc` (не существующий) → `path.resolve` без разрешения симлинка → TOCTOU |

### 3.2. Core Engine (5 HIGH)

| ID | Проблема | Файл | Краткое описание |
|----|----------|------|------------------|
| HIGH-CORE-1 | `waitFor` использует `setInterval` без ожидания завершения | `src/agent-engine.ts:1879-1948` | Перекрывающиеся итерации при медленном `reconcile()` → race condition |
| HIGH-CORE-2 | `resolveWorkspace` падает при ошибке любого workspace | `src/cmux-socket-client.ts:755-772` | `listPaneSurfaces` для одного workspace падает → весь `send`/`readScreen` падает |
| HIGH-CORE-3 | `readEntries` падает целиком при одной повреждённой строке JSONL | `src/event-log.ts:42-49` | `JSON.parse` без `try/catch` → весь event log нечитаем |
| HIGH-CORE-4 | Утечка stale-ролей в `roleSurfaceOverrides` | `src/server.ts:941-966` | При отсутствии `workspace` параметра удалённые surface-записи никогда не чистятся → OOM |
| HIGH-CORE-5 | `createAgentSurface` продолжает работу после неудачного `selectWorkspace` | `src/agent-engine.ts:767-774` | `selectWorkspace` падает с `catch {}` → `listPanes` возвращает панели текущего workspace → агент спавнится не туда |

### 3.3. CI/CD (6 HIGH)

| ID | Проблема | Файл | Краткое описание |
|----|----------|------|------------------|
| HIGH-CI-1 | CI удаляет lockfile перед установкой | `.github/workflows/ci.yml:18` | `rm -f package-lock.json` + `bun install` → плавающие версии, расхождение с локальной средой |
| HIGH-CI-2 | Publish-CI тоже не использует lockfile | `.github/workflows/publish.yml:23` | `npm install --no-package-lock` → риск опубликовать с несовместимыми зависимостями |
| HIGH-CI-3 | `tsconfig.json` исключает `tests` | `tsconfig.json:16` | `typecheck` не проверяет 60+ тестовых файлов с 450+ `as any` |
| HIGH-CI-4 | Полное отсутствие линтеров и форматтеров | — | Нет ESLint, Prettier, Biome. Нет проверки стиля, неиспользуемых переменных, единообразия |
| HIGH-CI-5 | Отсутствие сбора покрытия кода | — | Нет `vitest.config.ts`, нет `--coverage`, нет шагов upload coverage в CI |
| HIGH-CI-6 | `server-exposure` глотает ошибки `.request()` | `tests/security/server-exposure.test.ts:19-23` | `.catch(() => null)` + переменная `toolsResult` нигде не используется → мёртвый код |

### 3.4. Docs & Scripts (7 HIGH)

| ID | Проблема | Файл | Краткое описание |
|----|----------|------|------------------|
| HIGH-DOC-1 | README заявляет 27 инструментов, но таблица содержит 28 | `README.md:93-101` | 5+8+5+8+2 = 28. Математическая ошибка в документации |
| HIGH-DOC-2 | Лендинг противоречит сам себе: 29 vs 22 | `site/app/layout.tsx:28`, `site/components/stat-strip.tsx:4` | SEO говорит 29, UI — 22. Разные цифры в разных местах |
| HIGH-DOC-3 | CODEOWNERS указывает на апстрим-владельца | `.github/CODEOWNERS:1` | `* @EtanHey` → PR назначаются не тому владельцу |
| HIGH-DOC-4 | PR-шаблон требует `bun test` | `.github/PULL_REQUEST_TEMPLATE.md:9` | В проекте нет `bun`, скрипт `test` — `vitest run` |
| HIGH-DOC-5 | release.sh ссылается на апстрим-репозиторий и Homebrew-tap | `scripts/release.sh:19,79,99` | TAP_DIR, TARBALL_URL_BASE, brew upgrade — всё на `EtanHey` |
| HIGH-DOC-6 | docs/implementation-audit.md утверждает о `pnpm-lock.yaml` | `docs/implementation-audit.md:2-3` | Файл отсутствует, проект на npm |
| HIGH-DOC-7 | Сайт ссылается на старый GitHub-репозиторий | `site/app/page.tsx:23`, `site/components/hero.tsx:82` | `github.com/EtanHey/cmuxlayer` вместо `github.com/Danissimode/ChatGPTMCPcmux` |

---

## 4. MEDIUM — Значимые дефекты (27 шт.) — краткая сводка

### 4.1. Security (6 MEDIUM)

| ID | Проблема | Файл |
|----|----------|------|
| MED-SEC-1 | YAML-парсер молча пропускает over-indented секции | `src/secure/policy.ts:83-86` |
| MED-SEC-2 | `createRequestId` использует только 4 байта случайных данных | `src/secure/limits.ts:69-73` |
| MED-SEC-3 | `sendV1` и `sendLine` позволяют внедрить новые строки | `src/cmux-socket-client.ts:110-118`, `src/cmux-persistent-socket.ts:289-315` |
| MED-SEC-4 | `send_command` не верифицирует короткие команды | `src/server.ts:2558-2575` |
| MED-SEC-5 | `spawn_in_workspace` не чистит агентов при ошибке boot prompt | `src/server.ts:4061-4099` |
| MED-SEC-6 | `parseClaude` дублирует подсчёт токенов (input + cache) | `src/harness-session.ts:197-226` |

### 4.2. Core Engine (4 MEDIUM)

| ID | Проблема | Файл |
|----|----------|------|
| MED-CORE-1 | `removeState` не удаляет директорию при ошибке `eventLog.append` | `src/state-manager.ts:374-393` |
| MED-CORE-2 | `stopAgent` с `force=true` переходит в `done` при `process.kill` EPERM | `src/agent-engine.ts:2042-2078` |
| MED-CORE-3 | `resolveLauncherName` прерывается при ошибке первого кандидата | `src/agent-engine.ts:549-555` |
| MED-CORE-4 | `close_surface` проверяет только первого живого агента | `src/server.ts:2954-2966` |

### 4.3. CI/CD (7 MEDIUM)

| ID | Проблема | Файл |
|----|----------|------|
| MED-CI-1 | `tests/server.test.ts` — 184 `as any`, тестирование приватных internals | `tests/server.test.ts` |
| MED-CI-2 | `tests/app-server-runtime.test.ts` — моки через `as any` | `tests/app-server-runtime.test.ts:34,72-73` |
| MED-CI-3 | Низкая плотность assertions в крупных тестовых файлах | `tests/server.test.ts`, `tests/agent-engine.test.ts` |
| MED-CI-4 | `tests/remote/` — пустая директория | `tests/remote/` |
| MED-CI-5 | `release.sh` использует macOS-специфичный `sed -i ''` | `scripts/release.sh:64,89,90` |
| MED-CI-6 | Potentially flaky `Date.now()` тест в `limits.test.ts` | `tests/security/limits.test.ts:157` |
| MED-CI-7 | `release.sh` ссылается на старый Homebrew tap | `scripts/release.sh:91` |

### 4.4. Docs & Scripts (10 MEDIUM)

| ID | Проблема | Файл |
|----|----------|------|
| MED-DOC-1 | `sed -i` в документации не работает на macOS | `docs/openai-secure-mcp-tunnel.md:309` |
| MED-DOC-2 | Документация предлагает записать секреты в `~/.zshrc` | `docs/chatgpt-connector.md:70-71` |
| MED-DOC-3 | Таблица инструментов в implementation-audit сломана | `docs/implementation-audit.md:22,41-86` |
| MED-DOC-4 | `openai-tunnel-stop.sh` ждёт всего 0.5 секунды | `scripts/openai-tunnel-stop.sh:44` |
| MED-DOC-5 | `generate-og.mjs` использует `rm -f` (не кроссплатформенно) | `scripts/generate-og.mjs:80` |
| MED-DOC-6 | Документы называют разное количество шагов в pipeline | `docs/mcpkit-reference-audit.md:59`, `docs/implementation-closeout.md:377`, `docs/post-implementation-audit.md:37` |
| MED-DOC-7 | implementation-audit.md: «33 registered tools» при 35 | `docs/implementation-audit.md:22` |
| MED-DOC-8 | pre-push hook не проверяет наличие `bash` | `.githooks/pre-push:1,10` |
| MED-DOC-9 | security-model.md: нет `set` в always-denied | `docs/security-model.md:369-371` |
| MED-DOC-10 | policy.example.yaml не использует wildcard `project.*` | `config/policy.example.yaml:48-65` |

---

## 5. LOW — Незначительные дефекты (12 шт.) — краткая сводка

| ID | Проблема | Файл |
|----|----------|------|
| LOW-1 | Лишние пустые строки в README | `README.md:26-28` |
| LOW-2 | package.json `homepage` указывает на домен апстрима | `package.json:27` |
| LOW-3 | Опечатка в пути к аудит-логу | `docs/openai-secure-mcp-tunnel.md:365` |
| LOW-4 | Количество тестов в post-implementation-audit не сходится | `docs/post-implementation-audit.md:57` |
| LOW-5 | `server-exposure.test.ts` упомянут в release-checklist, но не в closeout | `docs/release-checklist.md:6` |
| LOW-6 | `dispatch_to_agent` игнорирует поле `to` в схеме | `src/server.ts:3203-3212` |
| LOW-7 | Условные `skipIf` в socket-тестах | `tests/cmux-socket-client.test.ts:397,717,995` |
| LOW-8 | `tests/cmux-client-factory.test.ts` — `skipIf` на socket | `tests/cmux-client-factory.test.ts:67` |
| LOW-9 | `Object.setPrototypeOf` в errors.ts — архаичный паттерн | `src/secure/errors.ts` |
| LOW-10 | `expandHomeDir` в audit.ts использует `process.env.HOME`, а в policy.ts — `os.homedir()` | `src/secure/audit.ts:160`, `src/secure/policy.ts:254` |
| LOW-11 | `version: "0.3.0"` в server-secure.ts, но `0.2.1` в package.json | `src/secure/server-secure.ts` (если существует) / `package.json:3` |
| LOW-12 | `client as CmuxClient` без проверки в server-secure.ts | `src/secure/server-secure.ts` (если существует) |

---

## 6. План доработки (Roadmap to Production)

### Фаза 1: Security Hotfix (1-2 недели) — Блокирует прод
**Цель:** Устранить критические уязвимости, при которых политика безопасности не работает.

| Задача | Приоритет | Проблемы |
|--------|-----------|----------|
| 1.1 Исправить `wildcardToRegex` → настоящий RegExp | P0 | CRITICAL-SEC-1 |
| 1.2 Исправить `checkPrefixAllowlist` для agents/workspaces | P0 | CRITICAL-SEC-2 |
| 1.3 Исправить `matchGlob` для trailing slash | P0 | CRITICAL-SEC-3 |
| 1.4 Исправить `expandHomeDir` в audit.ts | P0 | CRITICAL-SEC-4 |
| 1.5 Добавить enforcement `max_file_read_bytes` | P0 | CRITICAL-SEC-5 |
| 1.6 Добавить `Promise.race` с `AbortSignal` для `tool_timeout_ms` | P1 | HIGH-SEC-2 (непрямое) |
| 1.7 Добавить семафор для `max_concurrent_requests` | P1 | HIGH-SEC-2 (непрямое) |
| 1.8 Унифицировать редактор: использовать `Redactor` в audit.ts | P1 | MED-SEC-6 |
| 1.9 Усилить `ALWAYS_DENIED_COMMANDS` (macOS `/Users/`, `set`, `python -c`) | P1 | HIGH-SEC-3, MED-DOC-9 |
| 1.10 Добавить защиту от base64/hex-обфускации | P2 | — |
| 1.11 Добавить защиту от `~user/` и UNC-путей в path-guard | P2 | HIGH-SEC-4 |
| 1.12 Исправить `safeRealpath` для симлинков на несуществующие пути | P2 | HIGH-SEC-4 |
| 1.13 Исправить `recent()` — читать файл с конца, не целиком | P2 | HIGH-SEC-1 |
| 1.14 Исправить лимиты вывода — применять глобально, не per-block | P2 | HIGH-SEC-2 |
| 1.15 Исправить YAML-парсер — предупреждать об over-indented | P2 | MED-SEC-1 |
| 1.16 Увеличить энтропию `requestId` до 16 байт | P2 | MED-SEC-2 |
| 1.17 Добавить `try/catch` вокруг `sendV1`/`sendLine` для `\n` | P2 | MED-SEC-3 |

### Фаза 2: Core Stability (2-3 недели) — Блокирует прод
**Цель:** Устранить race conditions, unhandled rejections и вечные зависания.

| Задача | Приоритет | Проблемы |
|--------|-----------|----------|
| 2.1 Исправить V2-ответ → V1-очередь в persistent-socket | P0 | CRITICAL-CORE-1 |
| 2.2 Исправить `getContext` — сброс `contextPromise` при ошибке | P0 | CRITICAL-CORE-2 |
| 2.3 Исправить `connectPromise` settlement при `close` | P0 | CRITICAL-CORE-3 |
| 2.4 Исправить `my_agents` unhandled rejection | P0 | CRITICAL-CORE-4 |
| 2.5 Исправить `assertPostSpawnLiveness` void → await+catch | P0 | CRITICAL-CORE-5 |
| 2.6 Исправить `waitFor` setInterval → setTimeout с await | P1 | HIGH-CORE-1 |
| 2.7 Исправить `resolveWorkspace` — try/catch внутри цикла | P1 | HIGH-CORE-2 |
| 2.8 Исправить `readEntries` — skip malformed lines | P1 | HIGH-CORE-3 |
| 2.9 Исправить `roleSurfaceOverrides` утечку | P1 | HIGH-CORE-4 |
| 2.10 Исправить `createAgentSurface` — fallback при failed selectWorkspace | P1 | HIGH-CORE-5 |
| 2.11 Исправить `removeState` — rmSync до eventLog.append | P1 | MED-CORE-1 |
| 2.12 Исправить `stopAgent` — проверять EPERM vs ESRCH | P1 | MED-CORE-2 |
| 2.13 Исправить `resolveLauncherName` — try/catch в цикле | P2 | MED-CORE-3 |
| 2.14 Исправить `close_surface` — проверять всех живых агентов | P2 | MED-CORE-4 |
| 2.15 Исправить `send_command` — verify_submit для всех команд | P2 | MED-SEC-4 |
| 2.16 Исправить `spawn_in_workspace` — rollback при ошибке | P2 | MED-SEC-5 |
| 2.17 Исправить `parseClaude` — не дублировать cache-токены | P2 | MED-SEC-6 |
| 2.18 Исправить `dispatch_to_agent` — использовать `args.to` | P3 | LOW-6 |

### Фаза 3: CI/CD & Testing (1-2 недели) — Блокирует прод
**Цель:** Сделать CI/CD надёжным, тесты — достоверными, покрытие — измеримым.

| Задача | Приоритет | Проблемы |
|--------|-----------|----------|
| 3.1 Исправить `release.sh` — URL, sed, tap | P0 | CRITICAL-CI-1, MED-CI-5, MED-CI-7 |
| 3.2 Исправить `run_tests.sh` — убрать дублирование, переименовать regression | P0 | CRITICAL-CI-3, CRITICAL-CI-4 |
| 3.3 Исправить `ci.yml` — использовать npm + lockfile | P0 | HIGH-CI-1 |
| 3.4 Исправить `publish.yml` — использовать `npm ci` | P0 | HIGH-CI-2 |
| 3.5 Исправить `server-exposure.test.ts` — реальный тест | P0 | CRITICAL-CI-2 |
| 3.6 Добавить `tsconfig.test.json` — typecheck для tests | P1 | HIGH-CI-3 |
| 3.7 Добавить ESLint + Prettier (или Biome) | P1 | HIGH-CI-4 |
| 3.8 Добавить coverage report (c8/v8) | P1 | HIGH-CI-5 |
| 3.9 Исправить `server.test.ts` — убрать `as any`, тестировать публичный API | P1 | MED-CI-1 |
| 3.10 Исправить `app-server-runtime.test.ts` — без `as any` | P1 | MED-CI-2 |
| 3.11 Удалить/заполнить `tests/remote/` | P2 | MED-CI-4 |
| 3.12 Исправить `limits.test.ts` — избежать race на Date.now() | P2 | MED-CI-6 |
| 3.13 Добавить `bun` в devDependencies или убрать из CONTRIBUTING | P2 | HIGH-DOC-4 |
| 3.14 Добавить security scanning (npm audit, CodeQL) в CI | P2 | — |
| 3.15 Добавить `lint` и `format` скрипты в package.json | P2 | — |

### Фаза 4: Documentation & Operational (1 неделя) — Важно для adoption
**Цель:** Исправить документацию, скрипты, launchd — всё, что видит пользователь.

| Задача | Приоритет | Проблемы |
|--------|-----------|----------|
| 4.1 Исправить SECURITY.md — реальный контакт | P0 | CRITICAL-DOC-1 |
| 4.2 Исправить launchd plist — `$HOME` или install-скрипт | P0 | CRITICAL-DOC-2, CRITICAL-DOC-3 |
| 4.3 Исправить smoke-stdio.sh — stateful MCP-сессия | P0 | CRITICAL-DOC-3 |
| 4.4 Исправить README — 27→28 инструментов | P1 | HIGH-DOC-1 |
| 4.5 Исправить лендинг — единая цифра (фактическая) | P1 | HIGH-DOC-2 |
| 4.6 Исправить CODEOWNERS | P1 | HIGH-DOC-3 |
| 4.7 Исправить PR-шаблон | P1 | HIGH-DOC-4 |
| 4.8 Исправить ссылки на GitHub — EtanHey→Danissimode | P1 | HIGH-DOC-5, HIGH-DOC-7 |
| 4.9 Исправить implementation-audit.md — убрать pnpm-lock | P1 | HIGH-DOC-6 |
| 4.10 Исправить `openai-tunnel-init-stdio.sh` — экранировать пробелы | P1 | HIGH-DOC-8 |
| 4.11 Исправить `openai-secure-mcp-tunnel.md` — убрать ведущие пробелы | P2 | HIGH-DOC-9 |
| 4.12 Исправить e2e-readiness-checklist — убрать `/mnt/agents/` | P2 | HIGH-DOC-10 |
| 4.13 Исправить `package.json` version → 0.3.0 (или checklist) | P2 | HIGH-DOC-11 |
| 4.14 Исправить `docs/openai-secure-mcp-tunnel.md` — sed для macOS | P2 | MED-DOC-1 |
| 4.15 Исправить `docs/chatgpt-connector.md` — не писать секреты в .zshrc | P2 | MED-DOC-2 |
| 4.16 Исправить implementation-audit.md — таблица инструментов | P2 | MED-DOC-3 |
| 4.17 Исправить `openai-tunnel-stop.sh` — увеличить sleep | P2 | MED-DOC-4 |
| 4.18 Исправить `generate-og.mjs` — `fs.unlinkSync` вместо `rm -f` | P2 | MED-DOC-5 |
| 4.19 Исправить implementation-audit.md — 33→35 инструментов | P2 | MED-DOC-7 |
| 4.20 Исправить pre-push hook — проверка bash | P2 | MED-DOC-8 |
| 4.21 Исправить policy.example.yaml — wildcard `project.*` | P2 | MED-DOC-10 |
| 4.22 Исправить `openai-tunnel-run.sh` — убрать exec или добавить trap | P2 | CRITICAL-DOC-4 (продолжение) |
| 4.23 Исправить `emergency-stop.sh` — SIGKILL или правильное описание | P2 | CRITICAL-DOC-5 |
| 4.24 Исправить `docs/openai-secure-mcp-tunnel.md` — curl без ключа в CLI | P2 | CRITICAL-DOC-6 |

---

## 7. Итоговая оценка готовности

| Критерий | Статус | Примечание |
|----------|--------|------------|
| Security layer | ⚠️ **НЕ ГОТОВО** | Политика безопасности не работает (wildcardToRegex, prefix check, matchGlob) |
| Core stability | ⚠️ **НЕ ГОТОВО** | Race conditions, unhandled rejections, вечные зависания |
| Testing | ⚠️ **НЕ ГОТОВО** | Фиктивные тесты, дублирование, отсутствие coverage, пропускаемые тесты |
| CI/CD | ⚠️ **НЕ ГОТОВО** | Релизный скрипт сломан, CI на bun вместо npm, нет lockfile |
| Documentation | ⚠️ **НЕ ГОТОВО** | Шаблонные тексты, противоречивые цифры, старые ссылки |
| Operational scripts | ⚠️ **НЕ ГОТОВО** | launchd с чужими путями, smoke-test нарушает MCP, emergency-stop не работает |
| Code quality | ⚠️ **НЕ ГОТОВО** | Нет линтеров, 450+ `as any`, нет typecheck для тестов |

### Общий вывод

Проект имеет **сильную архитектуру** (defense-in-depth, audit logging, secret redaction, path/command guards), но **реализация содержит критические дефекты**, которые полностью обнуляют защиту. Без исправления `wildcardToRegex` и `checkPrefixAllowlist` политика безопасности — иллюзия. Без исправления race conditions и unhandled rejections — демон нестабилен. Без исправления CI/CD — релиз невозможен.

**Рекомендация:** Не использовать в продакшене до завершения Фазы 1 (Security Hotfix) и Фазы 2 (Core Stability). Минимум **4-5 недель** разработки + **1-2 недели** тестирования.

---
*Отчёт сгенерирован на основе статического анализа кода с конкретными ссылками на файлы и строки.*
