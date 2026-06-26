/**
 * `@closedloop-ai/loops-api/observability` — harness-portable loop observability
 * (Q-001/D-005).
 *
 * SSOT for the raw `loop.perf.*` event model plus the harness adapter contract,
 * registry, run envelope, and Claude/Codex adapters. The desktop emit pipeline
 * (sanitization, phase attribution, Datadog category mapping) imports the raw
 * schema from here; ECS can reuse the adapters without importing `apps/desktop`.
 */

// biome-ignore lint/performance/noBarrelFile: intentional package subpath entry — `@closedloop-ai/loops-api/observability` aggregates the observability module behind one export, mirroring the package's other subpath entries.
export * from "./observability/adapter-contract";
export * from "./observability/claude-observability-adapter";
export * from "./observability/codex-observability-adapter";
export * from "./observability/loop-run-envelope";
export * from "./observability/observability-adapter-registry";
export * from "./observability/perf-events";
export * from "./observability/truncate-utf8";
