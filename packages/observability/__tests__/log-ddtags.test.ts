import { afterEach, describe, expect, it, vi } from "vitest";

const DDTAGS_RE = /env:[^,]+,version:[^,]+,git_sha:[^,]+/;

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
// Helper: import a fresh log module with a mock fetch already installed.
// Returns the log export and the fetch mock for inspection.
// ---------------------------------------------------------------------------

async function importLogWithFetch(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const mod = await import("../log");
  return mod.log;
}

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
    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as Array<{
      ddtags: string;
    }>;
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
    vi.stubEnv("RELEASE_VERSION", undefined as unknown as string);
    vi.stubEnv("npm_package_version", undefined as unknown as string);
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", undefined as unknown as string);
    vi.stubEnv("GIT_SHA", undefined as unknown as string);

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("fallback test");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as Array<{
      ddtags: string;
    }>;
    expect(body[0].ddtags).toContain("version:unknown");
    expect(body[0].ddtags).toContain("git_sha:unknown");
  });
});

// ---------------------------------------------------------------------------
// (c) Fallback warnings emitted exactly once at module load, not per log call
// ---------------------------------------------------------------------------

describe("module-load warnings — emitted once regardless of log call count", () => {
  it("emits exactly one version_fallback and one git_sha_fallback warning at load, not per log.info call", async () => {
    vi.stubEnv("RELEASE_VERSION", undefined as unknown as string);
    vi.stubEnv("npm_package_version", undefined as unknown as string);
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", undefined as unknown as string);
    vi.stubEnv("GIT_SHA", undefined as unknown as string);
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
    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as Array<{
      ddtags: string;
    }>;
    expect(body[0].ddtags).toMatch(DDTAGS_RE);
    // version and git_sha should resolve from process.env, not "unknown"
    expect(body[0].ddtags).toContain("version:2.0.0");
    expect(body[0].ddtags).toContain("git_sha:deadbeef");
  });
});
