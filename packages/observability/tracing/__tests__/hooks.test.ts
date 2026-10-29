import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteEnvForTest } from "../../__tests__/test-helpers";
import {
  flushSpans,
  isTracingActive,
  resetSpanFlushHook,
  setSpanFlushHook,
} from "../hooks";

// ---------------------------------------------------------------------------
// tracing/hooks.ts — the flush seam survives bundling (ISS-6817).
//
// Sibling of `__tests__/trace-context.test.ts`. The `apps/api` Turbopack build
// emits this module into three chunk groups, and 265 of 283 route entries load
// a route-side copy that `./provider` never reaches. With the hook in a
// module-local `let`, that copy's binding had no writer at all — the bundler
// tree-shook `setSpanFlushHook` out of it — so `isTracingActive()` was
// unconditionally false on every route and the pre-freeze span flush never ran.
//
// These cases pin the two halves of the fix: the slot is shared across module
// instances, and it is still unwritable and unreadable from a browser.
// ---------------------------------------------------------------------------

/**
 * The registered-symbol key is discoverable by anything sharing the realm, so
 * this is the write a third-party script or an XSS payload can make. Spelling
 * it out literally is the point: it is the attacker's view of the key, not a
 * second declaration of ours.
 */
function plantHookOnGlobalThis(hook: () => Promise<void>): void {
  (globalThis as Record<symbol, unknown>)[
    Symbol.for("closedloop.observability.spanFlushHook")
  ] = hook;
}

// The slot is process-wide, so the unregistered state these cases assert
// against has to be established, not assumed from a fresh module registry.
beforeEach(() => {
  resetSpanFlushHook();
});

afterEach(() => {
  resetSpanFlushHook();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Everything the tracer bootstrap needs to reach its enabled branch. The
 * higher-priority inputs are cleared explicitly so an inherited local or CI
 * value cannot decide the branch instead.
 */
function enableTracingEnv(): void {
  deleteEnvForTest("DD_TRACING_DISABLED", "DD_TRACE_SAMPLE_RATE", "VERCEL");
  vi.stubEnv("DD_TRACING_ENABLED", "1");
  vi.stubEnv("DD_API_KEY", "dd-test-key");
  vi.stubEnv("DD_OTLP_TRACES_ENDPOINT", "https://otlp.example.test/v1/traces");
}

describe("cross-bundle hook registration (ISS-6817)", () => {
  it("runs a hook registered on another module instance", async () => {
    vi.resetModules();
    // Stands in for the instrumentation entry's copy of this module: the one
    // `tracing/provider.ts` registers on, which is not the copy the route
    // handlers read. A second module registry reproduces that split here.
    const registrar = await import("../hooks");

    // Guard the guard: same instance on both sides and the assertions below
    // would hold for the ordinary single-module reason, proving nothing about
    // the split this test exists for.
    expect(registrar.setSpanFlushHook).not.toBe(setSpanFlushHook);

    const hook = vi.fn(() => Promise.resolve());
    registrar.setSpanFlushHook(hook);

    // Read and flush through the STATICALLY imported copy — the route side.
    expect(isTracingActive()).toBe(true);
    await flushSpans();

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("reaches a hook the real tracer bootstrap registered elsewhere", async () => {
    enableTracingEnv();
    vi.resetModules();
    // The production wiring, not a hand-registered stand-in: `provider.ts` and
    // the `hooks` copy it calls `setSpanFlushHook` on both live in the
    // instrumentation chunk, which is never the copy a route handler reads.
    // The static import at the top of this file is that route-side copy.
    const provider = await import("../provider");

    try {
      expect(provider.initTracing().enabled).toBe(true);

      expect(isTracingActive()).toBe(true);
      await expect(flushSpans()).resolves.toBeUndefined();
    } finally {
      await provider.resetTracingForTest();
    }
  });

  it("clears the hook for every module instance", async () => {
    vi.resetModules();
    const registrar = await import("../hooks");
    registrar.setSpanFlushHook(() => Promise.resolve());

    registrar.resetSpanFlushHook();

    expect(isTracingActive()).toBe(false);
  });
});

describe("flushSpans", () => {
  it("swallows a rejecting hook rather than failing the caller", async () => {
    // `forceFlush()` rejects on any OTLP export failure, and the route path
    // now awaits this inside an `after()` callback on every traced request.
    setSpanFlushHook(() => Promise.reject(new Error("export failed")));

    await expect(flushSpans()).resolves.toBeUndefined();
  });

  it("treats a non-callable value in the slot as no tracer", async () => {
    // The slot is writable by anything sharing the realm. Reporting active for
    // a value that cannot be invoked would schedule an `after()` callback per
    // request for a flush that can never run.
    (globalThis as Record<symbol, unknown>)[
      Symbol.for("closedloop.observability.spanFlushHook")
    ] = null;

    expect(isTracingActive()).toBe(false);
    await expect(flushSpans()).resolves.toBeUndefined();
  });
});

describe("browser runtimes (ISS-6817)", () => {
  it("ignores a hook planted on globalThis by browser-side code", async () => {
    vi.stubGlobal("window", {});
    vi.resetModules();
    const browserModule = await import("../hooks");
    const planted = vi.fn(() => Promise.resolve());
    plantHookOnGlobalThis(planted);

    expect(browserModule.isTracingActive()).toBe(false);
    await browserModule.flushSpans();

    expect(planted).not.toHaveBeenCalled();
  });

  it("still honors a planted hook on the server, so the gate is what differs", async () => {
    vi.resetModules();
    const serverModule = await import("../hooks");
    const planted = vi.fn(() => Promise.resolve());
    plantHookOnGlobalThis(planted);

    expect(serverModule.isTracingActive()).toBe(true);
    await serverModule.flushSpans();

    expect(planted).toHaveBeenCalledTimes(1);
  });

  it("does not write the slot from a browser runtime", async () => {
    vi.stubGlobal("window", {});
    vi.resetModules();
    const browserModule = await import("../hooks");

    browserModule.setSpanFlushHook(() => Promise.resolve());

    // Read back through the SERVER module: a browser write must not become
    // visible to the server copy sharing the same realm.
    expect(isTracingActive()).toBe(false);
  });

  // Review finding (davetho): a DELETE is a write too. `resetSpanFlushHook`
  // was the one slot-touching function here with no gate, so a browser copy
  // could clear a same-realm value the module says it must not touch — the
  // invariant the other two functions enforce, contradicted by the third.
  it("does not clear the slot from a browser runtime", async () => {
    const planted = vi.fn(() => Promise.resolve());
    plantHookOnGlobalThis(planted);
    vi.stubGlobal("window", {});
    vi.resetModules();
    const browserModule = await import("../hooks");

    browserModule.resetSpanFlushHook();

    // Read back through the SERVER module: the planted value has to have
    // survived the browser copy's reset.
    expect(isTracingActive()).toBe(true);
    await flushSpans();
    expect(planted).toHaveBeenCalledTimes(1);
  });
});
