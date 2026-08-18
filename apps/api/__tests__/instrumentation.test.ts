import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TracingConfig } from "@repo/observability/tracing/config";
import { TracingDisabledReason } from "@repo/observability/tracing/config";
import ts from "typescript6";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FEA-3300: pool telemetry reaches Datadog only because `register()` injects the
 * emitter into `@repo/database` — that package cannot import
 * `@repo/observability` itself (apps/mcp packages it through a narrow Docker
 * context). If this wiring is ever dropped, the pool goes quiet silently and an
 * unwired emitter looks exactly like a healthy pool. This test is the guard.
 */
const mocks = vi.hoisted(() => ({
  setPoolTelemetrySink: vi.fn(),
  setSchemaBootstrapHook: vi.fn(),
  emitDbPoolMetric: vi.fn(),
  assertRunnerSecretConfigured: vi.fn(),
  // No default impl here: `vi.hoisted` runs before module imports initialize,
  // so `TracingDisabledReason` is still in its temporal dead zone. The default
  // is set from the const in `beforeEach` instead of hardcoding the literal.
  initTracing: vi.fn<() => TracingConfig>(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/origin", () => ({
  ORIGIN: "api",
}));

vi.mock("@repo/auth/runner-jwt-base", () => ({
  assertRunnerSecretConfigured: mocks.assertRunnerSecretConfigured,
  RUNNER_JWT_SECRET_ENV: "RUNNER_JWT_SECRET",
}));

vi.mock("@repo/database", () => ({
  setPoolTelemetrySink: mocks.setPoolTelemetrySink,
  setSchemaBootstrapHook: mocks.setSchemaBootstrapHook,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitDbPoolMetric: mocks.emitDbPoolMetric,
}));

// ISS-4659: mocked so this stays a unit test — the real provider would pull the
// OpenTelemetry Node SDK into the suite.
vi.mock("@repo/observability/tracing/provider", () => ({
  initTracing: mocks.initTracing,
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: mocks.logInfo, warn: mocks.logWarn },
}));

const SAMPLE = {
  metric: "db_pool_acquire_wait",
  value: 1234,
  poolMax: 20,
  waitingCount: 3,
  inUse: 20,
  idle: 0,
  total: 20,
} as const;

describe("apps/api register()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    mocks.initTracing.mockReturnValue({
      enabled: false,
      reason: TracingDisabledReason.NotDeployed,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("installs the pool telemetry sink", async () => {
    const { register } = await import("../instrumentation");

    await register();

    expect(mocks.setPoolTelemetrySink).toHaveBeenCalledTimes(1);
    expect(mocks.setPoolTelemetrySink.mock.calls[0]?.[0]).toBeTypeOf(
      "function"
    );
  });

  it("stamps origin onto every sample, since the Log Drain path has no other source for it", async () => {
    const { register } = await import("../instrumentation");
    await register();
    const sink = mocks.setPoolTelemetrySink.mock.calls[0]?.[0] as (
      sample: typeof SAMPLE
    ) => void;

    sink(SAMPLE);

    expect(mocks.emitDbPoolMetric).toHaveBeenCalledWith({
      ...SAMPLE,
      origin: "api",
    });
  });

  it("still asserts the runner secret is configured", async () => {
    const { register } = await import("../instrumentation");

    await register();

    expect(mocks.assertRunnerSecretConfigured).toHaveBeenCalledWith(
      "RUNNER_JWT_SECRET"
    );
  });
});

/**
 * ISS-4659: the tracer starts from the same hook. The runtime guard matters —
 * register() also runs on the edge runtime that serves proxy.ts middleware,
 * where the OpenTelemetry Node SDK cannot load.
 */
