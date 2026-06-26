import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryCategory } from "../telemetry/schema";
import {
  deleteEnvForTest,
  importLogWithFetch,
  parseFlushedBody,
} from "./test-helpers";

const DDTAGS_RE = /env:[^,]+,version:[^,]+,git_sha:[^,]+/;
const DDTAGS_SEGMENT_RE = /^[^:]+:[^:]+$/;

// ---------------------------------------------------------------------------
// log.ts — ddtags field and module-load-time warning behaviour
//
// Each test calls vi.resetModules() then dynamically imports log.ts so the
// module-level DD constant is re-evaluated with the stubbed env vars.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("../keys");
});

// ---------------------------------------------------------------------------
// (a) ddtags contains env:, version:, and git_sha: segments
// ---------------------------------------------------------------------------

describe("ddtags format — all three segments present", () => {
  it("includes env:, version:, and git_sha: in the flushed payload", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.2.3");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123def456");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("test message");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ ddtags: string }>(fetchMock);
    expect(body[0].ddtags).toMatch(DDTAGS_RE);
  });
});

// ---------------------------------------------------------------------------
// (b) version:unknown and git_sha:unknown when all version/sha env vars unset
// ---------------------------------------------------------------------------

describe("ddtags fallback values — version and git_sha unknown", () => {
  it("uses version:unknown and git_sha:unknown when all related env vars are absent", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    // vi.stubEnv(key, undefined) coerces to the literal string "undefined"
    // and would leave process.env.KEY truthy, so it does not exercise the
    // nullish-fallback branch. deleteEnvForTest removes the keys AND registers
    // a restore callback — vi.unstubAllEnvs() does not roll back deleted keys,
    // so any parent-env value (CI, dev shell) would otherwise leak to later
    // tests in the same worker.
    deleteEnvForTest(
      "RELEASE_VERSION",
      "npm_package_version",
      "VERCEL_GIT_COMMIT_SHA",
      "GIT_SHA"
    );

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("fallback test");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ ddtags: string }>(fetchMock);
    expect(body[0].ddtags).toContain("version:unknown");
    expect(body[0].ddtags).toContain("git_sha:unknown");
  });
});

// ---------------------------------------------------------------------------
// (b2) service fallback — DD_SERVICE unset → body[0].service === 'cl-unknown'
// ---------------------------------------------------------------------------

describe("service fallback — DD_SERVICE unset", () => {
  it("sets top-level service field to 'cl-unknown' when DD_SERVICE is not set", async () => {
    deleteEnvForTest("DD_SERVICE");
    vi.stubEnv("DD_API_KEY", "test-key");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("service fallback test");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ service: string }>(fetchMock);
    expect(body[0].service).toBe("cl-unknown");
  });
});

// ---------------------------------------------------------------------------
// (b3) service fallback via catch branch — keys() throws AND DD_SERVICE unset
// ---------------------------------------------------------------------------

describe("service fallback via catch branch — DD_SERVICE unset", () => {
  it("falls back to 'cl-unknown' when keys() throws and DD_SERVICE is absent", async () => {
    deleteEnvForTest("DD_SERVICE");
    vi.stubEnv("DD_API_KEY", "test-key");

    vi.doMock("../keys", () => ({
      keys: () => {
        throw new Error("Not a Next.js context");
      },
    }));

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.resetModules();
    vi.stubGlobal("fetch", fetchMock);
    const { log } = await import("../log");

    log.info("catch-branch service fallback");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ service: string }>(fetchMock);
    expect(body[0].service).toBe("cl-unknown");
  });
});

// ---------------------------------------------------------------------------
// (b4) DD_SERVICE empty-string — warning fires, keys() normalizes to fallback
// keys.ts has emptyStringAsUndefined: true, so "" → undefined → "cl-unknown"
// ---------------------------------------------------------------------------

describe("DD_SERVICE empty-string — warning fires, falls back to cl-unknown", () => {
  it("warns when DD_SERVICE='' and falls back to 'cl-unknown' via emptyStringAsUndefined", async () => {
    deleteEnvForTest("DD_SERVICE");
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", "");
    vi.stubEnv("DD_API_KEY", "test-key");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const { log } = await import("../log");

    log.info("empty service");
    await log.flush();

    // Warning guard uses "!process.env.DD_SERVICE" (falsy) → fires for ""
    const calls = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(calls.filter((m) => m.includes("dd_service_fallback"))).toHaveLength(
      1
    );

    // keys.ts emptyStringAsUndefined: true converts "" → undefined,
    // then "?? cl-unknown" fires. In the catch branch (no Next.js),
    // process.env.DD_SERVICE ?? "cl-unknown" also yields "cl-unknown"
    // because vi.stubEnv("DD_SERVICE", "") + emptyStringAsUndefined
    // means the resolved value is always the fallback.
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ service: string }>(fetchMock);
    expect(body[0].service).toBe("cl-unknown");
  });
});

