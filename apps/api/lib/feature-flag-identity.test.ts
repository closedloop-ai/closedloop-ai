/**
 * ISS-8196 rewrote the identity half of this suite. The old cases asserted that
 * a principal's Clerk id and internal id were BOTH evaluated and their verdicts
 * ORed; the browser identifies PostHog with the Clerk id alone, so that second
 * draw could hand a server-side `true` to someone the web UI was showing the
 * feature OFF to. The expectation changed because the behaviour did, and the
 * divergence cases below are the ones that could not pass under the OR.
 *
 * ISS-4556 split UNAVAILABLE (`null`) from an evaluated `false` here, and put
 * the try/catch inside the loop so a throw could not discard a definite answer.
 * Both are silent-regression shapes: the boolean wrapper collapses them, so only
 * the `evaluate…` assertions below can see the difference.
 */

import {
  getAllFeatureFlagsForDistinctId,
  isFeatureFlagEnabledForDistinctId,
} from "@repo/analytics/feature-flags";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DistinctIdKind,
  evaluateFeatureFlagForAnyIdentity,
  getAllFeatureFlagsForAnyIdentity,
  isFeatureFlagEnabledForAnyIdentity,
  resolveDistinctIdsForIdentity,
} from "./feature-flag-identity";
import { PUBLIC_GITHUB_REPOS_SERVER_FLAG } from "./feature-flags/server-feature-flags";

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: vi.fn(),
  getAllFeatureFlagsForDistinctId: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
  },
}));

/**
 * ISS-7778: the evaluator now takes a CLASSIFIED, REGISTERED flag, so this
 * suite drives a real registered grant rather than a synthetic key string. The
 * key it asserts on is read off that definition — the mocked
 * `isFeatureFlagEnabledForDistinctId` still sees a bare key, which is what the
 * call-shape assertions below pin.
 */
const FLAG = PUBLIC_GITHUB_REPOS_SERVER_FLAG;
const FLAG_KEY = FLAG.key;
const LOG_KEY = "some_flag_unavailable";
const CLERK_ID = "clerk-1";
const USER_ID = "user-1";
const BOTH_IDS = { clerkUserId: CLERK_ID, userId: USER_ID };
const INTERNAL_ONLY = { userId: USER_ID };

/**
 * The reported defect, as a mock: PostHog buckets the two ids into opposite
 * cohorts. `mockImplementation` rather than `mockResolvedValueOnce` chaining so
 * the verdict is bound to the ID, not to call order — a test that keyed on order
 * would still pass if the resolver silently swapped which id it asked about.
 */
function mockOppositeVerdicts(verdicts: {
  clerk: boolean;
  internal: boolean;
}): void {
  vi.mocked(isFeatureFlagEnabledForDistinctId).mockImplementation(
    (_flag: string, distinctId: string) =>
      Promise.resolve(
        distinctId === CLERK_ID ? verdicts.clerk : verdicts.internal
      )
  );
}