describe("apps/api register() — tracing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initTracing.mockReturnValue({
      enabled: false,
      reason: TracingDisabledReason.NotDeployed,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not start the tracer outside the node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const { register } = await import("../instrumentation");

    await register();

    expect(mocks.initTracing).not.toHaveBeenCalled();
    expect(mocks.setPoolTelemetrySink).not.toHaveBeenCalled();
  });

  it("starts the tracer on the node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { register } = await import("../instrumentation");

    await register();

    expect(mocks.initTracing).toHaveBeenCalledTimes(1);
  });

  it("starts the tracer before anything can pull pg in through @repo/database", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { register } = await import("../instrumentation");

    await register();

    // The AST guard below proves both modules are imported dynamically; it
    // cannot see WHICH runs first. That order is the whole point:
    // PgInstrumentation patches `pg` at require time and @repo/database imports
    // pg at module scope, so wiring the pool sink first would load pg before
    // the patch and every DB child span would go silently missing.
    expect(mocks.initTracing.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setPoolTelemetrySink.mock.invocationCallOrder[0]
    );
    // ISS-5984 added a second `@repo/database` injection behind the same
    // constraint: it must not be the edge that loads pg ahead of the patch.
    expect(mocks.initTracing.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setSchemaBootstrapHook.mock.invocationCallOrder[0]
    );
  });

  /**
   * ISS-5984: the lazy preview-schema bootstrap runs inside `getDatabase()`, and
   * this injection is the ONLY thing that puts it there. Dropped, a preview
   * whose schema does not exist yet fails every query with no bootstrap
   * attempted — and, like the pool sink, an unwired hook is indistinguishable
   * from a healthy one.
   */
  it("installs the preview-schema bootstrap hook", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { register } = await import("../instrumentation");

    await register();

    expect(mocks.setSchemaBootstrapHook).toHaveBeenCalledTimes(1);
    expect(mocks.setSchemaBootstrapHook.mock.calls[0]?.[0]).toBeTypeOf(
      "function"
    );
  });

  it("stays quiet when tracing is off because this is not a deployed runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    mocks.initTracing.mockReturnValueOnce({
      enabled: false,
      reason: TracingDisabledReason.NotDeployed,
    });
    const { register } = await import("../instrumentation");

    await register();

    // Local and CI runs are expected to be untraced; warning on every one of
    // them would train operators to ignore the warning that matters.
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("warns when tracing is off for a reason an operator should act on", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    mocks.initTracing.mockReturnValueOnce({
      enabled: false,
      reason: TracingDisabledReason.MissingEndpoint,
    });
    const { register } = await import("../instrumentation");

    await register();

    // A tracer that never started looks identical to a service with no
    // traffic; this warning is the only thing that distinguishes them.
    expect(mocks.logWarn).toHaveBeenCalledWith("telemetry.tracing_disabled", {
      reason: TracingDisabledReason.MissingEndpoint,
    });
  });
});

/**
 * ISS-4659: module-evaluation order in the instrumentation modules is
 * load-bearing, and
 * the behavioural tests above cannot see it — they mock both modules away, so
 * they pass whether the imports are static or dynamic.
 *
 * Three invariants, all invisible at runtime until they bite in production:
 *
 * 1. `instrumentation.ts` must not reach the OpenTelemetry Node SDK from a
 *    static (non-deferred) import, or the edge runtime that serves `proxy.ts`
 *    loads it before the `NEXT_RUNTIME` guard can run.
 * 2. `instrumentation.ts` must not statically import `@repo/database` either —
 *    same reason, plus the pg-patch race below.
 * 3. Neither must `instrumentation.node.ts`, which is the module that actually
 *    orders the two calls. `packages/database/index.ts` imports `pg` at module
 *    scope (and `@prisma/adapter-pg`, which depends on `pg`), while
 *    `PgInstrumentation` patches `pg` at require time. A static import here
 *    would materialise `pg` before `registerTracing()` runs and every DB child
 *    span would go silently missing for the life of the process — and the
 *    behavioural tests above would stay green, because they mock
 *    `@repo/database` away entirely.
 *
 * Checked over the real AST (`ts.createSourceFile`), not a text scan, so a
 * rename or reformat cannot make it pass vacuously. `forbiddenStaticImports`
 * is also run against synthetic sources below, so the guard is shown to reject
 * a static import rather than merely to return nothing.
 */
