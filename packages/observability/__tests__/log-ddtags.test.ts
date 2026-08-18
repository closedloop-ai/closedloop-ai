import { DEFAULT_DD_SITE } from "@repo/api/src/types/datadog-sites";
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

  // FEA-3565: the Vercel runtime sets neither RELEASE_VERSION nor
  // npm_package_version, so `version` used to fall to "unknown" on every prod
  // log (the FEA-3331 I-9 gap). It now falls back to the deployed commit SHA.
  it("uses the commit SHA as version when only VERCEL_GIT_COMMIT_SHA is set (the Vercel prod case)", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_ENV", "prod");
    deleteEnvForTest("RELEASE_VERSION", "npm_package_version", "GIT_SHA");
    vi.stubEnv(
      "VERCEL_GIT_COMMIT_SHA",
      "9f8910b8a98de735cad4c2761c02af3daeb539f1"
    );

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("vercel prod version test");
    await log.flush();

    const body = parseFlushedBody<{ ddtags: string }>(fetchMock);
    // version now equals the SHA — and matches git_sha, as Unified Service
    // Tagging expects — instead of the old version:unknown.
    expect(body[0].ddtags).toContain(
      "version:9f8910b8a98de735cad4c2761c02af3daeb539f1"
    );
    expect(body[0].ddtags).toContain(
      "git_sha:9f8910b8a98de735cad4c2761c02af3daeb539f1"
    );
    expect(body[0].ddtags).not.toContain("version:unknown");
  });

  // RELEASE_VERSION still wins when explicitly set — the SHA is only a fallback.
  it("prefers an explicit RELEASE_VERSION over the commit SHA", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    deleteEnvForTest("npm_package_version", "GIT_SHA");
    vi.stubEnv("RELEASE_VERSION", "2.4.1");
    vi.stubEnv(
      "VERCEL_GIT_COMMIT_SHA",
      "abc123def456abc123def456abc123def456abcd"
    );

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("release version precedence test");
    await log.flush();

    const body = parseFlushedBody<{ ddtags: string }>(fetchMock);
    expect(body[0].ddtags).toContain("version:2.4.1");
  });

  it("uses npm_package_version before the commit SHA for version", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    deleteEnvForTest("RELEASE_VERSION", "GIT_SHA");
    vi.stubEnv("npm_package_version", "4.5.6");
    vi.stubEnv(
      "VERCEL_GIT_COMMIT_SHA",
      "abc123def456abc123def456abc123def456abcd"
    );

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("package version precedence test");
    await log.flush();

    const body = parseFlushedBody<{ ddtags: string }>(fetchMock);
    expect(body[0].ddtags).toContain("version:4.5.6");
    expect(body[0].ddtags).toContain(
      "git_sha:abc123def456abc123def456abc123def456abcd"
    );
  });

  it("resolves build identity through the first safe candidate", async () => {
    vi.stubEnv("RELEASE_VERSION", "../bad release");
    vi.stubEnv("npm_package_version", "5.6.7");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "../bad-sha");
    vi.stubEnv("GIT_SHA", "abc123def456");

    const { resolveGitSha, resolveServerVersion } = await import(
      "../telemetry/context"
    );

    expect(resolveServerVersion()).toBe("5.6.7");
    expect(resolveGitSha()).toBe("abc123def456");
  });

  it("resolves malformed and oversized build identity env values to unknown", async () => {
    const oversizedValue = "a".repeat(41);
    const oversizedSemver = `1.2.3-${"a".repeat(500)}`;
    vi.stubEnv("RELEASE_VERSION", oversizedSemver);
    vi.stubEnv("npm_package_version", oversizedValue);
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "../bad-sha");
    vi.stubEnv("GIT_SHA", oversizedValue);

    const { resolveGitSha, resolveServerVersion } = await import(
      "../telemetry/context"
    );

    expect(resolveServerVersion()).toBe("unknown");
    expect(resolveGitSha()).toBe("unknown");
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

    // keys.ts emptyStringAsUndefined: true converts "" → undefined, then
    // "?? cl-unknown" fires. That normalization is `keys()`'s, so it covers THIS
    // path only — `keys()` resolving is what makes this the non-catch branch.
    // The catch branch reads process.env raw and is pinned separately by (b5).
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ service: string }>(fetchMock);
    expect(body[0].service).toBe("cl-unknown");
  });
});

// ---------------------------------------------------------------------------
// (b5) DD_SERVICE empty-string IN THE CATCH BRANCH — the case (b4) cannot cover
//
// (b4) leans on `keys()`'s `emptyStringAsUndefined` to normalize "" away. That
// protection is a property of `keys()`, and the catch branch is reached only
// when `keys()` THROWS — so it cannot apply there. This mocks the throw, which
// (b4) does not, and pins the raw `process.env` read.
// ---------------------------------------------------------------------------

describe("DD_SERVICE empty-string via catch branch", () => {
  it("falls back to 'cl-unknown' when keys() throws and DD_SERVICE is empty", async () => {
    deleteEnvForTest("DD_SERVICE");
    vi.stubEnv("DD_SERVICE", "");
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

    log.info("catch-branch empty service");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ service: string }>(fetchMock);
    // Not `""`: the startup warning tells operators these logs are tagged
    // `cl-unknown`, and a `service:""` tag drops them out of every
    // service-scoped Datadog query while that warning says otherwise.
    expect(body[0].service).toBe("cl-unknown");
  });
});

// ---------------------------------------------------------------------------
// (b6) DD_SITE empty-string via catch branch — the sink stays OPEN
//
// An empty site is not merely a bad tag: it fails `isAllowedDatadogSite`, so
// `resolveExportTarget` clears the api key and NOTHING is exported at all.
// Asserting a fetch happened at the default host is what pins that.
// ---------------------------------------------------------------------------

describe("DD_SITE empty-string via catch branch", () => {
  it("falls back to the default site so the sink is not closed", async () => {
    deleteEnvForTest("DD_SITE");
    vi.stubEnv("DD_SITE", "");
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

    log.info("catch-branch empty site");
    await log.flush();

    // The export happened at all — with "" the allowlist check clears the key
    // and this call never occurs.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://http-intake.logs.${DEFAULT_DD_SITE}/api/v2/logs`
    );
  });
});

// ---------------------------------------------------------------------------
// (b7) DD_ENV empty-string via catch branch — NODE_ENV carries the tag
//
// NODE_ENV is pinned explicitly rather than inherited, so the fallback is
// deterministic under any runner environment.
// ---------------------------------------------------------------------------

describe("DD_ENV empty-string via catch branch", () => {
  it("falls through to NODE_ENV rather than tagging env:''", async () => {
    deleteEnvForTest("DD_ENV");
    vi.stubEnv("DD_ENV", "");
    vi.stubEnv("NODE_ENV", "staging");
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

    log.info("catch-branch empty env");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ ddtags: string }>(fetchMock);
    expect(body[0].ddtags).toContain("env:staging");
    expect(body[0].ddtags).not.toContain("env:,");
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