describe("resolveDistinctIdsForIdentity", () => {
  it("resolves the clerk id ALONE when the principal carries both", () => {
    expect(resolveDistinctIdsForIdentity(BOTH_IDS)).toEqual([CLERK_ID]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])(
    "falls back to the internal id when the clerk id is %s",
    (_label, clerkUserId) => {
      expect(
        resolveDistinctIdsForIdentity({ clerkUserId, userId: USER_ID })
      ).toEqual([USER_ID]);
    }
  );

  it("resolves the clerk id when the internal id is empty", () => {
    expect(
      resolveDistinctIdsForIdentity({ clerkUserId: CLERK_ID, userId: "" })
    ).toEqual([CLERK_ID]);
  });

  it("yields no ids when the principal carries none", () => {
    expect(resolveDistinctIdsForIdentity({ userId: "" })).toEqual([]);
  });
});

describe("evaluateFeatureFlagForAnyIdentity", () => {
  beforeEach(() => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockReset();
    vi.mocked(log.warn).mockReset();
  });

  it("queries the exact flag key against the clerk id only", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(false);

    await evaluateFeatureFlagForAnyIdentity(FLAG, BOTH_IDS, LOG_KEY);

    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledTimes(1);
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      FLAG_KEY,
      CLERK_ID
    );
  });

  // ISS-8196, the case the OR got wrong. Under the previous behaviour the
  // internal id's `true` won and this resolved `true` while the browser — which
  // only ever identifies the Clerk id — was rendering the feature OFF.
  it("agrees with the browser when the internal id would say true and the clerk id says false", async () => {
    mockOppositeVerdicts({ clerk: false, internal: true });

    await expect(
      evaluateFeatureFlagForAnyIdentity(FLAG, BOTH_IDS, LOG_KEY)
    ).resolves.toBe(false);
    expect(isFeatureFlagEnabledForDistinctId).not.toHaveBeenCalledWith(
      FLAG_KEY,
      USER_ID
    );
  });

  // The other direction, so the fix cannot be an AND: the clerk id is the
  // authority when it says yes as well as when it says no.
  it("follows the clerk id when it says true and the internal id would say false", async () => {
    mockOppositeVerdicts({ clerk: true, internal: false });

    await expect(
      evaluateFeatureFlagForAnyIdentity(FLAG, BOTH_IDS, LOG_KEY)
    ).resolves.toBe(true);
  });

  it("evaluates the internal id for a principal that has no clerk id", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(true);

    await expect(
      evaluateFeatureFlagForAnyIdentity(FLAG, INTERNAL_ONLY, LOG_KEY)
    ).resolves.toBe(true);
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      FLAG_KEY,
      USER_ID
    );
  });

  it("returns false when the clerk id evaluated negative", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(false);

    await expect(
      evaluateFeatureFlagForAnyIdentity(FLAG, BOTH_IDS, LOG_KEY)
    ).resolves.toBe(false);
  });

  it("returns null when the clerk id could not be evaluated", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(null);

    await expect(
      evaluateFeatureFlagForAnyIdentity(FLAG, BOTH_IDS, LOG_KEY)
    ).resolves.toBeNull();
  });

  // An UNAVAILABLE clerk evaluation is an outage, not a cohort answer, and must
  // not silently promote the internal id into a second draw.
  it("does not fall back to the internal id when the clerk evaluation is unavailable", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockImplementation(
      (_flag: string, distinctId: string) =>
        Promise.resolve(distinctId === CLERK_ID ? null : true)
    );

    await expect(
      evaluateFeatureFlagForAnyIdentity(FLAG, BOTH_IDS, LOG_KEY)
    ).resolves.toBeNull();
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledTimes(1);
  });

  it("returns null without querying when the principal has no distinct ids", async () => {
    await expect(
      evaluateFeatureFlagForAnyIdentity(FLAG, { userId: "" }, LOG_KEY)
    ).resolves.toBeNull();
    expect(isFeatureFlagEnabledForDistinctId).not.toHaveBeenCalled();
  });

  it("reports unavailable and does not fall back when the clerk evaluation throws", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockImplementation(
      (_flag: string, distinctId: string) =>
        distinctId === CLERK_ID
          ? Promise.reject(new Error("PostHog unavailable"))
          : Promise.resolve(true)
    );

    await expect(
      evaluateFeatureFlagForAnyIdentity(FLAG, BOTH_IDS, LOG_KEY)
    ).resolves.toBeNull();
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledTimes(1);
  });

  it("logs the throw under the caller's log key with the parsed error", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockRejectedValue(
      new Error("clerk lookup failed")
    );

    await evaluateFeatureFlagForAnyIdentity(FLAG, BOTH_IDS, LOG_KEY);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(LOG_KEY, {
      featureFlagKey: FLAG_KEY,
      error: "clerk lookup failed",
    });
  });
});

describe("isFeatureFlagEnabledForAnyIdentity", () => {
  beforeEach(() => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockReset();
    vi.mocked(log.warn).mockReset();
  });

  it("passes through an affirmative evaluation", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(true);

    await expect(
      isFeatureFlagEnabledForAnyIdentity(FLAG, BOTH_IDS, LOG_KEY)
    ).resolves.toBe(true);
  });

  // ISS-8196 at the gate every server-side caller actually uses.
  it("refuses a principal the browser has out of the rollout, even when the internal id is in", async () => {
    mockOppositeVerdicts({ clerk: false, internal: true });

    await expect(
      isFeatureFlagEnabledForAnyIdentity(FLAG, BOTH_IDS, LOG_KEY)
    ).resolves.toBe(false);
  });

  it.each([
    ["an evaluated false", false],
    ["an unavailable evaluation", null],
  ])("fails closed on %s", async (_label, value) => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(value);

    await expect(
      isFeatureFlagEnabledForAnyIdentity(FLAG, BOTH_IDS, LOG_KEY)
    ).resolves.toBe(false);
  });

  it("fails closed when evaluation throws", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockRejectedValue(
      new Error("PostHog unavailable")
    );

    await expect(
      isFeatureFlagEnabledForAnyIdentity(FLAG, BOTH_IDS, LOG_KEY)
    ).resolves.toBe(false);
  });

  it("fails closed when the principal has no distinct ids", async () => {
    await expect(
      isFeatureFlagEnabledForAnyIdentity(FLAG, { userId: "" }, LOG_KEY)
    ).resolves.toBe(false);
    expect(isFeatureFlagEnabledForDistinctId).not.toHaveBeenCalled();
  });
});

