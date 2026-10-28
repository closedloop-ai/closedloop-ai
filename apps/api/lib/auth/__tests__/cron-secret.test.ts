/**
 * Unit tests for validateCronSecret (PR #1206 review fix #5).
 *
 * Coverage: missing env, wrong-length token, wrong-value-correct-length token,
 * correct token, and headers whose UTF-16 length and UTF-8 byte length
 * disagree (ISS-7546). Exercises the byte-length pre-check that guards
 * timingSafeEqual against the RangeError it throws on unequal-byte-length
 * inputs.
 *
 * The guard's ACCEPTANCE emission (ISS-9824) is covered by the sibling
 * `cron-invocation-accepted.test.ts`; both suites share
 * `@/__tests__/support/auth/cron-secret.test-fixtures`.
 */
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CRON_SECRET_REJECTED_EVENT,
  CRON_TEST_LOG_TAG,
  CRON_TEST_OTHER_LOG_TAG,
  CRON_TEST_SECRET,
  makeCronRequest,
} from "@/__tests__/support/auth/cron-secret.test-fixtures";
import { cronInvocationAcceptedThrottle } from "@/lib/observability/cron-invocation-accepted-throttle";
import {
  CRON_SECRET_REJECTED_WINDOW_MS,
  cronSecretRejectionThrottle,
} from "@/lib/observability/cron-secret-rejection-throttle";
import { scheduleLogFlush } from "@/lib/route-utils";

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@/lib/route-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/route-utils")>();
  return {
    ...actual,
    scheduleLogFlush: vi.fn(),
  };
});

import { validateCronSecret } from "../cron-secret";

const LOG_TAG = CRON_TEST_LOG_TAG;
const SECRET = CRON_TEST_SECRET;
const REJECTED_EVENT = CRON_SECRET_REJECTED_EVENT;
const makeRequest = makeCronRequest;

