/**
 * ISS-9824. The acceptance half of `validateCronSecret`'s emission contract;
 * the rejection half lives in the sibling `cron-secret.test.ts`.
 *
 * ISS-9812 made a REJECTED invocation observable and left the other half open:
 * no `/cron/*` route emits `request_completed` (none goes through an auth
 * wrapper), so "the scheduler never fired" and "the scheduler fired, was
 * accepted, and the route did nothing" were still the same silence.
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
import {
  CRON_INVOCATION_ACCEPTED_WINDOW_MS,
  cronInvocationAcceptedThrottle,
} from "@/lib/observability/cron-invocation-accepted-throttle";
import { cronSecretRejectionThrottle } from "@/lib/observability/cron-secret-rejection-throttle";
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

import {
  CRON_INVOCATION_ACCEPTED_EVENT,
  validateCronSecret,
} from "../cron-secret";

const LOG_TAG = CRON_TEST_LOG_TAG;
const SECRET = CRON_TEST_SECRET;
const ACCEPTED_EVENT = CRON_INVOCATION_ACCEPTED_EVENT;
const REJECTED_EVENT = CRON_SECRET_REJECTED_EVENT;
const makeRequest = makeCronRequest;

describe("cron acceptance monitor contract", () => {
  it("pins the event name the cross-repo Datadog monitor keys on", () => {
    expect(CRON_INVOCATION_ACCEPTED_EVENT).toBe("cron_invocation_accepted");
  });
});

/**
 * The decisive shape here is a PAIR — a valid secret emits the acceptance, an
 * invalid one emits the rejection and NOT the acceptance — because either half
 * alone would pass on a guard that emitted the heartbeat unconditionally.
 */
