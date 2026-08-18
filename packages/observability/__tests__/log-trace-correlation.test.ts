import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteEnvForTest, importModuleWithFetch } from "./test-helpers";

// ---------------------------------------------------------------------------
// log.ts × trace-context.ts — trace/log correlation (ISS-4659).
//
// The load-bearing detail: enrichment happens in makeLogFn, NOT buildEntry().
// buildEntry() only feeds the agentless DD_API_KEY intake, so ids added there
// would be absent on the Vercel Log Drain path — the same asymmetry that forced
// `origin` to be stamped at the emit site. Both sinks are asserted here so a
// refactor that moves enrichment into buildEntry() fails loudly.
//
// Console spies are installed BEFORE the dynamic import because makeLogFn binds
// console.info/warn/error at module-init time; a spy installed afterwards is
// never called.
// ---------------------------------------------------------------------------

const SAMPLE_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SAMPLE_SPAN_ID = "00f067aa0ba902b7";

type LogModule = typeof import("../log");
type TraceContextModule = typeof import("../trace-context");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/**
 * Import log + trace-context from the same fresh module registry, so a provider
 * registered here is the one the logger reads.
 */
async function importLogAndTraceContext(
  fetchMock: ReturnType<typeof vi.fn>
): Promise<{ log: LogModule["log"]; traceContext: TraceContextModule }> {
  const logModule = await importModuleWithFetch(
    fetchMock,
    () => import("../log")
  );
  const traceContext = await import("../trace-context");
  return { log: logModule.log, traceContext };
}

describe("structured console sink (Vercel Log Drain path)", () => {
  it("stamps the active trace ids onto the emitted JSON line", async () => {
    deleteEnvForTest("DD_API_KEY");
    vi.stubEnv("DD_LOGS_JSON", "1");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {
      // silence
    });

    const { log, traceContext } = await importLogAndTraceContext(vi.fn());
    traceContext.setTraceContextProvider(() => ({
      traceId: SAMPLE_TRACE_ID,
      spanId: SAMPLE_SPAN_ID,
    }));
    infoSpy.mockClear();

    log.info("request_completed", { path: "/branches" });

    const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(parsed["dd.trace_id"]).toBe(SAMPLE_TRACE_ID);
    expect(parsed["dd.span_id"]).toBe(SAMPLE_SPAN_ID);
    expect(parsed.path).toBe("/branches");
  });

  it("emits no correlation keys at all when nothing is traced", async () => {
    deleteEnvForTest("DD_API_KEY");
    vi.stubEnv("DD_LOGS_JSON", "1");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {
      // silence
    });

    const { log } = await importLogAndTraceContext(vi.fn());
    infoSpy.mockClear();

    log.info("request_completed", { path: "/branches" });

    const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(parsed).not.toHaveProperty("dd.trace_id");
    expect(parsed).not.toHaveProperty("dd.span_id");
  });

  it("ignores caller-supplied trace ids so meta cannot spoof a trace", async () => {
    deleteEnvForTest("DD_API_KEY");
    vi.stubEnv("DD_LOGS_JSON", "1");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // silence
    });

    const { log, traceContext } = await importLogAndTraceContext(vi.fn());
    traceContext.setTraceContextProvider(() => ({
      traceId: SAMPLE_TRACE_ID,
      spanId: SAMPLE_SPAN_ID,
    }));
    warnSpy.mockClear();

    log.warn("suspicious", {
      "dd.trace_id": "attacker-supplied",
      "dd.span_id": "attacker-supplied",
    });

    const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(parsed["dd.trace_id"]).toBe(SAMPLE_TRACE_ID);
    expect(parsed["dd.span_id"]).toBe(SAMPLE_SPAN_ID);
  });
});

describe("agentless Datadog intake sink", () => {
  it("carries the trace ids in the flushed intake payload", async () => {
    vi.stubEnv("DD_API_KEY", "dd-test-key");
    vi.stubEnv("DD_SITE", "datadoghq.com");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });

    const { log, traceContext } = await importLogAndTraceContext(fetchMock);
    traceContext.setTraceContextProvider(() => ({
      traceId: SAMPLE_TRACE_ID,
      spanId: SAMPLE_SPAN_ID,
    }));

    log.info("request_completed", { path: "/branches" });
    await log.flush();

    // Select by message: the batch also carries module-init diagnostics
    // (telemetry.git_sha_fallback) that are enqueued before this call, so a
    // positional index would assert against the wrong entry.
    const entries = JSON.parse(
      fetchMock.mock.calls[0][1].body as string
    ) as Record<string, unknown>[];
    const entry = entries.find(
      (candidate) => candidate.message === "request_completed"
    );
    expect(entry).toBeDefined();
    expect(entry?.["dd.trace_id"]).toBe(SAMPLE_TRACE_ID);
    expect(entry?.["dd.span_id"]).toBe(SAMPLE_SPAN_ID);
  });
});
