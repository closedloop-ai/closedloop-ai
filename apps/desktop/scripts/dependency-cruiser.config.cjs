"use strict";

// Desktop module-boundary rules (replaces the hand-rolled AST BFS in the former
// test/agent-dashboard-boundary.test.ts). dependency-cruiser resolves the real
// TS module graph, so it expresses transitive reachability natively and handles
// resolution / edge-type exclusion for us. Run from apps/desktop:
//   depcruise src --config scripts/dependency-cruiser.config.cjs
//
// This gate can only see `.ts` because pnpm-workspace.yaml gives
// dependency-cruiser its own typescript via `packageExtensions`. It probes
// `tryImportAvailable("typescript", ">=2.0.0 <7.0.0")` and declares no
// dependency on one, so under the workspace's typescript@7 that probe fails,
// `.ts` leaves `scannableExtensions`, and `depcruise src` silently gathers 0
// modules and exits 0 — enforcing nothing, on every surface that runs it.
// Remove that entry and this whole file goes quiet rather than red. The gate
// script asserts a module floor precisely so that failure cannot pass as a
// success; do not "fix" a low count by narrowing what is cruised.

const OTEL_RUNTIME_ENTRIES = String.raw`^src/(main/(telemetry/app-otel-runtime|telemetry/app-otel-runtime-lifecycle|ipc/renderer-otel-ipc)|shared/(exception-sanitizer|renderer-otel-bridge-constants|renderer-otel-bridge-utils|renderer-otel-bridge))\.ts$`;
const BOOT_ENTRIES = String.raw`^src/main/(index|startup|app|window)\.ts$`;
const DESIGN_SYSTEM_RUNTIME = String.raw`^src/main/(dashboard/agent-dashboard-design-system-runtime|agent-monitor/agent-monitor-listener|telemetry/otlp-http-receiver)\.ts$|^src/main/(otlp|collectors|database)/`;
// ISS-6330: `index.ts` alone, not the wider BOOT_ENTRIES set. It registers the
// crash handlers, so its whole module graph evaluates BEFORE any handler exists
// and a throw during that evaluation is the silent startup failure with no
// dialog and no telemetry. `startup.ts`/`app.ts` run after registration and are
// legitimately allowed the heavy surfaces below.
const BOOTSTRAP_ENTRY = String.raw`^src/main/index\.ts$`;
// The OTel runtime is the pointed one: the bridge index.ts reaches holds a
// `DesktopOtelRuntime` as a TYPE only, which `tsPreCompilationDeps: false`
// drops from this graph. Promote that to a value import and this rule fires.
const BOOTSTRAP_FORBIDDEN_REACH = [
  String.raw`^src/main/telemetry/app-otel-runtime(-lifecycle)?\.ts$`,
  "@opentelemetry",
  String.raw`socket\.io-client`,
  "cloud-socket",
  "relay",
  "datadog",
  "posthog",
  "observability",
  "telemetry-service",
  "prisma",
  DESIGN_SYSTEM_RUNTIME,
];
// Raw I/O and process control. Evaluating one of these is not itself fatal, but
// each is a marker for a module heavy enough to fail at load, and none has any
// business on a path whose only job is to install two listeners.
const BOOTSTRAP_FORBIDDEN_CORE =
  "^(node:)?(fs|fs/promises|http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|inspector)$";
