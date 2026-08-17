import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript6";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// route-utils flush scheduling (ISS-4659).
//
// Deferred work per request is a contract, not an implementation detail:
// `__tests__/unit/with-api-key-auth.test.ts` and
// `__tests__/integration/branch-artifact-flows.test.ts` both pin how many
// `waitUntil` promises a request schedules. Adding the span flush initially
// broke both, because it scheduled telemetry work on every request even with
// no tracer installed — which is every local run and every CI worker.
//
// The rule this file guards: schedule span-flush work only when a tracer is
// actually active, and when it is, use `after()` so the flush runs once Next
// has closed the route span rather than while it is still open.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  // The real `waitUntil` takes ownership of the promise it is handed. A bare
  // `vi.fn()` does not, so a rejected promise passed to it surfaces as an
  // unhandled rejection and fails the whole suite. Mirror the real contract.
  waitUntil: vi.fn((promise?: unknown) => {
    if (promise instanceof Promise) {
      promise.catch(() => undefined);
    }
  }),
  after: vi.fn(),
  flushSpans: vi.fn(() => Promise.resolve()),
  isTracingActive: vi.fn(() => false),
  logFlush: vi.fn(() => Promise.resolve()),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

vi.mock("next/server", () => ({
  after: mocks.after,
  NextResponse: { json: vi.fn() },
}));

vi.mock("@repo/observability/tracing/hooks", () => ({
  flushSpans: mocks.flushSpans,
  isTracingActive: mocks.isTracingActive,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: mocks.logFlush,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTracingActive.mockReturnValue(false);
});

afterEach(() => {
  vi.resetModules();
});

describe("scheduleLogFlush with tracing inactive", () => {
  it("schedules only the log flush, adding no deferred telemetry work", async () => {
    const { scheduleLogFlush } = await import("../route-utils");

    scheduleLogFlush();

    // Exactly one waitUntil — the log flush. A second one here is what broke
    // the two suites named above.
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.flushSpans).not.toHaveBeenCalled();
  });
});

describe("scheduleLogFlush with tracing active", () => {
  it("defers the span flush through after() so the route span has closed", async () => {
    mocks.isTracingActive.mockReturnValue(true);
    const { scheduleLogFlush } = await import("../route-utils");

    scheduleLogFlush();

    expect(mocks.after).toHaveBeenCalledTimes(1);
    // Not called yet — after() defers it past the response. Calling it inline
    // would flush while Next's route span is still open.
    expect(mocks.flushSpans).not.toHaveBeenCalled();

    const deferred = mocks.after.mock.calls[0][0] as () => unknown;
    deferred();

    expect(mocks.flushSpans).toHaveBeenCalledTimes(1);
  });

  it("waits for scheduleLogFlushAfter's deferred work before flushing spans", async () => {
    mocks.isTracingActive.mockReturnValue(true);
    let settle: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const { scheduleLogFlushAfter } = await import("../route-utils");

    scheduleLogFlushAfter(pending);
    const deferred = mocks.after.mock.calls[0][0] as () => Promise<unknown>;
    const flushed = deferred();

    // Callers use this form because work is still running past the response —
    // and that work emits spans. Flushing before it finishes would export the
    // buffer as it stands and let those spans freeze with the function.
    expect(mocks.flushSpans).not.toHaveBeenCalled();

    settle();
    await flushed;

    expect(mocks.flushSpans).toHaveBeenCalledTimes(1);
  });

  it("still flushes spans when the deferred work rejects", async () => {
    mocks.isTracingActive.mockReturnValue(true);
    const pending = Promise.reject(new Error("deferred work failed"));
    // Attach a handler in the same tick. The `await import(...)` below turns
    // the microtask queue over, and Node flags a rejected promise with no
    // handler by then — which fails the run even though every test passes.
    pending.catch(() => undefined);
    const { scheduleLogFlushAfter } = await import("../route-utils");

    scheduleLogFlushAfter(pending);
    const deferred = mocks.after.mock.calls[0][0] as () => Promise<unknown>;

    await expect(deferred()).resolves.toBeUndefined();
    expect(mocks.flushSpans).toHaveBeenCalledTimes(1);
  });

  it("falls back to waitUntil when there is no request scope for after()", async () => {
    mocks.isTracingActive.mockReturnValue(true);
    mocks.after.mockImplementation(() => {
      throw new Error("after() called outside a request scope");
    });
    const { scheduleLogFlush } = await import("../route-utils");

    expect(() => scheduleLogFlush()).not.toThrow();

    // Log flush + the fallback span flush. Without the fallback, the
    // container/custom-server path would never flush spans at all.
    expect(mocks.waitUntil).toHaveBeenCalledTimes(2);
    expect(mocks.flushSpans).toHaveBeenCalledTimes(1);
  });
});

/**
 * ISS-4659: `route-utils.ts` is imported by ~40 route modules. If it reached
 * the OpenTelemetry Node SDK through a static import, the first route that ever
 * opts into the edge runtime would fail to build — the same evaluation-order
 * trap `apps/api/instrumentation.ts` guards against.
 *
 * The flush therefore goes through `@repo/observability/tracing/hooks`, which
 * has no OTel import; only `tracing/provider` touches the SDK. Checked over the
 * real AST so a reformat cannot make it pass vacuously.
 */
describe("route-utils.ts — SDK reachability", () => {
  it("imports the SDK-free tracing seam, never the provider", () => {
    const filePath = join(import.meta.dirname, "..", "route-utils.ts");
    const sourceFile = ts.createSourceFile(
      filePath,
      readFileSync(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    const specifiers = sourceFile.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => statement.moduleSpecifier)
      .filter(ts.isStringLiteral)
      .map((specifier) => specifier.text);

    expect(specifiers).toContain("@repo/observability/tracing/hooks");
    expect(specifiers).not.toContain("@repo/observability/tracing/provider");
  });
});
