import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("./server");
});

describe("isFeatureFlagEnabledForGroup (PLN-2187 T-2.6)", () => {
  it("evaluates for the group alone, its key standing in for a person", async () => {
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.doMock("./server", () => ({ analytics: { isFeatureEnabled } }));
    const { isFeatureFlagEnabledForGroup } = await import("./feature-flags");

    await expect(
      isFeatureFlagEnabledForGroup("org-flag", {
        type: "company",
        key: "org_clerk_1",
      })
    ).resolves.toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledWith("org-flag", "org_clerk_1", {
      groups: { company: "org_clerk_1" },
      sendFeatureFlagEvents: false,
    });
  });

  it("reports an unanswered lookup as null, not false", async () => {
    const isFeatureEnabled = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./server", () => ({ analytics: { isFeatureEnabled } }));
    const { isFeatureFlagEnabledForGroup } = await import("./feature-flags");

    await expect(
      isFeatureFlagEnabledForGroup("org-flag", {
        type: "company",
        key: "org_clerk_1",
      })
    ).resolves.toBeNull();
  });
});

describe("isFeatureFlagEnabledForDistinctId", () => {
  it("uses the Next server analytics client and only accepts exact true", async () => {
    const isFeatureEnabled = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.doMock("./server", () => ({ analytics: { isFeatureEnabled } }));
    const { isFeatureFlagEnabledForDistinctId } = await import(
      "./feature-flags"
    );

    await expect(
      isFeatureFlagEnabledForDistinctId("enabled-flag", "user-1")
    ).resolves.toBe(true);
    await expect(
      isFeatureFlagEnabledForDistinctId("disabled-flag", "user-1")
    ).resolves.toBe(false);
    expect(isFeatureEnabled).toHaveBeenNthCalledWith(
      1,
      "enabled-flag",
      "user-1"
    );
  });

  it("returns null when the available analytics client cannot evaluate flags", async () => {
    vi.doMock("./server", () => ({ analytics: {} }));
    const { isFeatureFlagEnabledForDistinctId } = await import(
      "./feature-flags"
    );

    await expect(
      isFeatureFlagEnabledForDistinctId("flag", "user-1")
    ).resolves.toBeNull();
  });
});

/**
 * ISS-8117 — the one place posthog-node's ambiguity is resolved, pinned.
 *
 * posthog-node cannot tell an UNREGISTERED KEY from a FAILED REQUEST: a request
 * failure makes `getFeatureFlagDetailsStateless` return `undefined` and records
 * an internal `UNKNOWN_ERROR` without rejecting, and an unknown key returns the
 * same `undefined`. Both arrive here identically, and this function is what
 * decides they are `null` — "PostHog did not answer" — rather than `false`.
 *
 * That decision is load-bearing for the whole flag-registration guard.
 * `scripts/lint/posthog-flag-registration.ts` exists because a gate shipped
 * against a flag nobody created, and the reason a SERVER gate in that state is
 * worse than the web one is exactly this collapse: fold `undefined` into
 * `false` and a missing flag becomes an ordinary evaluated OFF, with no
 * `null` for any caller to notice and nothing anywhere to report it.
 *
 * Both readings are driven here, and the case is written so it CANNOT pass under
 * a re-collapsed implementation: `null` and `false` are asserted to be
 * distinguishable outputs of the same function, which a `=== true` fold makes
 * impossible.
 */
describe("an unanswered lookup versus an answered no", () => {
  it("reports the unanswered lookup as null and an evaluated false as false", async () => {
    // `undefined` is posthog-node's value for BOTH "no such flag in the project"
    // and "the request to PostHog failed" — it cannot distinguish them, so
    // neither can this test, and neither claims to.
    const isFeatureEnabled = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(false);
    vi.doMock("./server", () => ({ analytics: { isFeatureEnabled } }));
    const { isFeatureFlagEnabledForDistinctId } = await import(
      "./feature-flags"
    );

    const unanswered = await isFeatureFlagEnabledForDistinctId(
      "unregistered-or-unreachable",
      "user-1"
    );
    const answeredOff = await isFeatureFlagEnabledForDistinctId(
      "registered-but-off",
      "user-1"
    );

    expect(unanswered).toBeNull();
    expect(answeredOff).toBe(false);
    // The assertion the two above exist to support: a caller can TELL THEM
    // APART. Re-collapsing `undefined` into `false` — the ISS-4556 defect —
    // makes both `false` and fails here, and it is the only line that does.
    expect(unanswered).not.toBe(answeredOff);
  });

  it("still fails CLOSED for a caller that only asks 'is it on?'", async () => {
    // The sibling. Distinguishing the two must not have opened anything: every
    // gate compares `=== true`, so an unanswered lookup is still not-on. A
    // change that made `null` truthy would pass the case above and fail here.
    const isFeatureEnabled = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./server", () => ({ analytics: { isFeatureEnabled } }));
    const { isFeatureFlagEnabledForDistinctId } = await import(
      "./feature-flags"
    );

    const result = await isFeatureFlagEnabledForDistinctId("flag", "user-1");

    expect(result === true).toBe(false);
  });
});