describe("validateCronSecret", () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    // Both throttles are process-local singletons; without this a sibling
    // test's window would decide whether this one emits.
    cronSecretRejectionThrottle.clear();
    cronInvocationAcceptedThrottle.clear();
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it("returns 500 when CRON_SECRET is unset", () => {
    delete process.env.CRON_SECRET;
    const response = validateCronSecret(
      makeRequest(`Bearer ${SECRET}`),
      LOG_TAG
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(500);
  });

  it("returns 401 when the Authorization header is missing", () => {
    const response = validateCronSecret(makeRequest(), LOG_TAG);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(401);
  });

  it("returns 401 when the token has the wrong length (byte-length pre-check, not timingSafeEqual)", () => {
    // Differing-byte-length input would throw inside timingSafeEqual; the
    // byte-length pre-check must short-circuit before reaching it.
    const response = validateCronSecret(
      makeRequest("Bearer too-short"),
      LOG_TAG
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(401);
  });

  it("returns 401 when the token is the correct length but the wrong value", () => {
    const wrongSameLength = "X".repeat(SECRET.length);
    const response = validateCronSecret(
      makeRequest(`Bearer ${wrongSameLength}`),
      LOG_TAG
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(401);
  });

  it("returns 401 when the header matches in UTF-16 length but not in byte length", () => {
    // `\u00e9` is one UTF-16 code unit but two UTF-8 bytes, so this header clears a
    // String.length pre-check while Buffer.from() yields one byte more than
    // `expected` — the shape that made timingSafeEqual throw a RangeError.
    const expectedHeader = `Bearer ${SECRET}`;
    const sameUnitsMoreBytes = `Bearer ${"X".repeat(SECRET.length - 1)}\u00e9`;
    expect(sameUnitsMoreBytes).toHaveLength(expectedHeader.length);
    expect(Buffer.from(sameUnitsMoreBytes).length).toBe(
      Buffer.from(expectedHeader).length + 1
    );

    const response = validateCronSecret(
      makeRequest(sameUnitsMoreBytes),
      LOG_TAG
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(401);
  });

  it("returns 401 when the header matches in byte length but not in UTF-16 length", () => {
    // Mirror case: byte lengths agree, so the pre-check hands the header to
    // timingSafeEqual, which must reject it on contents instead of throwing.
    const expectedHeader = `Bearer ${SECRET}`;
    const fewerUnitsSameBytes = `Bearer ${"X".repeat(SECRET.length - 2)}\u00e9`;
    expect(fewerUnitsSameBytes).toHaveLength(expectedHeader.length - 1);
    expect(Buffer.from(fewerUnitsSameBytes).length).toBe(
      Buffer.from(expectedHeader).length
    );

    const response = validateCronSecret(
      makeRequest(fewerUnitsSameBytes),
      LOG_TAG
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(401);
  });

  it("returns null when the Authorization header matches the configured secret", () => {
    const response = validateCronSecret(
      makeRequest(`Bearer ${SECRET}`),
      LOG_TAG
    );
    expect(response).toBeNull();
  });
});

/**
 * ISS-9812. The emission IS the contract here, not incidental debug output: a
 * rejected cron used to return 401 with no log, no metric and no flush, so a
 * route Vercel never invoked was indistinguishable from one rejected every
 * night for a week. These assert the record that ends that ambiguity.
 */
describe("validateCronSecret rejection observability", () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    cronSecretRejectionThrottle.clear();
    cronInvocationAcceptedThrottle.clear();
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      Reflect.deleteProperty(process.env, "CRON_SECRET");
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it("emits the monitored rejection event when the secret does not match", () => {
    const wrongSameLength = "X".repeat(SECRET.length);

    const response = validateCronSecret(
      makeRequest(`Bearer ${wrongSameLength}`),
      LOG_TAG
    );

    expect(response?.status).toBe(401);
    expect(log.warn).toHaveBeenCalledWith(REJECTED_EVENT, {
      event: REJECTED_EVENT,
      route: LOG_TAG,
      authorizationHeaderPresent: true,
      suppressedSincePreviousEmission: 0,
    });
  });

  it("flushes the rejection record so it survives the frozen function", () => {
    validateCronSecret(makeRequest("Bearer nope"), LOG_TAG);

    expect(scheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("reports an absent Authorization header, separating a stale scheduler from a bare probe", () => {
    validateCronSecret(makeRequest(), LOG_TAG);

    expect(log.warn).toHaveBeenCalledWith(REJECTED_EVENT, {
      event: REJECTED_EVENT,
      route: LOG_TAG,
      authorizationHeaderPresent: false,
      suppressedSincePreviousEmission: 0,
    });
  });

  it("never puts the presented or expected credential in the emitted payload", () => {
    const presented = `Bearer ${"X".repeat(SECRET.length)}`;

    validateCronSecret(makeRequest(presented), LOG_TAG);

    // Pinned FIRST: a `.includes()` check over an empty call list passes
    // trivially, so without this the whole test would go green on a regression
    // that stopped emitting altogether.
    expect(log.warn).toHaveBeenCalledTimes(1);
    // Compared as booleans so a regression cannot render the secret into the
    // reporter output that reports it.
    const emitted = JSON.stringify(vi.mocked(log.warn).mock.calls);
    expect(emitted.includes(SECRET)).toBe(false);
    expect(emitted.includes(presented)).toBe(false);
  });

  // ISS-9824 changed what a match emits: it is now the acceptance heartbeat
  // rather than nothing at all. What still holds — and is what the monitor
  // depends on — is that a match is never counted as a rejection or a
  // misconfiguration.
  it("records no rejection or misconfiguration when the secret matches", () => {
    const response = validateCronSecret(
      makeRequest(`Bearer ${SECRET}`),
      LOG_TAG
    );

    expect(response).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("keeps the 401 body unchanged", async () => {
    const response = validateCronSecret(makeRequest("Bearer nope"), LOG_TAG);

    expect(response?.status).toBe(401);
    expect(await response?.text()).toBe("Unauthorized");
  });

  it("still logs the misconfiguration and flushes when CRON_SECRET is unset", () => {
    Reflect.deleteProperty(process.env, "CRON_SECRET");

    const response = validateCronSecret(
      makeRequest(`Bearer ${SECRET}`),
      LOG_TAG
    );

    expect(response?.status).toBe(500);
    expect(log.error).toHaveBeenCalledWith(
      `${LOG_TAG} CRON_SECRET is not configured`
    );
    expect(scheduleLogFlush).toHaveBeenCalledTimes(1);
    // The misconfig branch is not a credential rejection and must not be
    // counted as one by the monitor.
    expect(log.warn).not.toHaveBeenCalled();
  });
});

/**
 * ISS-9812 (#6880 review, codex P1). `/cron/*` has no middleware, no auth and
 * no rate limiter in front of it, so an unauthenticated scanner drives the
 * rejection branch at whatever rate it likes across all 27 routes. Emitting a
 * warning plus a `scheduleLogFlush()` — a Datadog intake round trip — per
 * attempt makes observability cost proportional to attacker request rate.
 *
 * These assert BOTH directions, because a cap with no lower-bound test is how
 * you ship silence: the emission is bounded per key per window, AND a genuine
 * rejection is still reported in every window it happens in.
 */
describe("validateCronSecret rejection emission is bounded", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const BURST = 50;
  const OTHER_LOG_TAG = CRON_TEST_OTHER_LOG_TAG;

  beforeEach(() => {
    vi.clearAllMocks();
    cronSecretRejectionThrottle.clear();
    cronInvocationAcceptedThrottle.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    vi.useRealTimers();
    cronSecretRejectionThrottle.clear();
    cronInvocationAcceptedThrottle.clear();
    if (originalCronSecret === undefined) {
      Reflect.deleteProperty(process.env, "CRON_SECRET");
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it("caps emission at one record per route per window no matter how many rejections arrive", () => {
    for (let i = 0; i < BURST; i += 1) {
      const response = validateCronSecret(makeRequest("Bearer nope"), LOG_TAG);
      // The bound describes the rejection; it must never change it.
      expect(response?.status).toBe(401);
    }

    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("caps the flush too, since the intake round trip is the expensive half", () => {
    for (let i = 0; i < BURST; i += 1) {
      validateCronSecret(makeRequest("Bearer nope"), LOG_TAG);
    }

    expect(scheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("keeps the keyspace closed: a burst adds no key beyond (route, header-presence)", () => {
    for (let i = 0; i < BURST; i += 1) {
      // Vary everything a client controls — the header value and its absence.
      validateCronSecret(makeRequest(`Bearer attacker-${i}`), LOG_TAG);
      validateCronSecret(makeRequest(), LOG_TAG);
    }

    // One route, two header-presence values. Nothing an attacker sends can
    // mint a third key, so the map cannot grow with request volume.
    expect(cronSecretRejectionThrottle.size).toBe(2);
  });

  it("still reports a genuine rejection: the first attempt in a window always emits", () => {
    const response = validateCronSecret(makeRequest("Bearer stale"), LOG_TAG);

    expect(response?.status).toBe(401);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(scheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("re-emits in the next window, so a nightly failure is never silenced", () => {
    validateCronSecret(makeRequest("Bearer stale"), LOG_TAG);
    vi.setSystemTime(Date.now() + CRON_SECRET_REJECTED_WINDOW_MS);
    validateCronSecret(makeRequest("Bearer stale"), LOG_TAG);

    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("reports what it suppressed on the next window's emission", () => {
    for (let i = 0; i < BURST; i += 1) {
      validateCronSecret(makeRequest("Bearer nope"), LOG_TAG);
    }
    vi.setSystemTime(Date.now() + CRON_SECRET_REJECTED_WINDOW_MS);
    validateCronSecret(makeRequest("Bearer nope"), LOG_TAG);

    expect(log.warn).toHaveBeenLastCalledWith(REJECTED_EVENT, {
      event: REJECTED_EVENT,
      route: LOG_TAG,
      authorizationHeaderPresent: true,
      // The first of the burst emitted; the other 49 were counted, not dropped.
      suppressedSincePreviousEmission: BURST - 1,
    });
  });

  it("does not let one route's traffic spend another route's budget", () => {
    for (let i = 0; i < BURST; i += 1) {
      validateCronSecret(makeRequest("Bearer nope"), LOG_TAG);
    }

    validateCronSecret(makeRequest("Bearer nope"), OTHER_LOG_TAG);

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenLastCalledWith(REJECTED_EVENT, {
      event: REJECTED_EVENT,
      route: OTHER_LOG_TAG,
      authorizationHeaderPresent: true,
      suppressedSincePreviousEmission: 0,
    });
  });

  it("does not let scanner volume mask a stale scheduler on the same route", () => {
    // A bare probe sends no Authorization header; a scheduler holding a stale
    // secret sends one. A route-only key would let the loud one win the
    // window's single slot and hide the failure this ticket exists to surface.
    for (let i = 0; i < BURST; i += 1) {
      validateCronSecret(makeRequest(), LOG_TAG);
    }

    validateCronSecret(makeRequest("Bearer stale"), LOG_TAG);

    expect(log.warn).toHaveBeenLastCalledWith(REJECTED_EVENT, {
      event: REJECTED_EVENT,
      route: LOG_TAG,
      authorizationHeaderPresent: true,
      suppressedSincePreviousEmission: 0,
    });
  });

  it("does not let a spent rejection budget silence the misconfiguration error", () => {
    // Different branch, different severity, different meaning: `log.error` on
    // an unset CRON_SECRET is an operator-actionable misconfiguration, and this
    // bound covers only the credential-rejection record. A spent window on the
    // route must not swallow it.
    for (let i = 0; i < BURST; i += 1) {
      validateCronSecret(makeRequest("Bearer nope"), LOG_TAG);
    }
    Reflect.deleteProperty(process.env, "CRON_SECRET");

    const response = validateCronSecret(
      makeRequest(`Bearer ${SECRET}`),
      LOG_TAG
    );

    expect(response?.status).toBe(500);
    expect(log.error).toHaveBeenCalledWith(
      `${LOG_TAG} CRON_SECRET is not configured`
    );
  });
});
