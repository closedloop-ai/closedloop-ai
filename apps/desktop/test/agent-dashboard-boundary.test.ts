import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(appDir, "src");
const bootEntries = [
  "src/main/index.ts",
  "src/main/app.ts",
  "src/main/window.ts",
].map((relativePath) => path.join(appDir, relativePath));
const rendererOtelBoundaryEntries = [
  "src/main/app-otel-runtime.ts",
  "src/main/app-otel-runtime-lifecycle.ts",
  "src/main/renderer-otel-ipc.ts",
  "src/shared/exception-sanitizer.ts",
  "src/shared/renderer-otel-bridge-constants.ts",
  "src/shared/renderer-otel-bridge-utils.ts",
  "src/shared/renderer-otel-bridge.ts",
  "src/renderer/app-otel-runtime.ts",
].map((relativePath) => path.join(appDir, relativePath));
const sharedTelemetryRouteFiles = [
  "src/renderer/components/dashboard/DashboardPage.tsx",
  "src/renderer/components/sessions/SessionsView.tsx",
  "src/renderer/components/sessions/SessionDetailView.tsx",
  "src/renderer/components/kanban/KanbanView.tsx",
  "src/renderer/components/feed/ActivityFeedView.tsx",
  "src/renderer/components/insights/insights-view.tsx",
];
const SHARED_AGENT_SESSIONS_CHANNEL_PATTERN =
  /SHARED_AGENT_SESSIONS_IPC_CHANNELS\.([a-z]+)/g;