// ISS-11262: the renderer is a browser bundle behind contextIsolation. Vite does
// not fail on a renderer import of a Node builtin; it swaps in a browser stub
// that throws at runtime. So the renderer's static graph must never reach the
// main process, the gateway server, electron, or any Node builtin, including
// through a `src/shared` module that imports one.
const RENDERER_ENTRY = "^src/renderer/";
const MAIN_PROCESS_SOURCE = "^src/(main|server)/";
const ELECTRON_PACKAGE = "(^|[/+])electron([/@]|$)";
// Matches the bare specifier too: the resolver leaves `exports`-only subpaths
// unresolved, and an unresolved module keeps its specifier as its path.
const REALTIME_SOCKET_CLIENT = String.raw`^@repo/realtime-client/connection$|(^|/)realtime-client/src/connection\.ts$`;
const NODE_BUILTINS = `^(node:)?(${require("node:module")
  .builtinModules.map((name) => name.replace(/[/]/g, "\\/"))
  .join("|")})$`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "boot-no-design-system-runtime",
      comment:
        "Boot files must not (statically, transitively) reach the design-system dashboard runtime / OTLP receiver / collectors / db modules — the agent dashboard is lazy-loaded via dynamic import(), never on the eager boot path.",
      severity: "error",
      from: { path: BOOT_ENTRIES },
      to: { reachable: true, path: DESIGN_SYSTEM_RUNTIME },
    },
    {
      name: "bootstrap-entry-import-safe",
      comment:
        "ISS-6330: src/main/index.ts must stay import-safe. Its module graph is evaluated BEFORE the crash handlers it registers exist, so a module that throws at evaluation time here exits silently — no dialog, no telemetry — which is strictly worse than having no handler at all. The eager path is deliberately four pure-data modules (the telemetry bridge, the exception sanitizer, and the two contract modules they read constants from). Reaching the OTel runtime, a transport, a vendor SDK, or the design-system runtime from here recreates that silent startup failure. Put the dependency behind the dynamic import() of startup.js instead.",
      severity: "error",
      from: { path: BOOTSTRAP_ENTRY },
      to: { reachable: true, path: BOOTSTRAP_FORBIDDEN_REACH },
    },
    {
      name: "bootstrap-entry-no-raw-io",
      comment:
        "ISS-6330: no filesystem, network, or process-spawning builtins on the pre-handler boot path — see bootstrap-entry-import-safe.",
      severity: "error",
      from: { path: BOOTSTRAP_ENTRY },
      to: { reachable: true, path: BOOTSTRAP_FORBIDDEN_CORE },
    },
    {
      name: "app-otel-runtime-no-egress",
      comment:
        "The main-process OTel runtime may egress only via the injected keyless transport (FEA-1993; the API route since ISS-12211): no direct exporters, cloud-socket, vendor SDKs, the old observability path, or the design-system runtime.",
      severity: "error",
      from: { path: OTEL_RUNTIME_ENTRIES },
      to: {
        // Allow-list: the two sanctioned relay transport modules.
        pathNot: "relay-telemetry-transport|relay-otlp-exporters",
        path: [
          "@opentelemetry[/+]exporter-",
          String.raw`socket\.io-client`,
          "cloud-socket",
          "relay",
          "datadog",
          "posthog",
          "observability",
          "telemetry-service",
          DESIGN_SYSTEM_RUNTIME,
        ],
      },
    },
    {
      name: "app-otel-runtime-no-raw-network",
      comment: "No raw network primitives from the main-process OTel runtime.",
      severity: "error",
      from: { path: OTEL_RUNTIME_ENTRIES },
      to: {
        dependencyTypes: ["core"],
        path: "^(node:)?(http|https|net|tls|dgram)$",
      },
    },
    {
      name: "renderer-otel-runtime-local-only",
      comment:
        "The renderer OTel bridge stays local-only: no electron, zod, exporters, otlp, relay, datadog, posthog, or database.",
      severity: "error",
      from: { path: String.raw`^src/renderer/app-otel-runtime\.ts$` },
      to: {
        path: [
          "[/+]electron[/@]",
          "[/+]zod[/@]",
          "@opentelemetry[/+]exporter-",
          "otlp",
          "relay",
          "datadog",
          "posthog",
          "database",
          // Anchor on the resolved TS path — dependency-cruiser matches the real
          // `.ts` module, never a `.js` spec. `\.ts$` hits the heavy bridge
          // (which imports zod) but not its `-utils`/`-constants` siblings.
          String.raw`renderer-otel-bridge\.ts$`,
        ],
      },
    },
    {
      name: "renderer-otel-runtime-no-node",
      comment: "No node builtins in the renderer OTel bridge.",
      severity: "error",
      from: { path: String.raw`^src/renderer/app-otel-runtime\.ts$` },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "renderer-no-main-process",
      comment:
        "ISS-11262: the renderer must never (statically, transitively) import src/main, src/server, or the preload. Renderer code reaches the main process only through window.desktopApi.",
      severity: "error",
      from: { path: RENDERER_ENTRY },
      to: { reachable: true, path: MAIN_PROCESS_SOURCE },
    },
    {
      name: "renderer-no-electron",
      comment:
        "ISS-11262: electron is a main/preload dependency. The renderer runs sandboxed behind contextIsolation and cannot load it.",
      severity: "error",
      from: { path: RENDERER_ENTRY },
      to: { reachable: true, path: ELECTRON_PACKAGE },
    },
    {
      name: "renderer-no-node-builtins",
      comment:
        "ISS-11262: no Node builtin may be reachable from the renderer, including through a src/shared module. Keep node-only helpers out of any shared module the renderer imports.",
      severity: "error",
      from: { path: RENDERER_ENTRY },
      to: { reachable: true, path: NODE_BUILTINS },
    },
    {
      name: "renderer-no-realtime-socket",
      comment:
        "PLN-2162 M4 (ISS-11213 AC3): the main process holds the one realtime socket. The renderer joins channels through window.desktopApi.realtime and must never reach the realtime client that opens it.",
      severity: "error",
      from: { path: RENDERER_ENTRY },
      to: { reachable: true, path: REALTIME_SOCKET_CLIENT },
    },
    {
      name: "transcript-sync-factory-no-inline-materialize",
      comment:
        "ISS-5337: the OpenCode materialize pass re-derives the whole corpus synchronously (foreign SQLite read + per-session serialize + byte-compare), so the transcript sync factory must not import the materializer and call it in-process — that puts it back on the main event loop. Only `opencode-materialize-worker.ts`, which nothing statically imports, may reach it.",
      severity: "error",
      from: {
        path: String.raw`^src/main/transcript-sync/desktop-transcript-sync-factory\.ts$`,
      },
      to: {
        path: String.raw`^src/main/transcript-sync/opencode-materializer\.ts$`,
      },
    },
  ],
  required: [
    {
      name: "transcript-sync-materializes-off-main",
      comment:
        "ISS-5337: the transcript sync factory must keep a static dependency on the utilityProcess materialize runner — deleting it is how the pass would come back on-main. Note this pair of rules covers the STATIC forms only: `options.exclude.dynamic` keeps `import()` edges out of this graph, so a re-added lazy import of the materializer is review-owned, not gated here.",
      severity: "error",
      module: {
        path: String.raw`^src/main/transcript-sync/desktop-transcript-sync-factory\.ts$`,
      },
      to: {
        path: String.raw`^src/main/transcript-sync/utility-process-opencode-materialize-runner\.ts$`,
      },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    // Restrict the graph to STATIC VALUE imports — matching the former test,
    // which only walked `ts.isImportDeclaration` edges:
    //   tsPreCompilationDeps:false  drops type-only imports
    //   exclude.dynamic:true        drops dynamic import() edges (the sanctioned
    //                               lazy-load path for the dashboard runtime)
    tsPreCompilationDeps: false,
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: String.raw`\.(test|spec)\.ts$|/test/|/__tests__/`,
      dynamic: true,
    },
  },
};
