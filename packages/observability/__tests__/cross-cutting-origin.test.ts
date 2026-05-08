// ---------------------------------------------------------------------------
// CROSS-CUTTING ORIGIN — integration tests verifying `origin` propagates
// correctly from DD_SERVICE through log.ts into the flushed Datadog payload.
//
// Scope differs from origin.test.ts (which tests the ORIGIN const resolver in
// isolation). These tests exercise the full log pipeline: module load, entry
// building, batching, and flush — confirming the `origin` field in the flushed
// JSON body reflects the DD_SERVICE-resolved Origin value.
//
// NOTE: Relay-native connection lifecycle events emitted via
// `log.*(JSON.stringify({ category: ... }))` directly in apps/relay/src/index.ts
// DO carry an `origin` field. `buildEntry()` in log.ts always stamps
// `origin = metaOrigin ?? ORIGIN`, and with no meta arg, ORIGIN is the
// module-level constant resolved from DD_SERVICE (resolves to "relay" when
// DD_SERVICE=relay). The real distinction vs emitter.ts events is that
// `category`, `trace`, etc. land inside the stringified `message` (pipeline
// rule required for facet queries), while `origin` is always top-level and
// facet-queryable without the rule — see apps/api/docs/telemetry-verification.md.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { Origin } from "../telemetry/origin";
import {
  deleteEnvForTest,
  importLogWithFetch,
  parseFlushedBody,
} from "./test-helpers";

// `log` must be dynamically imported inside each test via:
//   const { log } = await import("../log");
// Never statically imported at the top of this file — the module resolves
// ORIGIN at load time, so each test needs a fresh module evaluation.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// T-1.1: Parameterized — origin propagates for all three known service paths
// ---------------------------------------------------------------------------

describe("origin propagation into flushed log entry — three known paths", () => {
  const cases: [string, Origin][] = [
    ["desktop", Origin.Desktop],
    ["api", Origin.Api],
    ["relay", Origin.Relay],
    ["cl-api", Origin.Api],
    ["cl-relay", Origin.Relay],
    ["cl-desktop", Origin.Desktop],
  ];

  for (const [ddServiceValue, expectedOrigin] of cases) {
    it(`sets origin=${expectedOrigin} when DD_SERVICE=${ddServiceValue}`, async () => {
      vi.useFakeTimers();
      vi.stubEnv("DD_API_KEY", "test-key");
      vi.stubEnv("DD_SERVICE", ddServiceValue);
      // Populate version + git_sha so log.ts's module-load fallback warnings
      // do not enqueue entries ahead of the intended "test message" at body[0]
      // (matches the pattern in T-1.2 below).
      vi.stubEnv("RELEASE_VERSION", "1.0.0");
      vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "testsha");

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const log = await importLogWithFetch(fetchMock);

      log.info("test message");
      await log.flush();

      expect(fetchMock).toHaveBeenCalledOnce();
      const body = parseFlushedBody<{ origin: string }>(fetchMock);
      expect(body[0].origin).toBe(expectedOrigin);
    });
  }
});

// ---------------------------------------------------------------------------
// T-1.2: Fallback path — DD_SERVICE unset resolves to Origin.Unknown
// ---------------------------------------------------------------------------

describe("origin propagation — DD_SERVICE-unset fallback path", () => {
  it("sets origin=unknown in the flushed payload when DD_SERVICE is unset", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DD_API_KEY", "test-key");
    // Populate version + git_sha so log.ts's module-load fallback warnings
    // do not enqueue `telemetry.version_fallback` / `telemetry.git_sha_fallback`
    // entries ahead of the intended "fallback test" entry at body[0].
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "testsha");
    // `vi.stubEnv(key, undefined)` coerces to the literal string "undefined",
    // which exercises the off-whitelist branch. To exercise the truly-absent
    // branch (process.env.DD_SERVICE === undefined), delete the key and let
    // deleteEnvForTest restore the parent env's original value when the test
    // finishes — vi.unstubAllEnvs() does not roll back deleted keys.
    deleteEnvForTest("DD_SERVICE");

    // Suppress origin.ts's console.warn on the fallback path so it does not
    // pollute test output. The fallback warning itself is asserted in
    // origin.test.ts — here we verify the observable Datadog payload.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("fallback test");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ origin: string }>(fetchMock);
    expect(body[0].origin).toBe(Origin.Unknown);
  });
});

// ---------------------------------------------------------------------------
// T-1.3: Post-import env mutation does not change the resolved origin
// ---------------------------------------------------------------------------

describe("origin propagation — post-import env mutation does not change origin", () => {
  it("retains Origin.Api after DD_SERVICE is mutated to 'desktop' without resetModules", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_SERVICE", "api");
    // Populate version + git_sha so module-load fallback warnings do not
    // enqueue entries ahead of the "first"/"second" entries at body[0].
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "testsha");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    // First flush — expect Api
    log.info("first");
    await log.flush();

    const firstBody = parseFlushedBody<{ origin: string }>(fetchMock);
    expect(firstBody[0].origin).toBe(Origin.Api);

    // Mutate env WITHOUT calling vi.resetModules() — same log instance
    vi.stubEnv("DD_SERVICE", "desktop");

    // Second flush — origin must still be Api (module-level const not re-read)
    log.info("second");
    await log.flush();

    const secondBody = parseFlushedBody<{ origin: string }>(fetchMock, 1);
    expect(secondBody[0].origin).toBe(Origin.Api);
  });
});