const GET_AGENT_MONITOR_URL_HANDLER_RE =
  /ipcMain\.handle\("desktop:get-agent-monitor-url", \(\) => \(\{[\s\S]*localSessionSourceStatus: this\.getLocalSessionSourceStatus\(\),/;
const LOCAL_SESSION_SOURCE_STATUS_DERIVATION_RE =
  /private getLocalSessionSourceStatus\(\)[\s\S]*!this\.isAgentMonitorEnabled\(\)[\s\S]*LOCAL_SESSION_SOURCE_STATUSES\.disabled[\s\S]*this\.isLocalSessionSourceReady\(\)[\s\S]*LOCAL_SESSION_SOURCE_STATUSES\.ready[\s\S]*this\.agentMonitorFailed[\s\S]*LOCAL_SESSION_SOURCE_STATUSES\.unavailable[\s\S]*LOCAL_SESSION_SOURCE_STATUSES\.starting/;
const PRELOAD_AGENT_MONITOR_URL_TYPED_RE =
  /getAgentMonitorUrl: \(\) =>[\s\S]*ipcRendererLike\.invoke\([\s\S]*"desktop:get-agent-monitor-url"[\s\S]*\) as Promise<AgentMonitorUrl>/;
const PRELOAD_STALE_AGENT_MONITOR_URL_SHAPE_RE =
  /Promise<\{\s*url: string \| null;\s*ready: boolean;\s*enabled: boolean;\s*planExtractionEnabled: boolean;\s*\}>/;
const RENDERER_LOCAL_SESSION_STATUS_IMPORT_RE =
  /from "\.\.\/\.\.\/shared\/local-session-source-status"/;
const SESSIONS_VIEW_LOCAL_SESSION_STATUS_IMPORT_RE =
  /from "\.\.\/\.\.\/\.\.\/shared\/local-session-source-status"/;
const RENDERER_DB_DIRECT_ACCESS_RE = /window\.desktopApi\.db/;
const SHARED_STATUS_IMPORT_RE =
  /LOCAL_SESSION_SOURCE_STATUSES[\s\S]*from "\.\.\/shared\/local-session-source-status\.js"/;
const START_CAPTURE_AWAITS_RUNTIME_BEFORE_HOOK_SYNC_RE =
  /private async startAgentCapture\([\s\S]*const runtime = await this\.ensureAgentDashboardDesignSystemRuntime\(\);[\s\S]*runtime\.startHookListener\(\);[\s\S]*await this\.whenInitialDashboardDataServed\(\);[\s\S]*await this\.waitForInitialRendererLiveDbIdleOrTimeout\([\s\S]*syncAgentMonitorHooksOnBoot\(\);[\s\S]*runtime\.startCollectors\(\);/;
const OTLP_RECEIVER_INITIALIZER_RE =
  /const otlpReceiver = new OtlpHttpReceiver\(\{[\s\S]*?\n {2}\}\);/;
const TERMINAL_FAILURE_WIRING_RE = /options\.onTerminalFailure/;
const OTLP_START_PROMISE_STALE_GUARD_RE =
  /const pendingStartPromise = otlpReceiver\.start\(\)\.then\(\(state\) => \{[\s\S]*if \(closed \|\| startPromise !== pendingStartPromise\) \{[\s\S]*return;[\s\S]*if \(!state\.available\)[\s\S]*startPromise = pendingStartPromise;/;
const COLLECTOR_START_PROMISE_STALE_GUARD_RE =
  /startCollectors: \(\) => \{[\s\S]*const pendingStartPromise = ensureOtlpReceiverStarted\(\);[\s\S]*void pendingStartPromise\.then\(\(\) => \{[\s\S]*if \(closed \|\| startPromise !== pendingStartPromise\) \{[\s\S]*return;[\s\S]*collectorManager\.start\(\);/;
const START_CAPTURE_RENDERER_QUIET_SLOT_RE =
  /runtime\.startHookListener\(\);[\s\S]*await this\.whenInitialDashboardDataServed\(\);[\s\S]*await this\.waitForInitialRendererLiveDbIdleOrTimeout\([\s\S]*"agent capture startup"[\s\S]*\);[\s\S]*await this\.waitForRendererBackgroundSlot\(\);[\s\S]*syncAgentMonitorHooksOnBoot\(\);[\s\S]*await this\.waitForRendererBackgroundSlot\(\);[\s\S]*runtime\.startCollectors\(\);[\s\S]*await this\.whenInitialCollectorImportComplete\(\);[\s\S]*await this\.waitForRendererBackgroundSlot\(\);[\s\S]*this\.startAgentSessionSync\(/;
const RENDERER_IDLE_STARTS_INITIAL_QUIET_WINDOW_RE =
  /private notifyInitialRendererLiveDbIdle\(\): void {[\s\S]*this\.initialRendererLiveDbIdle = true;[\s\S]*this\.lastRendererUserInputAtMs = Date\.now\(\);[\s\S]*gatewayLog\.info\("startup", "Renderer live DB idle reached"\)/;
const RENDERER_IDLE_FAIL_OPEN_RE =
  /private async waitForInitialRendererLiveDbIdleOrTimeout\([\s\S]*Promise\.race\(\[[\s\S]*this\.whenInitialRendererLiveDbIdle\(\)[\s\S]*delay\(RENDERER_LIVE_DB_IDLE_FAIL_OPEN_MS\)[\s\S]*gatewayLog\.warn\([\s\S]*renderer live DB idle timeout/;
const RENDERER_QUIET_SLOT_BOUNDED_RE =
  /private async waitForRendererBackgroundSlot\(\): Promise<void> {[\s\S]*const startedAt = Date\.now\(\);[\s\S]*RENDERER_BACKGROUND_SLOT_MAX_DEFER_MS[\s\S]*Math\.min\(remainingQuietMs, remainingDeferralMs\)/;
const PRELOAD_LIVE_DB_IN_FLIGHT_IDLE_RE =
  /let liveDbInFlightCount = 0;[\s\S]*liveDbInFlightCount \+= 1;[\s\S]*\.finally\([\s\S]*liveDbInFlightCount = Math\.max\(0, liveDbInFlightCount - 1\);[\s\S]*liveDbReady && liveDbInFlightCount === 0[\s\S]*scheduleRendererLiveDbIdleNotification\(\)/;
const PRELOAD_IDLE_NOTIFICATION_IN_FLIGHT_GUARD_RE =
  /function scheduleRendererLiveDbIdleNotification\(\): void {[\s\S]*liveDbInFlightCount > 0[\s\S]*const notify = \(\): void => {[\s\S]*if \(liveDbInFlightCount > 0\) {[\s\S]*scheduleRendererLiveDbIdleNotification\(\);/;
const STARTUP_BACKGROUND_TASK_QUEUE_RE =
  /let backgroundTaskTail: Promise<void> = Promise\.resolve\(\);[\s\S]*const enqueueStartupBackgroundTask = \([\s\S]*const previousTask = backgroundTaskTail\.catch\(\(\) => undefined\);[\s\S]*await waitForBackgroundSlot\(\);[\s\S]*await task\(\);[\s\S]*backgroundTaskTail = currentTask\.catch/;
const STARTUP_ENRICHMENT_SEQUENTIAL_RE =
  /await agentDatabase[\s\S]*\.triggerEnrichmentSweep\([\s\S]*await waitForBackgroundSlot\(\);[\s\S]*await agentDatabase[\s\S]*\.runHistoricalBackfill\(gitPath, 50\)/;
const RUN_AFTER_BACKGROUND_WORK_QUEUES_TASK_RE =
  /\.then\(\(\) => enqueueStartupBackgroundTask\(task\)\)/;
const PACK_SCANNER_INITIAL_PHASE_PAUSE_RE =
  /pruneSkipped: false,[\s\S]*await pauseAfterScannerPhase\(\);[\s\S]*summary\.gstack = await scanners\.scanGStack\(db\);/;
const LOW_DUTY_IMPORT_PRE_WRITE_QUIET_SLOT_RE =
  /if \(lowDutyImport\) {[\s\S]*await this\.cooperativeDelay\(0\);[\s\S]*if \(!this\.isImportActive\(generation\)\) {[\s\S]*sourceImported = false;[\s\S]*break;[\s\S]*const result = await this\.importer\.importSession/;
const APP_OTEL_RUNTIME_BANNED_IMPORT_PATTERNS = [
  /@opentelemetry\/exporter-/,
  /^node:http$/,
  /^node:https$/,
  /^node:net$/,
  /^node:tls$/,
  /^node:dgram$/,
  /^socket\.io-client$/,
  /cloud-socket/,
  /relay/,
  /datadog/i,
  /posthog/i,
  /observability/,
  /telemetry-service/,
];
// FEA-1993: the main-process OTel runtime egresses telemetry through these two
// sanctioned keyless-relay modules (OTLP serialized over the relay's /telemetry
// channel). They are the ONLY relay/socket egress the runtime may reach; every
// other banned pattern above — direct OTLP exporters, raw network, the
// authenticated gateway (cloud-socket), the old Observability/telemetry-service
// path, and vendor SDKs — still applies. The renderer bridge stays local-only
// (its egress remains a deferred follow-up), so this allow-list never applies
// to the renderer entry.
const APP_OTEL_RUNTIME_ALLOWED_EGRESS_SPECIFIERS = [
  /\/relay-telemetry-transport(\.js)?$/,
  /\/relay-otlp-exporters(\.js)?$/,
];
const RENDERER_OTEL_RUNTIME_BANNED_IMPORT_PATTERNS = [
  /^electron$/,
  /^node:/,
  /^zod$/,
  /renderer-otel-bridge\.js$/,
  /@opentelemetry\/exporter-/,
  /otlp/i,
  /relay/i,
  /datadog/i,
  /posthog/i,
  /database/i,
];
const APP_BOOT_VERBOSE_LOGGING_TOKEN = "gatewayLog.setVerbose(";
const APP_BOOT_OTEL_START_TOKEN = "await startDesktopOtelRuntimeForBoot({";
const APP_BOOT_LIFECYCLE_START_TOKEN = "this.appLifecycleTelemetry.start();";
const APP_BOOT_DOWNSTREAM_OTEL_SURFACE_TOKENS = [
  ["dock icon", "app.dock.setIcon(dockIcon);"],
  ["tray initialization", "this.tray.init({"],
  [
    "design-system DB IPC fallback",
    "this.registerDisabledAgentDashboardDbIpcHandlers();",
  ],
  ["renderer boot", "this.desktopWindow.init();"],
  ["onboarding handoff drain", "void this.drainQueuedOnboardingHandoffs();"],
  [
    "canonical onboarding handoff",
    'void this.processCanonicalOnboardingHandoff("cold-start");',
  ],
  ["onboarding popup", "void this.maybeShowOnboardingPopup();"],
  ["session log tail seed", "void this.seedPreviousSessionLogTail();"],
];
const APP_LIFECYCLE_NO_OBSERVABILITY_RE = /Observability|getTelemetryEmitter/;
const APP_LIFECYCLE_NO_TELEMETRY_SERVICE_RE = /TelemetryService|sendTelemetry/;
const APP_LIFECYCLE_NO_EXTERNAL_TELEMETRY_RE =
  /CloudSocketService|desktop\.telemetry/;
const APP_LIFECYCLE_OPERATING_MODE_CALLBACK_RE =
  /getAppOperatingModeForTelemetry\(\): DesktopAppOperatingMode {[\s\S]*return getDesktopAppOperatingModeForTelemetry\(this\.apiKeyStore\);/;
const APP_LIFECYCLE_OPERATING_MODE_DERIVATION_RE =
  /getStatus\(\)\.hasApiKey[\s\S]*return DesktopAppOperatingMode\.Multiplayer;[\s\S]*return DesktopAppOperatingMode\.SinglePlayer;/;
const APP_LIFECYCLE_SHUTDOWN_BEFORE_OTEL_RE =
  /this\.appLifecycleTelemetry\.stop\(\);[\s\S]*this\.appLifecycleTelemetry\.emitShutdown\(\);[\s\S]*await shutdownDesktopOtelRuntime\(\{/;

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(appDir, relativePath), "utf8");
}

function parseConstStringObject(
  source: string,
  exportName: string
): Record<string, string> {
  const objectMatch = source.match(
    new RegExp(
      String.raw`export const ${exportName} = \{(?<body>[\s\S]*?)\} as const;`
    )
  );
  if (!objectMatch?.groups?.body) {
    throw new Error(`${exportName} must be exported`);
  }

  const entries: Record<string, string> = {};
  for (const entryMatch of objectMatch.groups.body.matchAll(
    /(?<key>[a-zA-Z][a-zA-Z0-9_]*): "(?<value>[^"]+)"/g
  )) {
    entries[entryMatch.groups!.key] = entryMatch.groups!.value;
  }

  if (Object.keys(entries).length === 0) {
    throw new Error(`${exportName} must define statuses`);
  }
  return entries;
}

function toRelative(filePath: string): string {
  return path.relative(appDir, filePath).split(path.sep).join("/");
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const importClause = node.importClause;
  if (!importClause) {
    return false;
  }
  if (importClause.isTypeOnly) {
    return true;
  }
  if (importClause.name) {
    return false;
  }
  const bindings = importClause.namedBindings;
  return (
    bindings != null &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function resolveLocalImport(
  importer: string,
  specifier: string
): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const basePath = path.resolve(path.dirname(importer), specifier);
  const candidates = specifier.endsWith(".js")
    ? [basePath.replace(/\.js$/, ".ts"), basePath.replace(/\.js$/, ".tsx")]
    : [`${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function staticValueImports(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf8");
  const ast = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ES2023,
    true,
    ts.ScriptKind.TS
  );
  const imports: string[] = [];

  for (const statement of ast.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !isTypeOnlyImport(statement)
    ) {
      const resolved = resolveLocalImport(
        filePath,
        statement.moduleSpecifier.text
      );
      if (resolved) {
        imports.push(resolved);
      }
    }
  }

  return imports;
}

function staticValueImportSpecifiers(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf8");
  const ast = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ES2023,
    true,
    ts.ScriptKind.TS
  );
  const specifiers: string[] = [];

  for (const statement of ast.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !isTypeOnlyImport(statement)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }

  return specifiers;
}

function isDesignSystemRuntimeModule(filePath: string): boolean {
  const relativePath = toRelative(filePath);
  return (
    relativePath === "src/main/agent-dashboard-design-system-runtime.ts" ||
    relativePath === "src/main/agent-monitor-listener.ts" ||
    relativePath === "src/main/otlp-http-receiver.ts" ||
    relativePath.startsWith("src/main/otlp/") ||
    relativePath.startsWith("src/main/collectors/") ||
    relativePath.startsWith("src/main/database/")
  );
}

function isAppOtelRuntimeBannedModule(filePath: string): boolean {
  const relativePath = toRelative(filePath);
  return (
    isDesignSystemRuntimeModule(filePath) ||
    relativePath === "src/main/otlp-http-receiver.ts" ||
    relativePath.startsWith("src/main/otlp/")
  );
}

test("boot files do not statically import design-system dashboard runtime modules", () => {
  assert.deepEqual(collectDesignSystemRuntimeImportViolations(bootEntries), []);
});

test("app OTel runtime egresses only via the sanctioned relay transport; renderer bridge stays local-only", () => {
  assert.deepEqual(collectAppOtelRuntimeImportViolations(), []);
});

test("design-system import graph guard rejects value imports used only as types", () => {
  const fixtureDir = fs.mkdtempSync(
    path.join(tmpdir(), "agent-dashboard-boundary-")
  );
  const runtimeSpecifier = toImportSpecifier(
    fixtureDir,
    path.join(appDir, "src/main/agent-dashboard-design-system-runtime.js")
  );
  const valueImportFixture = path.join(fixtureDir, "value-import.ts");
  const typeImportFixture = path.join(fixtureDir, "type-import.ts");

  try {
    fs.writeFileSync(
      valueImportFixture,
      [
        `import { AgentDashboardDesignSystemRuntime } from "${runtimeSpecifier}";`,
        "type Runtime = AgentDashboardDesignSystemRuntime;",
        "export type { Runtime };",
      ].join("\n")
    );
    fs.writeFileSync(
      typeImportFixture,
      [
        `import type { AgentDashboardDesignSystemRuntime } from "${runtimeSpecifier}";`,
        "type Runtime = AgentDashboardDesignSystemRuntime;",
        "export type { Runtime };",
      ].join("\n")
    );

    assert.deepEqual(
      collectDesignSystemRuntimeImportViolations(
        [typeImportFixture],
        [fixtureDir, srcDir]
      ),
      []
    );
    assert.deepEqual(
      collectDesignSystemRuntimeImportViolations(
        [valueImportFixture],
        [fixtureDir, srcDir]
      ),
      [
        `${toRelative(valueImportFixture)} -> src/main/agent-dashboard-design-system-runtime.ts`,
      ]
    );
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

function collectDesignSystemRuntimeImportViolations(
  entries: string[],
  allowedRoots = [srcDir]
): string[] {
  const visited = new Set<string>();
  const queue = [...entries];
  const violations: string[] = [];

  while (queue.length > 0) {
    const filePath = queue.shift()!;
    if (visited.has(filePath) || !isInsideAnyRoot(filePath, allowedRoots)) {
      continue;
    }
    visited.add(filePath);

    for (const imported of staticValueImports(filePath)) {
      if (isDesignSystemRuntimeModule(imported)) {
        violations.push(`${toRelative(filePath)} -> ${toRelative(imported)}`);
        continue;
      }
      queue.push(imported);
    }
  }

  return violations;
}

function collectAppOtelRuntimeImportViolations(): string[] {
  const violations: string[] = [];

  for (const entry of rendererOtelBoundaryEntries) {
    const isRendererEntry = entry.endsWith("src/renderer/app-otel-runtime.ts");
    const bannedPatterns = isRendererEntry
      ? RENDERER_OTEL_RUNTIME_BANNED_IMPORT_PATTERNS
      : APP_OTEL_RUNTIME_BANNED_IMPORT_PATTERNS;
    const allowedEgressSpecifiers = isRendererEntry
      ? []
      : APP_OTEL_RUNTIME_ALLOWED_EGRESS_SPECIFIERS;
    for (const specifier of staticValueImportSpecifiers(entry)) {
      if (allowedEgressSpecifiers.some((pattern) => pattern.test(specifier))) {
        continue;
      }
      if (bannedPatterns.some((pattern) => pattern.test(specifier))) {
        violations.push(`${toRelative(entry)} -> ${specifier}`);
      }
    }

    for (const imported of staticValueImports(entry)) {
      if (isAppOtelRuntimeBannedModule(imported)) {
        violations.push(`${toRelative(entry)} -> ${toRelative(imported)}`);
      }
    }
  }

  return violations;
}

function isInsideAnyRoot(filePath: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, filePath);
    return (
      relative === "" ||
      !(relative.startsWith("..") || path.isAbsolute(relative))
    );
  });
}

function toImportSpecifier(fromDir: string, targetJsPath: string): string {
  let specifier = path
    .relative(fromDir, targetJsPath)
    .split(path.sep)
    .join("/");
  if (!specifier.startsWith(".")) {
    specifier = `./${specifier}`;
  }
  return specifier;
}

test("SQLite dashboard side effects stay behind the Agent Dashboard runtime boundary", () => {
  const appSource = readSource("src/main/app.ts");
  const indexSource = readSource("src/main/index.ts");
  const preloadCommonSource = readSource("src/main/preload-common.ts");
  const preloadDesignSystemSource = readSource(
    "src/main/preload-design-system.ts"
  );
  const windowSource = readSource("src/main/window.ts");

  assert.doesNotMatch(appSource, /ipcMain\.handle\("desktop:db:/);
  assert.match(
    appSource,
    /await import\(\s*"\.\/agent-dashboard-design-system-runtime\.js"\s*\)/
  );
  assert.match(indexSource, /protocol\.registerSchemesAsPrivileged\(\[/);
  assert.doesNotMatch(indexSource, /shouldRegisterDesignSystemScheme/);
  assert.doesNotMatch(preloadCommonSource, /desktop:db:/);
  assert.match(preloadDesignSystemSource, /desktop:db:get-sessions/);
  assert.match(preloadDesignSystemSource, /desktop:db:changed/);
  assert.match(preloadDesignSystemSource, /desktop:db:get-core-features/);
  assert.match(preloadDesignSystemSource, /desktop:db:get-pull-requests/);
  assert.match(designSystemRuntimeSource(), /"agent-dashboard-ingest"/);
  assert.doesNotMatch(
    designSystemRuntimeSource(),
    /stateDir:[\s\S]*"agent-monitor"/
  );
  assert.match(windowSource, /--closedloop-agent-dashboard-design-system/);
  // electron-vite emits the preload as CommonJS `.cjs` (PLN-999).
  assert.match(windowSource, /preload-design-system\.cjs/);
  assert.match(windowSource, /DESIGN_RENDERER_URL/);
  assert.match(windowSource, /loadURL\(DESIGN_RENDERER_URL\)/);
  assert.doesNotMatch(windowSource, /agentDashboardMode/);
  assert.doesNotMatch(windowSource, /resolveLegacyRendererPath/);
  assert.doesNotMatch(windowSource, /loadFile\(rendererPath\)/);
  assert.match(
    designSystemRuntimeSource(),
    /ipcMain\.removeHandler\(channel\)/
  );
  const designSystemSource = designSystemRuntimeSource();
  const handlerRegistrationIndex = designSystemSource.indexOf(
    "registerIpcHandlers();"
  );
  const databaseReadyIndex = designSystemSource.indexOf(
    "await agentDatabasePromise;"
  );
  assert.ok(handlerRegistrationIndex >= 0);
  assert.ok(databaseReadyIndex >= 0);
  assert.ok(
    handlerRegistrationIndex > databaseReadyIndex,
    "live design-system DB IPC handlers must wait until SQLite is ready so renderer startup does not block on the DB promise"
  );
  assert.doesNotMatch(
    designSystemSource,
    /SELECT DISTINCT cwd[\s\S]*ORDER BY started_at/,
    "recent-projects query must stay valid for Postgres/SQLite"
  );
  assert.match(
    designSystemSource,
    /GROUP BY cwd[\s\S]*ORDER BY MAX\(started_at\) DESC NULLS LAST/
  );
  assert.match(appSource, /stopAgentCapture\(\{ closeDesignSystem: true \}\)/);
  assert.doesNotMatch(appSource, /AgentMonitorSidecar/);
  assert.doesNotMatch(appSource, /reloadForAgentDashboardMode/);
});

test("boot hook repair waits for design runtime startup", () => {
  assert.match(
    readSource("src/main/app.ts"),
    START_CAPTURE_AWAITS_RUNTIME_BEFORE_HOOK_SYNC_RE
  );
});

test("OTLP receiver bind failures are not wired to terminal Agent Monitor failure", () => {
  const match = readSource(
    "src/main/agent-dashboard-design-system-runtime.ts"
  ).match(OTLP_RECEIVER_INITIALIZER_RE);
  assert.ok(match);
  assert.doesNotMatch(match[0], TERMINAL_FAILURE_WIRING_RE);
});

test("design-system runtime ignores stale async OTLP startup callbacks", () => {
  assert.match(designSystemRuntimeSource(), OTLP_START_PROMISE_STALE_GUARD_RE);
  assert.match(
    designSystemRuntimeSource(),
    COLLECTOR_START_PROMISE_STALE_GUARD_RE
  );
});

test("shared telemetry renderer routes do not call desktop DB IPC directly", () => {
  for (const routeFile of sharedTelemetryRouteFiles) {
    assert.doesNotMatch(readSource(routeFile), /window\.desktopApi\.db/);
  }
});

test("Agent Monitor URL IPC exposes canonical local session source status", () => {
  const appSource = readSource("src/main/app.ts");
  const preloadCommonSource = readSource("src/main/preload-common.ts");
  const rendererTypesSource = readSource("src/renderer/types/desktop-api.d.ts");
  const routeSource = readSource(
    "src/renderer/components/sessions/SessionsView.tsx"
  );
  const statusSource = readSource("src/shared/local-session-source-status.ts");

  assert.match(appSource, SHARED_STATUS_IMPORT_RE);
  assert.match(appSource, LOCAL_SESSION_SOURCE_STATUS_DERIVATION_RE);
  assert.match(appSource, GET_AGENT_MONITOR_URL_HANDLER_RE);
  assert.doesNotMatch(appSource, /localSessionSourceError/);
  assert.match(preloadCommonSource, PRELOAD_AGENT_MONITOR_URL_TYPED_RE);
  assert.doesNotMatch(
    preloadCommonSource,
    PRELOAD_STALE_AGENT_MONITOR_URL_SHAPE_RE
  );
  assert.match(rendererTypesSource, RENDERER_LOCAL_SESSION_STATUS_IMPORT_RE);
  assert.doesNotMatch(rendererTypesSource, /localSessionSourceError/);
  assert.match(routeSource, SESSIONS_VIEW_LOCAL_SESSION_STATUS_IMPORT_RE);

  const statuses = parseConstStringObject(
    statusSource,
    "LOCAL_SESSION_SOURCE_STATUSES"
  );
  for (const [statusName, statusValue] of Object.entries(statuses)) {
    assert.equal(statusValue, statusName);
  }
});

test("Desktop Sessions route gates startup through preload status only", () => {
  const routeSource = readSource(
    "src/renderer/components/sessions/SessionsView.tsx"
  );

  assert.doesNotMatch(routeSource, RENDERER_DB_DIRECT_ACCESS_RE);
  assert.match(routeSource, /getAgentMonitorUrl\(\)/);
  assert.match(routeSource, /onDbChanged\?\./);
  assert.match(routeSource, /enabled: canReadLocalSessions/);
});

test("design-system DB IPC fallback covers renderer boot before deferred runtime startup", () => {
  const appSource = readSource("src/main/app.ts");
  const fallbackRegistrationIndex = appSource.indexOf(
    "this.registerDisabledAgentDashboardDbIpcHandlers();"
  );
  const rendererBootIndex = appSource.indexOf("this.desktopWindow.init();");

  assert.ok(
    fallbackRegistrationIndex >= 0,
    "boot must register design-system DB IPC handlers"
  );
  assert.ok(
    rendererBootIndex >= 0,
    "boot must load the design-system renderer window"
  );
  assert.ok(
    fallbackRegistrationIndex < rendererBootIndex,
    "desktop:db:* handlers must be registered before the renderer can invoke them"
  );
  assert.match(
    appSource,
    /private schedulePostInitialWindowBootTasks\([\s\S]*const start = async[\s\S]*void this\.startAgentCapture\(\{ startSessionSync: false \}\)[\s\S]*this\.desktopWindow\.whenInitiallyShown\(\)\.then\(\(\) => \{[\s\S]*void start\(\)/,
    "live design-system runtime startup must stay behind the renderer-visible event"
  );
  assert.doesNotMatch(
    appSource,
    /registerDisabledAgentDashboardDbIpcHandlers\(\);[\s\S]*await this\.ensureAgentDashboardDesignSystemRuntime\(\);[\s\S]*this\.desktopWindow\.init\(\);/,
    "boot must not wait for SQLite-backed runtime startup before loading the renderer"
  );
  assert.match(
    appSource,
    START_CAPTURE_RENDERER_QUIET_SLOT_RE,
    "collector startup and initial session sync must wait for renderer quiet slots after initial live DB data"
  );
  const collectorManagerSource = readSource(
    "src/main/collectors/collector-manager.ts"
  );
  assert.match(
    collectorManagerSource,
    LOW_DUTY_IMPORT_PRE_WRITE_QUIET_SLOT_RE,
    "historical imports must re-check the renderer quiet gate after worker parsing and before SQLite writes"
  );
  assert.match(
    appSource,
    /scheduleCloudSocketStartAfterInitialUi\(\);/,
    "boot must schedule cloud socket startup through the initial-UI gate"
  );
  assert.doesNotMatch(
    appSource,
    /if\s*\(\s*this\.cloudConnectionEnabled[\s\S]*?void this\.cloudSocket\.start\(\);[\s\S]*?else if \(!this\.cloudConnectionEnabled\)/,
    "boot must not start the cloud socket directly before initial local UI data"
  );
  assert.match(
    appSource,
    /private async waitForInitialUiBeforeCloudSocket\(\): Promise<void> {[\s\S]*await this\.desktopWindow\.whenInitiallyShown\(\);[\s\S]*if \(this\.isAgentMonitorEnabled\(\)\) {[\s\S]*await this\.waitForDashboardReadinessBeforeCloudSocket\(\);[\s\S]*private async waitForDashboardReadinessBeforeCloudSocket\(\): Promise<void> {[\s\S]*Promise\.race\(\[readiness, timeout\]\)/,
    "cloud socket startup must wait for the visible window and use a bounded dashboard-readiness gate when Agent Monitor is enabled"
  );
  const runtimeSource = designSystemRuntimeSource();
  assert.match(
    runtimeSource,
    STARTUP_BACKGROUND_TASK_QUEUE_RE,
    "startup background tasks must serialize through the renderer quiet gate"
  );
  assert.match(
    runtimeSource,
    STARTUP_ENRICHMENT_SEQUENTIAL_RE,
    "startup enrichment and historical backfill must not run in parallel after the same readiness gate"
  );
  assert.match(
    runtimeSource,
    RUN_AFTER_BACKGROUND_WORK_QUEUES_TASK_RE,
    "background work allowed tasks must enqueue instead of releasing concurrently"
  );
  assert.match(
    runtimeSource,
    /runAfterInitialBackgroundWorkAllowed\(\s*"Startup catalog maintenance",\s*runStartupCatalogMaintenance\s*\)/,
    "startup catalog maintenance must wait until initial background work is allowed"
  );
  assert.match(
    runtimeSource,
    /runAfterInitialBackgroundWorkAllowed\(\s*"Startup enrichment",\s*runStartupEnrichment\s*\)/,
    "startup enrichment must wait until initial background work is allowed"
  );
  assert.match(
    runtimeSource,
    /runAfterInitialBackgroundWorkAllowed\("Initial catalog fetch", async \(\) => \{[\s\S]*await invokeStoreOp\("catalog\.fetch\.run"\);[\s\S]*\}\);/,
    "initial catalog fetch must wait until initial background work is allowed"
  );
  // FEA-2038: runCatalogFetch ends in prisma.write, which can't cross the
  // DB-host method proxy — the fetch must run in the child via a store op, never
  // directly in main (that path throws DataCloneError for every pack).
  assert.doesNotMatch(
    runtimeSource,
    /runCatalogFetch\(/,
    "catalog fetch must run in the DB host via invokeStoreOp, not over the prisma proxy in main"
  );
  const catalogFetcherSource = readSource("src/main/packs/catalog-fetcher.ts");
  assert.doesNotMatch(
    catalogFetcherSource,
    /execFileSync/,
    "catalog fetcher must not block the Electron main process with synchronous gh calls"
  );
  const packScannerSource = readSource("src/main/packs/pack-scanner.ts");
  assert.match(
    packScannerSource,
    PACK_SCANNER_INITIAL_PHASE_PAUSE_RE,
    "pack scanner must yield to the cooperative startup gate before the first synchronous scan phase"
  );
});

test("desktop OTel runtime starts before downstream boot telemetry surfaces", () => {
  const appSource = readSource("src/main/app.ts");
  const verboseLoggingIndex = appSource.indexOf(APP_BOOT_VERBOSE_LOGGING_TOKEN);
  const otelStartIndex = appSource.indexOf(APP_BOOT_OTEL_START_TOKEN);
  const lifecycleStartIndex = appSource.indexOf(APP_BOOT_LIFECYCLE_START_TOKEN);

  assert.ok(
    verboseLoggingIndex >= 0,
    "boot must configure gateway log verbosity"
  );
  assert.ok(otelStartIndex >= 0, "boot must start the Desktop OTel runtime");
  assert.ok(
    lifecycleStartIndex >= 0,
    "boot must start app lifecycle telemetry"
  );
  assert.ok(
    verboseLoggingIndex < otelStartIndex,
    "Desktop OTel runtime must start immediately after gateway log verbosity is configured"
  );
  assert.ok(
    otelStartIndex < lifecycleStartIndex,
    "app lifecycle telemetry must start after the Desktop OTel runtime startup path"
  );

  for (const [label, token] of APP_BOOT_DOWNSTREAM_OTEL_SURFACE_TOKENS) {
    const downstreamIndex = appSource.indexOf(token);
    assert.ok(downstreamIndex >= 0, `boot must retain ${label}`);
    assert.ok(
      lifecycleStartIndex < downstreamIndex,
      `app lifecycle telemetry must start before ${label}`
    );
  }
});

test("app lifecycle telemetry stays out of external telemetry egress", () => {
  const runtimeSource = readSource("src/main/app-otel-runtime.ts");
  const lifecycleSource = readSource("src/main/app-otel-runtime-lifecycle.ts");
  const operatingModeSource = readSource(
    "src/main/app-telemetry-operating-mode.ts"
  );
  const appSource = readSource("src/main/app.ts");

  assert.doesNotMatch(runtimeSource, APP_LIFECYCLE_NO_OBSERVABILITY_RE);
  assert.doesNotMatch(runtimeSource, APP_LIFECYCLE_NO_TELEMETRY_SERVICE_RE);
  assert.doesNotMatch(runtimeSource, APP_LIFECYCLE_NO_EXTERNAL_TELEMETRY_RE);
  assert.doesNotMatch(lifecycleSource, APP_LIFECYCLE_NO_OBSERVABILITY_RE);
  assert.doesNotMatch(lifecycleSource, APP_LIFECYCLE_NO_TELEMETRY_SERVICE_RE);
  assert.doesNotMatch(lifecycleSource, APP_LIFECYCLE_NO_EXTERNAL_TELEMETRY_RE);
  assert.match(appSource, APP_LIFECYCLE_OPERATING_MODE_CALLBACK_RE);
  assert.match(operatingModeSource, APP_LIFECYCLE_OPERATING_MODE_DERIVATION_RE);
  assert.match(appSource, APP_LIFECYCLE_SHUTDOWN_BEFORE_OTEL_RE);
});

test("live DB readiness refresh and renderer-idle signaling are bounded", () => {
  const appSource = readSource("src/main/app.ts");
  const runtimeSource = designSystemRuntimeSource();
  const preloadSource = readSource("src/main/preload-design-system.ts");
  const windowSource = readSource("src/main/window.ts");

  assert.match(
    runtimeSource,
    /webContents\.send\("desktop:db:ready", \{\}\)[\s\S]*webContents\.send\("desktop:db:changed", \{\}\)/,
    "runtime must announce live DB readiness before nudging DB-backed caches"
  );
  assert.match(
    appSource,
    /if\s*\(\s*this\.isLocalSessionSourceReady\(\)\s*\)\s*{\s*event\.sender\.send\("desktop:db:ready", \{\}\);[\s\S]*event\.sender\.send\("desktop:db:changed", \{\}\);/,
    "renderer-ready replay must include DB readiness when the runtime is already live"
  );
  assert.match(
    appSource,
    /ipcMain\.on\("desktop:renderer-live-db-idle"[\s\S]*this\.desktopWindow\.isTrustedSender\(event\.sender\)[\s\S]*this\.notifyInitialRendererLiveDbIdle\(\)/,
    "renderer live DB idle must only be accepted from the trusted renderer"
  );
  assert.match(
    appSource,
    RENDERER_IDLE_STARTS_INITIAL_QUIET_WINDOW_RE,
    "renderer live DB idle must start an initial quiet window before background work"
  );
  assert.match(
    appSource,
    RENDERER_IDLE_FAIL_OPEN_RE,
    "background work must not wait forever if renderer live DB idle never arrives"
  );
  assert.match(
    appSource,
    /ipcMain\.on\("desktop:renderer-user-input"[\s\S]*this\.desktopWindow\.isTrustedSender\(event\.sender\)[\s\S]*this\.notifyRendererUserInput\(\)/,
    "renderer interaction events must only be accepted from the trusted renderer"
  );
  assert.match(
    appSource,
    RENDERER_QUIET_SLOT_BOUNDED_RE,
    "background maintenance must pause for recent renderer input without unbounded starvation"
  );
  assert.match(
    appSource,
    /new AgentSessionSyncService\(\{[\s\S]*waitForBackgroundSlot: \(\) => this\.waitForRendererBackgroundSlot\(\)/,
    "agent-session sync must use the renderer-input quiet gate before heavy payload preparation"
  );
  assert.match(
    appSource,
    /preparePayloads: createAgentSessionPayloadWorkerPreparer\(\)/,
    "agent-session sync payload sanitization and chunking must run through the worker-backed preparer"
  );
  assert.match(
    windowSource,
    /isTrustedSender\(sender: WebContents\): boolean {[\s\S]*sender === this\.browserWindow\?\.webContents/,
    "DesktopWindow must keep renderer IPC trust scoped to the current BrowserWindow"
  );
  assert.match(
    preloadSource,
    /let liveDbReady = false;[\s\S]*ipcRenderer\.on\("desktop:db:ready"[\s\S]*liveDbReady = true;[\s\S]*notifyDbChangeSubscribers\(\{\}\);/,
    "preload must remember live DB readiness and refresh existing subscribers"
  );
  assert.match(
    preloadSource,
    PRELOAD_LIVE_DB_IN_FLIGHT_IDLE_RE,
    "preload must wait for all in-flight live DB IPC calls before scheduling renderer idle"
  );
  assert.match(
    preloadSource,
    PRELOAD_IDLE_NOTIFICATION_IN_FLIGHT_GUARD_RE,
    "preload idle notification must re-check in-flight live DB calls before notifying main"
  );
  assert.doesNotMatch(
    preloadSource,
    /ipcRenderer\.invoke\(\s*"desktop:db:/,
    "all desktop:db preload invokes must route through live DB in-flight tracking"
  );
  assert.match(
    preloadSource,
    /requestIdleCallback[\s\S]*ipcRenderer\.send\("desktop:renderer-live-db-idle"\)/,
    "preload must key background startup on a renderer idle event instead of a fixed timer"
  );
  assert.match(
    preloadSource,
    /const RENDERER_INTERACTION_EVENTS = \[[\s\S]*"scroll"/,
    "preload must report renderer interaction so main-process maintenance can avoid active scrolling"
  );
  assert.match(
    preloadSource,
    /ipcRenderer\.send\("desktop:renderer-user-input"\)/,
    "preload must notify main when renderer interaction is observed"
  );
  assert.match(
    runtimeSource,
    /historicalImportStaggerMs: desktopHistoricalImportStaggerMs/,
    "startup historical imports must be staggered across harnesses"
  );
  assert.doesNotMatch(
    preloadSource,
    /if \(liveDbReady\) {[\s\S]*queueMicrotask\(\(\) => {[\s\S]*callback\(\{\}\);/,
    "preload must not replay broad DB changes to subscribers that register after readiness"
  );
});

test("disabled DB IPC unregister covers shared branch handlers", () => {
  const appSource = readSource("src/main/app.ts");

  assert.match(
    appSource,
    /for \(const channel of SHARED_BRANCHES_IPC_CHANNEL_LIST\) {\s*ipcMain\.removeHandler\(channel\);\s*}/,
    "disabled DB IPC unregister must remove branch handlers as well as dashboard/session handlers"
  );
});

test("design-system preload DB invokes have registered main-process handlers", () => {
  const preloadSource = readSource("src/main/preload-design-system.ts");
  const runtimeSource = designSystemRuntimeSource();
  const invokedChannels = collectDesktopDbIpcChannels(
    preloadSource,
    /"([^"]+)"/g
  ).filter(
    (channel) =>
      channel !== "desktop:db:changed" && channel !== "desktop:db:ready"
  );
  const registeredChannels = collectDesktopDbIpcChannels(
    runtimeSource,
    /ipcMain\.handle\(\s*"([^"]+)"/g
  );

  assert.ok(
    invokedChannels.length > 0,
    "preload-design-system must expose DB-backed IPC invokes"
  );
  assert.ok(
    registeredChannels.length > 0,
    "design-system runtime must register DB-backed IPC handlers"
  );

  const missingHandlers = invokedChannels.filter(
    (channel) => !registeredChannels.includes(channel)
  );
  assert.deepEqual(
    missingHandlers,
    [],
    "every preload desktop:db invoke must have a main-process handler"
  );
});

test("shared agent sessions stay bounded to additive IPC and renderer adapter", () => {
  const preloadSource = readSource("src/main/preload-design-system.ts");
  const runtimeSource = designSystemRuntimeSource();
  const rendererDataSourceSource = readSource(
    "src/renderer/shared-agent-sessions/local-agent-sessions-data-source.ts"
  );
  const channels = ["analytics", "detail", "list", "usage"];
  assert.match(preloadSource, /agentSessionsApi/);
  assert.match(runtimeSource, /SHARED_AGENT_SESSIONS_IPC_CHANNELS\.list/);
  assert.match(
    readSource("src/main/app.ts"),
    /SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST/
  );
  assert.deepEqual(collectSharedSessionChannels(preloadSource), channels);
  // The renderer-side local data source must stay bounded to the additive IPC
  // surface: it routes reads through `desktopApi.agentSessionsApi` and never
  // reaches into main-process internals or Node built-ins.
  assert.doesNotMatch(rendererDataSourceSource, /src\/main|database\/sqlite/);
  assert.doesNotMatch(rendererDataSourceSource, /node:fs|node:path|node:os/);
  assert.match(rendererDataSourceSource, /desktopApi\.agentSessionsApi/);
  assert.doesNotMatch(
    readSource("src/renderer/App.tsx"),
    /ApiAdapterProvider|createDesktopLocalAgentSessions/
  );
  assert.doesNotMatch(
    readSource("src/renderer/navigation/route-table.ts"),
    /agent-sessions|shared-agent-sessions/
  );
});

function designSystemRuntimeSource(): string {
  return readSource("src/main/agent-dashboard-design-system-runtime.ts");
}

function collectDesktopDbIpcChannels(
  source: string,
  pattern: RegExp
): string[] {
  const channels = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const channel = match[1];
    if (channel?.startsWith("desktop:db:")) {
      channels.add(channel);
    }
  }
  return [...channels].sort();
}

function collectSharedSessionChannels(source: string): string[] {
  const channels = new Set<string>();
  for (const match of source.matchAll(SHARED_AGENT_SESSIONS_CHANNEL_PATTERN)) {
    if (match[1]) {
      channels.add(match[1]);
    }
  }
  return [...channels].sort();
}

test("design-system BrowserWindow protocol and navigation guards are fail-closed", () => {
  const windowSource = readSource("src/main/window.ts");

  assert.match(windowSource, /request\.method !== "GET"/);
  assert.match(windowSource, /url\.hostname !== "renderer"/);
  assert.match(windowSource, /decodeURIComponent\(url\.pathname\)/);
  assert.match(windowSource, /startsWith\("\/design-system\/"\)/);
  assert.match(windowSource, /startsWith\("\/assets\/"\)/);
  assert.match(windowSource, /pathParts\.includes\("\.\."\)/);
  assert.match(windowSource, /APP_PROTOCOL_EXTENSIONS\.has\(ext\)/);
  assert.match(windowSource, /realpathSync\(assetRoot\)/);
  assert.match(windowSource, /statSync\(realFile\)\.isFile\(\)/);
  assert.match(windowSource, /isPathInside\(realFile, realRoot\)/);
  assert.match(
    windowSource,
    /new URL\(url\)\.href === this\.allowedRendererUrl/
  );
  assert.match(windowSource, /parsed\.protocol === "https:"/);
  assert.match(windowSource, /EXTERNAL_LINK_HOSTS\.has\(parsed\.hostname\)/);
  assert.doesNotMatch(windowSource, /parsed\.protocol === "file:"/);
  assert.doesNotMatch(
    windowSource,
    /parsed\.protocol === "app:" && parsed\.hostname === "renderer"/
  );
  assert.doesNotMatch(
    windowSource,
    /parsed\.protocol === "http:" \|\| parsed\.protocol === "https:"/
  );
});