/**
 * ISS-8024 — the whole-assignment twin. It reads through the same resolver as
 * the per-key check, so a desktop gate and a web gate evaluated for the same
 * person cannot disagree about which distinct id decided them.
 *
 * ISS-8196 rewrote the three cases below. They asserted the cross-id merge —
 * a `true` from EITHER id winning, an earlier id's assignment surviving a later
 * id's throw, two warnings for two failed ids — and that merge WAS the second
 * draw this change removes. The expectations changed because the resolver now
 * yields at most one id, not to accommodate a red build: each is replaced by the
 * divergence case that could not pass under the OR.
 */
describe("getAllFeatureFlagsForAnyIdentity", () => {
  beforeEach(() => {
    vi.mocked(getAllFeatureFlagsForDistinctId).mockReset();
    vi.mocked(log.warn).mockReset();
  });

  it("reads the CLERK id alone, ignoring what the internal id would have said", async () => {
    // Keyed on the ID, not on call order, so a resolver that silently swapped
    // which namespace it asked about would still fail this.
    vi.mocked(getAllFeatureFlagsForDistinctId).mockImplementation(
      (distinctId: string): Promise<Record<string, boolean>> =>
        Promise.resolve<Record<string, boolean>>(
          distinctId === CLERK_ID
            ? { "flag-a": false, "flag-b": true }
            : { "flag-a": true, "flag-c": false }
        )
    );

    await expect(
      getAllFeatureFlagsForAnyIdentity(BOTH_IDS, LOG_KEY)
    ).resolves.toEqual({ "flag-a": false, "flag-b": true });
    expect(getAllFeatureFlagsForDistinctId).toHaveBeenCalledTimes(1);
    expect(getAllFeatureFlagsForDistinctId).toHaveBeenCalledWith(CLERK_ID);
  });

  it("falls back to the internal id for a principal that has no clerk id", async () => {
    vi.mocked(getAllFeatureFlagsForDistinctId).mockResolvedValue({
      "flag-a": true,
    });

    await expect(
      getAllFeatureFlagsForAnyIdentity(INTERNAL_ONLY, LOG_KEY)
    ).resolves.toEqual({ "flag-a": true });
    expect(getAllFeatureFlagsForDistinctId).toHaveBeenCalledWith(USER_ID);
  });

  it("reports UNAVAILABLE and names the failed namespace when the read throws", async () => {
    vi.mocked(getAllFeatureFlagsForDistinctId).mockRejectedValue(
      new Error("posthog exploded")
    );

    await expect(
      getAllFeatureFlagsForAnyIdentity(BOTH_IDS, LOG_KEY)
    ).resolves.toBeNull();

    // The payload is pinned EXACTLY, not `expect.any(Object)`: this warning is
    // emitted for a signed-in principal, so a user identifier added to it would
    // put a Clerk or internal user id into the log line on every flag-service
    // wobble. The kind names which namespace failed without naming the person,
    // and it is asserted as `clerk` here and `internal` below precisely because
    // a constant would prove nothing.
    expect(log.warn).toHaveBeenCalledWith(LOG_KEY, {
      distinctIdKind: DistinctIdKind.Clerk,
      error: expect.any(String),
    });
  });

  it("names the INTERNAL namespace when a clerk-less principal's read throws", async () => {
    vi.mocked(getAllFeatureFlagsForDistinctId).mockRejectedValue(
      new Error("posthog exploded")
    );

    await expect(
      getAllFeatureFlagsForAnyIdentity(INTERNAL_ONLY, LOG_KEY)
    ).resolves.toBeNull();

    expect(log.warn).toHaveBeenCalledWith(LOG_KEY, {
      distinctIdKind: DistinctIdKind.Internal,
      error: expect.any(String),
    });
  });

  it("never puts a user identifier in the failure log", async () => {
    vi.mocked(getAllFeatureFlagsForDistinctId).mockRejectedValue(
      new Error("posthog exploded")
    );

    await expect(
      getAllFeatureFlagsForAnyIdentity(BOTH_IDS, LOG_KEY)
    ).resolves.toBeNull();

    // One id is resolved, so one warning is emitted; it may not carry the id
    // itself in any field.
    expect(log.warn).toHaveBeenCalledTimes(1);
    for (const [, payload] of vi.mocked(log.warn).mock.calls) {
      expect(JSON.stringify(payload)).not.toContain(CLERK_ID);
      expect(JSON.stringify(payload)).not.toContain(USER_ID);
    }
  });

  it("reports UNAVAILABLE when NO id produced an assignment", async () => {
    vi.mocked(getAllFeatureFlagsForDistinctId).mockResolvedValue(null);

    await expect(
      getAllFeatureFlagsForAnyIdentity(BOTH_IDS, LOG_KEY)
    ).resolves.toBeNull();
  });

  it("distinguishes an EMPTY evaluated assignment from UNAVAILABLE", async () => {
    vi.mocked(getAllFeatureFlagsForDistinctId).mockResolvedValue({});

    await expect(
      getAllFeatureFlagsForAnyIdentity(BOTH_IDS, LOG_KEY)
    ).resolves.toEqual({});
  });
});
