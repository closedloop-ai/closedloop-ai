"use strict";

// Desktop module-boundary rules (replaces the hand-rolled AST BFS in the former
// test/agent-dashboard-boundary.test.ts). dependency-cruiser resolves the real
// TS module graph, so it expresses transitive reachability natively and handles
// resolution / edge-type exclusion for us. Run from apps/desktop:
//   depcruise src --config scripts/dependency-cruiser.config.cjs

const OTEL_RUNTIME_ENTRIES = String.raw`^src/(main/(telemetry/app-otel-runtime|telemetry/app-otel-runtime-lifecycle|ipc/renderer-otel-ipc)|shared/(exception-sanitizer|renderer-otel-bridge-constants|renderer-otel-bridge-utils|renderer-otel-bridge))\.ts$`;
const BOOT_ENTRIES = String.raw`^src/main/(index|startup|app|window)\.ts$`;
const DESIGN_SYSTEM_RUNTIME = String.raw`^src/main/(dashboard/agent-dashboard-design-system-runtime|agent-monitor/agent-monitor-listener|telemetry/otlp-http-receiver)\.ts$|^src/main/(otlp|collectors|database)/`;

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
      name: "app-otel-runtime-no-egress",
      comment:
        "The main-process OTel runtime may egress only via the sanctioned relay transport (FEA-1993): no direct exporters, cloud-socket, vendor SDKs, the old observability path, or the design-system runtime.",
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