// ---------------------------------------------------------------------------
// (c) Fallback warnings emitted exactly once at module load, not per log call
// ---------------------------------------------------------------------------

describe("module-load warnings — emitted once regardless of log call count", () => {
  it("emits exactly one version_fallback and one git_sha_fallback warning at load, not per log.info call", async () => {
    // deleteEnvForTest registers a restore callback so parent-env values
    // (CI, dev shell) do not leak into later tests in the same worker —
    // vi.unstubAllEnvs() only reverts vi.stubEnv calls, not deletions.
    deleteEnvForTest(
      "RELEASE_VERSION",
      "npm_package_version",
      "VERCEL_GIT_COMMIT_SHA",
      "GIT_SHA"
    );
    // No DD_API_KEY — keep it absent so log.info doesn't enqueue (simplifies test)

    vi.resetModules();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("../log");

    // Warnings must have fired during module evaluation
    const warningMessages = warnSpy.mock.calls.map((args) => String(args[0]));
    const versionWarnings = warningMessages.filter((m) =>
      m.includes("telemetry.version_fallback")
    );
    const gitShaWarnings = warningMessages.filter((m) =>
      m.includes("telemetry.git_sha_fallback")
    );

    expect(versionWarnings).toHaveLength(1);
    expect(gitShaWarnings).toHaveLength(1);

    // Re-import the already-loaded module (same instance) and call log.info multiple times
    const { log } = await import("../log");
    log.info("call one");
    log.info("call two");
    log.info("call three");

    // Warning count must not grow — they were only from module load
    const warningMessagesAfter = warnSpy.mock.calls.map((args) =>
      String(args[0])
    );
    const versionWarningsAfter = warningMessagesAfter.filter((m) =>
      m.includes("telemetry.version_fallback")
    );
    const gitShaWarningsAfter = warningMessagesAfter.filter((m) =>
      m.includes("telemetry.git_sha_fallback")
    );

    expect(versionWarningsAfter).toHaveLength(1);
    expect(gitShaWarningsAfter).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (c2) dd_service_fallback warning emitted once at module load, not per log call
// ---------------------------------------------------------------------------

describe("module-load warnings — dd_service_fallback emitted once", () => {
  it("emits exactly one dd_service_fallback warning at load, not per log.info call", async () => {
    // deleteEnvForTest registers a restore callback so parent-env values
    // (CI, dev shell) do not leak into later tests in the same worker —
    // vi.unstubAllEnvs() only reverts vi.stubEnv calls, not deletions.
    deleteEnvForTest("DD_SERVICE");

    vi.resetModules();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("../log");

    // Warnings must have fired during module evaluation.
    // origin_fallback also fires here (DD_SERVICE absent triggers both warnings) — filter by event name, not total call count
    const calls = warnSpy.mock.calls.map((args) => String(args[0]));
    const serviceWarnings = calls.filter((m) =>
      m.includes("dd_service_fallback")
    );

    expect(serviceWarnings).toHaveLength(1);

    // Re-import the already-loaded module (same instance) and call log.info multiple times
    const { log } = await import("../log");
    log.info("a");
    log.info("b");
    log.info("c");

    // Warning count must not grow — dd_service_fallback was only from module load
    const callsAfter = warnSpy.mock.calls.map((args) => String(args[0]));
    const serviceWarningsAfter = callsAfter.filter((m) =>
      m.includes("dd_service_fallback")
    );

    expect(serviceWarningsAfter).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (c3) dd_service_fallback warning NOT emitted when DD_SERVICE is set
// ---------------------------------------------------------------------------

describe("module-load warnings — dd_service_fallback absent when DD_SERVICE is set", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  it("does not emit dd_service_fallback when DD_SERVICE is set to a known origin", async () => {
    deleteEnvForTest("DD_SERVICE");
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", "api");

    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("../log");

    const calls = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      calls.filter((m: string) => m.includes("dd_service_fallback"))
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (d) Relay fallback — keys() throws, loadConfig() catch branch produces valid ddtags
// ---------------------------------------------------------------------------

describe("loadConfig() fallback when keys() throws", () => {
  it("produces a valid ddtags string when keys() throws (relay / non-Next context)", async () => {
    vi.stubEnv("DD_API_KEY", "relay-key");
    vi.stubEnv("DD_ENV", "staging");
    vi.stubEnv("DD_SITE", "datadoghq.com");
    vi.stubEnv("DD_SERVICE", "relay");
    vi.stubEnv("RELEASE_VERSION", "2.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "deadbeef");

    // Simulate keys() throwing (e.g., outside Next.js context)
    vi.doMock("../keys", () => ({
      keys: () => {
        throw new Error("Not a Next.js context");
      },
    }));

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    // Must reset modules AFTER doMock so the mock is picked up
    vi.resetModules();
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../log");
    const log = mod.log;

    log.info("relay message");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ ddtags: string }>(fetchMock);
    expect(body[0].ddtags).toMatch(DDTAGS_RE);
    // version and git_sha should resolve from process.env, not "unknown"
    expect(body[0].ddtags).toContain("version:2.0.0");
    expect(body[0].ddtags).toContain("git_sha:deadbeef");
  });
});

// ---------------------------------------------------------------------------
// (e) Cross-cutting ddtags regression guard
// ---------------------------------------------------------------------------

describe("cross-cutting ddtags regression guard", () => {
  it("(a) exact substring match for interpolation — catches template literal regression", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.2.3");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123def456");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("regression guard message");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ ddtags: string }>(fetchMock);
    expect(body[0].ddtags.includes("version:1.2.3")).toBe(true);
    expect(body[0].ddtags.includes("git_sha:abc123def456")).toBe(true);
  });

  it("(b) structural integrity — three segments each with non-empty key and value", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.2.3");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123def456");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("structural integrity message");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ ddtags: string }>(fetchMock);
    const segments = body[0].ddtags.split(",");
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      // Shape assertion: one colon, non-empty key, non-empty value.
      // Fails with a clear message on format regressions instead of TypeError
      // on `parts[1].length` when the split produces fewer than two parts.
      expect(segment).toMatch(DDTAGS_SEGMENT_RE);
    }
  });

  it("(c) post-import mutation does not change version — module-level const is immutable after first import", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.2.3");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123def456");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("first call");
    await log.flush();

    const firstBody = parseFlushedBody<{ ddtags: string }>(fetchMock);
    expect(firstBody[0].ddtags.includes("version:1.2.3")).toBe(true);
    expect(firstBody[0].ddtags.includes("git_sha:abc123def456")).toBe(true);

    // Mutate env AFTER import — must NOT affect already-loaded module constant
    vi.stubEnv("RELEASE_VERSION", "9.9.9");

    log.info("second call");
    await log.flush();

    const secondBody = parseFlushedBody<{ ddtags: string }>(fetchMock, 1);
    expect(secondBody[0].ddtags.includes("version:1.2.3")).toBe(true);
    expect(secondBody[0].ddtags.includes("version:9.9.9")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (e2) loop.perf.* ddtag cardinality — exactly three segments, no extras
// ---------------------------------------------------------------------------

describe("loop.perf.* ddtag cardinality — exactly three segments", () => {
  it("flushed entry for a loop.perf.agent event carries exactly three ddtag segments (env, version, git_sha)", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.2.3");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123def456");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("loop perf agent event", {
      category: TelemetryCategory.LoopPerfAgent,
    });
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ ddtags: string }>(fetchMock);
    // Verify the overall pattern matches env:*, version:*, git_sha:*
    expect(body[0].ddtags).toMatch(DDTAGS_RE);
    // Verify exactly three comma-separated segments — no extra ddtag keys added
    const segments = body[0].ddtags.split(",");
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment).toMatch(DDTAGS_SEGMENT_RE);
    }
  });
});

// ---------------------------------------------------------------------------
// (f) flush() behaviour — batching and empty-buffer short-circuit
// ---------------------------------------------------------------------------

describe("flush() batching and empty-buffer behaviour", () => {
  it("sends all buffered log entries to Datadog when flush() is called", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");

    const fetchMock = vi.fn().mockResolvedValue(new Response("OK"));
    const log = await importLogWithFetch(fetchMock);

    log.info("first");
    log.warn("second");
    log.error("third");

    expect(fetchMock).not.toHaveBeenCalled();

    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("http-intake.logs");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["DD-API-KEY"]).toBe(
      "test-key"
    );

    expect(typeof init.body).toBe("string");
    const body = JSON.parse(init.body as string) as Array<{ message: string }>;
    expect(body).toHaveLength(3);
    expect(body[0].message).toBe("first");
    expect(body[1].message).toBe("second");
    expect(body[2].message).toBe("third");
  });

  it("resolves immediately without calling fetch when buffer is empty", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");

    const fetchMock = vi.fn().mockResolvedValue(new Response("OK"));
    const log = await importLogWithFetch(fetchMock);

    await log.flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (g) HTTP response handling — retryable vs non-retryable status codes
// ---------------------------------------------------------------------------

describe("HTTP response handling — retryable and non-retryable status codes", () => {
  it("treats HTTP 200 as success and resets retryCount", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("success");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries on HTTP 429 — does not drop the batch", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const log = await importLogWithFetch(fetchMock);

    log.info("rate limited");
    await log.flush();

    // Should retry up to MAX_RETRY_COUNT + 1 times
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on HTTP 500 — does not drop the batch", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const log = await importLogWithFetch(fetchMock);

    log.info("server error");
    await log.flush();

    // Should retry up to MAX_RETRY_COUNT + 1 times
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("drops batch on HTTP 401 without retry", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const log = await importLogWithFetch(fetchMock);

    log.info("unauthorized");
    await log.flush();

    // Non-retryable — exactly one call, no retries
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("drops batch on HTTP 403 without retry", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "test");
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const log = await importLogWithFetch(fetchMock);

    log.info("forbidden");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