describe("apps/api instrumentation — import evaluation order", () => {
  /** `instrumentation.ts` is compiled for every runtime, including edge. */
  const ENTRYPOINT_DEFERRED_MODULES = [
    "./instrumentation.node",
    "@repo/observability/tracing/provider",
    "@repo/database",
  ];

  /**
   * `instrumentation.node.ts` only ever runs on the node runtime, so the edge
   * concern does not reach it — the pg patch race does.
   *
   * `@repo/observability/tracing/provider` is deliberately absent: its dynamic
   * import is load-bearing for a different reason (it sits inside
   * `registerTracing`'s fail-open `try`), and
   * `instrumentation-tracing-import-failure.test.ts` already fails if it turns
   * static, because the throwing module mock would then reject `register()`.
   */
  const NODE_DEFERRED_MODULES = ["@repo/database"];

  function parseModule(fileName: string): ts.SourceFile {
    const filePath = join(import.meta.dirname, "..", fileName);
    return ts.createSourceFile(
      filePath,
      readFileSync(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
  }

  function parseFixture(source: string): ts.SourceFile {
    return ts.createSourceFile(
      "fixture.ts",
      source,
      ts.ScriptTarget.Latest,
      true
    );
  }

  /**
   * Specifiers of the import declarations that actually load a module.
   *
   * A declaration-level `import type` is erased by the compiler and can load
   * nothing, so it is excluded. A side-effect import (`import "m"`) has no
   * import clause at all and is kept — it loads the module just as a named one
   * does.
   */
  function loadingImportSpecifiers(sourceFile: ts.SourceFile): string[] {
    return sourceFile.statements
      .filter(ts.isImportDeclaration)
      .filter((statement) => statement.importClause?.isTypeOnly !== true)
      .map((statement) => statement.moduleSpecifier)
      .filter(ts.isStringLiteral)
      .map((specifier) => specifier.text);
  }

  /** The guard itself: which deferred modules this source loads eagerly. */
  function forbiddenStaticImports(
    sourceFile: ts.SourceFile,
    deferred: readonly string[]
  ): string[] {
    return loadingImportSpecifiers(sourceFile).filter((specifier) =>
      deferred.includes(specifier)
    );
  }

  it("keeps instrumentation.ts free of the runtime-sensitive imports", () => {
    expect(
      forbiddenStaticImports(
        parseModule("instrumentation.ts"),
        ENTRYPOINT_DEFERRED_MODULES
      )
    ).toEqual([]);
  });

  it("still statically imports the modules that are safe on every runtime", () => {
    // Guards the inverse: a change that defers everything would make the
    // assertion above pass while breaking the eager runner-secret assertion.
    expect(
      loadingImportSpecifiers(parseModule("instrumentation.ts"))
    ).toContain("@repo/auth/runner-jwt-base");
  });

  it("keeps instrumentation.node.ts from materialising pg before the tracer", () => {
    expect(
      forbiddenStaticImports(
        parseModule("instrumentation.node.ts"),
        NODE_DEFERRED_MODULES
      )
    ).toEqual([]);
  });

  it("still statically imports the node-safe modules that cannot pull pg", () => {
    // Same inverse guard: deferring everything would satisfy the assertion
    // above without the module doing its job.
    expect(
      loadingImportSpecifiers(parseModule("instrumentation.node.ts"))
    ).toContain("@repo/observability/log");
  });

  it("rejects a static @repo/database import, named or side-effect", () => {
    // The counterfactual. Without this, the assertions above are satisfied by
    // any reader that returns nothing — including a broken one.
    expect(
      forbiddenStaticImports(
        parseFixture('import { setPoolTelemetrySink } from "@repo/database";'),
        NODE_DEFERRED_MODULES
      )
    ).toEqual(["@repo/database"]);
    expect(
      forbiddenStaticImports(
        parseFixture('import "@repo/database";'),
        NODE_DEFERRED_MODULES
      )
    ).toEqual(["@repo/database"]);
  });

  it("ignores an erased `import type`, which loads nothing at runtime", () => {
    expect(
      forbiddenStaticImports(
        parseFixture(
          'import type { PoolTelemetrySample } from "@repo/database";'
        ),
        NODE_DEFERRED_MODULES
      )
    ).toEqual([]);
  });

  it("accepts the deferred shape production uses", () => {
    expect(
      forbiddenStaticImports(
        parseFixture(
          'async function f() { const { setPoolTelemetrySink } = await import("@repo/database"); }'
        ),
        NODE_DEFERRED_MODULES
      )
    ).toEqual([]);
  });
});