describe("validateCronSecret acceptance observability", () => {
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

  it("emits the monitored acceptance event when the secret matches", () => {
    const response = validateCronSecret(
      makeRequest(`Bearer ${SECRET}`),
      LOG_TAG
    );

    expect(response).toBeNull();
    expect(log.info).toHaveBeenCalledWith(ACCEPTED_EVENT, {
      event: ACCEPTED_EVENT,
      route: LOG_TAG,
      suppressedSincePreviousEmission: 0,
    });
  });

  it("emits the rejection and NOT the acceptance when the secret does not match", () => {
    const response = validateCronSecret(
      makeRequest(`Bearer ${"X".repeat(SECRET.length)}`),
      LOG_TAG
    );

    expect(response?.status).toBe(401);
    expect(log.warn).toHaveBeenCalledWith(
      REJECTED_EVENT,
      expect.objectContaining({ event: REJECTED_EVENT, route: LOG_TAG })
    );
    // The composite the monitor is built on reads absence of THIS event for a
    // route as "no longer succeeding". A rejected invocation that also emitted
    // it would make that absence unreachable and the alert incapable of firing.
    expect(log.info).not.toHaveBeenCalled();
  });

  it("emits nothing on the misconfiguration branch, which never authorized anything", () => {
    Reflect.deleteProperty(process.env, "CRON_SECRET");

    const response = validateCronSecret(
      makeRequest(`Bearer ${SECRET}`),
      LOG_TAG
    );

    expect(response?.status).toBe(500);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("flushes the acceptance record so it survives the frozen function", () => {
    // A cron route can return with no awaited work, so without this the record
    // is buffered and dies with the instance — the emit would be a production
    // no-op that a log-call assertion alone would happily pass on.
    validateCronSecret(makeRequest(`Bearer ${SECRET}`), LOG_TAG);

    expect(scheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("never puts the presented or expected credential in the emitted payload", () => {
    validateCronSecret(makeRequest(`Bearer ${SECRET}`), LOG_TAG);

    // Pinned FIRST: a `.includes()` check over an empty call list passes
    // trivially, so without this the whole test would go green on a regression
    // that stopped emitting altogether.
    expect(log.info).toHaveBeenCalledTimes(1);
    // Compared as booleans so a regression cannot render the secret into the
    // reporter output that reports it.
    const emitted = JSON.stringify(vi.mocked(log.info).mock.calls);
    expect(emitted.includes(SECRET)).toBe(false);
    expect(emitted.includes(`Bearer ${SECRET}`)).toBe(false);
  });
});

/**
 * ISS-9824. A success record is a heartbeat, not a per-request log: its only
 * consumer asks whether a route succeeded at all in the last N hours, and at
 * one record per invocation the every-two-minutes cron alone writes 720
 * identical lines a day answering that no better than one.
 *
 * Both directions again, because a cap with no lower-bound test is how you ship
 * silence: the emission is bounded per route per window, AND the first
 * acceptance in every window still emits, which is the only property the
 * absence-based monitor actually depends on.
 */
describe("validateCronSecret acceptance emission is bounded", () => {
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
    // Both, and not just the one this block drives: the fake clock advanced an
    // hour, so leaving either singleton populated would hand a later suite a
    // window opened in the future.
    cronInvocationAcceptedThrottle.clear();
    cronSecretRejectionThrottle.clear();
    if (originalCronSecret === undefined) {
      Reflect.deleteProperty(process.env, "CRON_SECRET");
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it("caps emission at one record per route per window no matter how many invocations arrive", () => {
    for (let i = 0; i < BURST; i += 1) {
      const response = validateCronSecret(
        makeRequest(`Bearer ${SECRET}`),
        LOG_TAG
      );
      // The bound describes the acceptance; it must never change it.
      expect(response).toBeNull();
    }

    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("caps the flush too, since the intake round trip is the expensive half", () => {
    for (let i = 0; i < BURST; i += 1) {
      validateCronSecret(makeRequest(`Bearer ${SECRET}`), LOG_TAG);
    }

    expect(scheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("keeps the keyspace closed: repeated invocations add no key beyond the route", () => {
    for (let i = 0; i < BURST; i += 1) {
      validateCronSecret(makeRequest(`Bearer ${SECRET}`), LOG_TAG);
    }

    // One route, one key. The header is fixed by the secret on this path, so
    // there is nothing a caller could vary to mint a second.
    expect(cronInvocationAcceptedThrottle.size).toBe(1);
  });

  it("re-emits in the next window, so a live route never looks silent", () => {
    validateCronSecret(makeRequest(`Bearer ${SECRET}`), LOG_TAG);
    vi.setSystemTime(Date.now() + CRON_INVOCATION_ACCEPTED_WINDOW_MS);
    validateCronSecret(makeRequest(`Bearer ${SECRET}`), LOG_TAG);

    expect(log.info).toHaveBeenCalledTimes(2);
  });

  it("reports what it folded on the next window's emission", () => {
    for (let i = 0; i < BURST; i += 1) {
      validateCronSecret(makeRequest(`Bearer ${SECRET}`), LOG_TAG);
    }
    vi.setSystemTime(Date.now() + CRON_INVOCATION_ACCEPTED_WINDOW_MS);
    validateCronSecret(makeRequest(`Bearer ${SECRET}`), LOG_TAG);

    expect(log.info).toHaveBeenLastCalledWith(ACCEPTED_EVENT, {
      event: ACCEPTED_EVENT,
      route: LOG_TAG,
      // The first of the burst emitted; the other 49 were counted, not dropped.
      suppressedSincePreviousEmission: BURST - 1,
    });
  });

  it("does not let one route's invocations spend another route's budget", () => {
    for (let i = 0; i < BURST; i += 1) {
      validateCronSecret(makeRequest(`Bearer ${SECRET}`), LOG_TAG);
    }

    validateCronSecret(makeRequest(`Bearer ${SECRET}`), OTHER_LOG_TAG);

    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenLastCalledWith(ACCEPTED_EVENT, {
      event: ACCEPTED_EVENT,
      route: OTHER_LOG_TAG,
      suppressedSincePreviousEmission: 0,
    });
  });

  it("does not let a spent acceptance budget silence a rejection on the same route", () => {
    // Separate keyspaces on purpose: a route that succeeded a minute ago and is
    // now being probed must still report the probe.
    for (let i = 0; i < BURST; i += 1) {
      validateCronSecret(makeRequest(`Bearer ${SECRET}`), LOG_TAG);
    }

    const response = validateCronSecret(makeRequest("Bearer stale"), LOG_TAG);

    expect(response?.status).toBe(401);
    expect(log.warn).toHaveBeenCalledWith(REJECTED_EVENT, {
      event: REJECTED_EVENT,
      route: LOG_TAG,
      authorizationHeaderPresent: true,
      suppressedSincePreviousEmission: 0,
    });
  });
});