describe("getAllFeatureFlagsForDistinctId", () => {
  it("normalizes a variant string to enabled and keeps an explicit false", async () => {
    const getAllFlags = vi.fn().mockResolvedValue({
      "plain-on": true,
      "plain-off": false,
      "multivariate-on": "treatment",
    });
    vi.doMock("./server", () => ({ analytics: { getAllFlags } }));
    const { getAllFeatureFlagsForDistinctId } = await import("./feature-flags");

    await expect(getAllFeatureFlagsForDistinctId("user-1")).resolves.toEqual({
      "plain-on": true,
      "plain-off": false,
      "multivariate-on": true,
    });
    expect(getAllFlags).toHaveBeenCalledWith("user-1");
  });

  // The two normalizers had drifted here before they shared a predicate: this
  // file required a non-empty variant while `client.ts` read ANY string as
  // enabled, so one empty-string variant would have opened the gate on web and
  // closed it on desktop for the same person.
  it("reads an EMPTY variant string as enabled, exactly as the browser client does", async () => {
    vi.doMock("./server", () => ({
      analytics: {
        getAllFlags: vi.fn().mockResolvedValue({ "empty-variant": "" }),
      },
    }));
    const { getAllFeatureFlagsForDistinctId } = await import("./feature-flags");

    await expect(getAllFeatureFlagsForDistinctId("user-1")).resolves.toEqual({
      "empty-variant": true,
    });
  });

  it("reports UNKNOWN, not an empty assignment, when the client cannot read flags", async () => {
    vi.doMock("./server", () => ({ analytics: {} }));
    const { getAllFeatureFlagsForDistinctId } = await import("./feature-flags");

    // `null` and `{}` are different answers: `{}` is "this user is in no
    // rollouts" and settles a no-flash gate; `null` is "nobody answered".
    await expect(getAllFeatureFlagsForDistinctId("user-1")).resolves.toBeNull();
  });

  it("reports UNKNOWN when the client returns no assignment at all", async () => {
    vi.doMock("./server", () => ({
      analytics: { getAllFlags: vi.fn().mockResolvedValue(undefined) },
    }));
    const { getAllFeatureFlagsForDistinctId } = await import("./feature-flags");

    await expect(getAllFeatureFlagsForDistinctId("user-1")).resolves.toBeNull();
  });

  // A THROWN read propagates rather than folding to `null`, matching
  // `isFeatureFlagEnabledForDistinctId`. Per-id isolation belongs to the caller
  // that knows how many ids are in play: swallowing it here would make
  // `getAllFeatureFlagsForAnyIdentity`'s allSettled rejected-branch unreachable
  // and leave a multi-id caller unable to tell a failed read from an empty one.
  // Pinned so the contract cannot drift back to a silent `null`.
  it("PROPAGATES a thrown read instead of folding it into UNKNOWN", async () => {
    const thrown = new Error("posthog exploded");
    vi.doMock("./server", () => ({
      analytics: { getAllFlags: vi.fn().mockRejectedValue(thrown) },
    }));
    const { getAllFeatureFlagsForDistinctId } = await import("./feature-flags");

    await expect(getAllFeatureFlagsForDistinctId("user-1")).rejects.toBe(
      thrown
    );
  });
});

describe("pinned feature flags (ISS-12048)", () => {
  afterEach(async () => {
    const { setPinnedFeatureFlagsProvider } = await import("./feature-flags");
    setPinnedFeatureFlagsProvider(null);
  });

  it("answers both reads from the pinned flags instead of the live client", async () => {
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.doMock("./server", () => ({ analytics: { isFeatureEnabled } }));
    const {
      getAllFeatureFlagsForDistinctId,
      isFeatureFlagEnabledForDistinctId,
      setPinnedFeatureFlagsProvider,
    } = await import("./feature-flags");
    setPinnedFeatureFlagsProvider(() =>
      Promise.resolve({ "pinned-on": "variant-a", "pinned-off": false })
    );

    await expect(
      isFeatureFlagEnabledForDistinctId("pinned-on", "user-1")
    ).resolves.toBe(true);
    await expect(
      isFeatureFlagEnabledForDistinctId("pinned-off", "user-1")
    ).resolves.toBe(false);
    await expect(
      isFeatureFlagEnabledForDistinctId("absent-from-snapshot", "user-1")
    ).resolves.toBe(false);
    await expect(getAllFeatureFlagsForDistinctId("user-1")).resolves.toEqual({
      "pinned-on": true,
      "pinned-off": false,
    });
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });

  it("reads live when the provider pins nothing or throws", async () => {
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.doMock("./server", () => ({ analytics: { isFeatureEnabled } }));
    const { isFeatureFlagEnabledForDistinctId, setPinnedFeatureFlagsProvider } =
      await import("./feature-flags");

    setPinnedFeatureFlagsProvider(() => Promise.resolve(null));
    await expect(
      isFeatureFlagEnabledForDistinctId("live-flag", "user-1")
    ).resolves.toBe(true);

    setPinnedFeatureFlagsProvider(() => Promise.reject(new Error("db down")));
    await expect(
      isFeatureFlagEnabledForDistinctId("live-flag", "user-1")
    ).resolves.toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledTimes(2);
  });
});
