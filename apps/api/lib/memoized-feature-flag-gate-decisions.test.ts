import { analytics } from "@repo/analytics/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMOIZED_GATE_SAMPLE_FLAG } from "@/__tests__/support/lib/memoized-feature-flag-gate.test-fixtures";
import {
  createMemoizedFeatureFlagGate,
  type MemoizedFeatureFlagGate,
} from "@/lib/memoized-feature-flag-gate";

/**
 * ISS-4556 / ISS-8196 — the memo's DECISION contract: what one viewer is served
 * across reads, what an unanswered evaluation does to that, and what the entry
 * cap evicts.
 *
 * These cases lived on `apps/api/app/agent-sessions/service/displayed-status-parity.test.ts`
 * and drove them through `resolveDisplayedStatusParity`, the Sessions gate
 * ISS-10742 deleted once its last reader was gone. Every behaviour they pin
 * belongs to {@link createMemoizedFeatureFlagGate}, not to that gate's key, and
 * the module still has a live consumer (`resolveUsageTypedSqlShadow`), so they
 * moved here with the subject rather than being deleted with the caller.
 *
 * Unlike `memoized-feature-flag-gate.test.ts` — which stubs the evaluator to
 * isolate CONCURRENCY — these drive the real `evaluateFeatureFlagForAnyIdentity`
 * and stub only PostHog's own answer, because the distinction several of them
 * turn on — a RESOLVED `undefined` versus a definite `false` — is that
 * evaluator's and is invisible to a mock of it.
 *
 * ISS-8196 capped `resolveDistinctIdsForIdentity` at ONE id, so the multi-id
 * behaviours these cases were written against — a throw on a second id, an
 * asked-first ordering, a separator collision between a one-id and a two-id key
 * — are unreachable, not merely untested (#7671 review, tamsinb).
 *
 * The gate is constructed HERE rather than imported, so the cap a case has to
 * fill is this file's own small number rather than production's 5000.
 */

vi.mock("@repo/analytics/server", () => ({
  analytics: { isFeatureEnabled: undefined },
}));

const FLAG = MEMOIZED_GATE_SAMPLE_FLAG;
const UNAVAILABLE_LOG_KEY = "memoized_gate_decision_test_flag_unavailable";
const TTL_MS = 60_000;
const UNAVAILABLE_BACKOFF_MS = 5000;
const MAX_ENTRIES = 50;
const CLERK_USER_ID = "user_clerk_1";
// The memo takes `now` as a parameter, so expiry is driven by arithmetic on
// this rather than by a clock the test would have to fake.
const T0 = 1_000_000;
const AFTER_TTL = T0 + TTL_MS + 1;

describe("createMemoizedFeatureFlagGate decisions (ISS-4556)", () => {
  let gate: MemoizedFeatureFlagGate;

  beforeEach(() => {
    vi.clearAllMocks();
    // ISS-4556: `clearAllMocks` clears call RECORDS, not implementations, so an
    // `isFeatureEnabled` assigned by an earlier test survives into the next one —
    // and the module mock's `undefined` (the "no analytics client configured"
    // path, which is the only way `evaluateFeatureFlagForAnyIdentity` can report
    // UNAVAILABLE without a throw) becomes unreachable after the first
    // assignment. Restore the declared default explicitly. `deleteProperty`
    // rather than assigning `undefined`: that is the state the production guard
    // actually tests (`typeof analytics?.isFeatureEnabled !== "function"`), and
    // it needs no cast to satisfy the PostHog client's non-optional method type.
    Reflect.deleteProperty(analytics, "isFeatureEnabled");
    gate = createMemoizedFeatureFlagGate({
      flag: FLAG,
      unavailableLogKey: UNAVAILABLE_LOG_KEY,
      ttlMs: TTL_MS,
      unavailableBackoffMs: UNAVAILABLE_BACKOFF_MS,
      maxEntries: MAX_ENTRIES,
    });
  });

  it("evaluates the Clerk distinct id, not only the internal user id", async () => {
    // A rollout targeted at Clerk ids is the normal case. Asking PostHog only
    // about the internal id would leave a browser-facing rollout dark while the
    // key it is targeted at is enrolled — invisible from the outside.
    // `isFeatureEnabled` here answers true ONLY for the Clerk id, so a
    // regression to a single-identity lookup fails this test rather than
    // passing on the default-off path.
    const isFeatureEnabled = vi
      .fn()
      .mockImplementation((_flag: string, distinctId: string) =>
        Promise.resolve(distinctId === CLERK_USER_ID)
      );
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;

    const enabled = await gate.resolve({
      userId: "internal-user-1",
      clerkUserId: CLERK_USER_ID,
    });

    expect(enabled).toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledWith(FLAG.key, CLERK_USER_ID);
  });

  it("evaluates ONCE per viewer rather than once per read", async () => {
    // A page load issues several independent requests. Asking PostHog once per
    // request made a gate per-REQUEST: a timeout on one of them served that
    // request the fail-closed answer while its siblings served the evaluated
    // one, splitting one load across two cohorts. Four resolves, ONE evaluation.
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const identity = { userId: "internal-user-1", clerkUserId: CLERK_USER_ID };

    const decisions = [
      await gate.resolve(identity),
      await gate.resolve(identity),
      await gate.resolve(identity),
      await gate.resolve(identity),
    ];

    expect(decisions).toEqual([true, true, true, true]);
    expect(isFeatureEnabled).toHaveBeenCalledTimes(1);
  });

  it("holds the viewer's last decision when an evaluation is unavailable", async () => {
    // The defect this closes: a transient PostHog failure on ONE of a load's
    // reads used to resolve to a silent `false`, splitting that load across two
    // cohorts. The read after the outage must report what the reads before it
    // did.
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const identity = { userId: "internal-user-1", clerkUserId: CLERK_USER_ID };

    expect(await gate.resolve(identity, T0)).toBe(true);

    isFeatureEnabled.mockRejectedValue(new Error("posthog unavailable"));

    // Past the memo window, so the outage is actually reached rather than
    // answered from cache.
    expect(await gate.resolve(identity, AFTER_TTL)).toBe(true);
    // ISS-8196: two calls, one per read. It used to be three — the outage read
    // retried the internal id after the Clerk id threw — but the browser
    // identifies PostHog with the Clerk id alone, so that retry was a second,
    // independent rollout draw rather than a second namespace.
    expect(isFeatureEnabled).toHaveBeenCalledTimes(2);
  });

  it("still fails CLOSED when an evaluation is unavailable and nothing was decided before", async () => {
    // Holding the last decision must not become "default on". A viewer this
    // instance has never resolved gets the closed default.
    const isFeatureEnabled = vi
      .fn()
      .mockRejectedValue(new Error("posthog unavailable"));
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;

    expect(
      await gate.resolve({
        userId: "internal-user-cold",
        clerkUserId: "user_clerk_cold",
      })
    ).toBe(false);
  });

  it("treats a RESOLVED-undefined evaluation as unavailable, not as an evaluated OFF", async () => {
    // ISS-4556. The cases above prove the unavailable path with a THROW, and a
    // throw was the only way to reach it — which made the whole mitigation inert
    // for the outage it was built for. posthog-node does not reject when
    // evaluation fails: `isFeatureEnabled` is typed `Promise<boolean | undefined>`
    // and its request-failure path returns `undefined`. A bare `=== true` in
    // `isFeatureFlagEnabledForDistinctId` folded that into a definite `false`, so
    // an outage read as "PostHog says OFF" — and this memo then cached that wrong
    // answer for the full TTL, making it STICKIER than the per-request evaluation
    // it replaced.
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const identity = { userId: "internal-user-1", clerkUserId: CLERK_USER_ID };

    expect(await gate.resolve(identity, T0)).toBe(true);

    isFeatureEnabled.mockResolvedValue(undefined);

    // Held, not flipped. Before the fix this returned `false`.
    expect(await gate.resolve(identity, AFTER_TTL)).toBe(true);
  });

  it("replaces a held decision with a definite OFF", async () => {
    // ISS-4556: an evaluated `false` is not the UNAVAILABLE verdict and must not
    // be held past. Conflating them left a viewer whose flag had genuinely just
    // been turned off still being served ON for as long as the entry survived.
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const identity = { userId: "internal-user-1", clerkUserId: CLERK_USER_ID };

    expect(await gate.resolve(identity, T0)).toBe(true);

    isFeatureEnabled.mockResolvedValue(false);

    expect(await gate.resolve(identity, AFTER_TTL)).toBe(false);
  });

  it("does not let one viewer's successful evaluation destroy another's outage fallback", async () => {
    // ISS-4556: the expired-entry sweep walked the WHOLE map, so viewer B's
    // successful evaluation deleted viewer A's expired entry — the exact fallback
    // the unavailable branch promises to hold. A's decision has to survive B.
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const viewerA = { userId: "internal-a", clerkUserId: "user_clerk_a" };
    const viewerB = { userId: "internal-b", clerkUserId: "user_clerk_b" };

    expect(await gate.resolve(viewerA, T0)).toBe(true);

    // Past A's TTL, B evaluates successfully — the moment the sweep used to fire.
    expect(await gate.resolve(viewerB, AFTER_TTL)).toBe(true);

    // Now A reads during an outage and must still get its own held decision.
    isFeatureEnabled.mockResolvedValue(undefined);
    expect(await gate.resolve(viewerA, AFTER_TTL)).toBe(true);
  });

  it("backs off instead of re-asking PostHog on every read during an outage", async () => {
    // ISS-4556: the unavailable branch returned WITHOUT re-arming `expiresAt`, so
    // a sustained outage re-issued a blocking PostHog call on each read of every
    // page load — no negative caching at all.
    const isFeatureEnabled = vi.fn().mockResolvedValue(undefined);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const identity = {
      userId: "internal-cold",
      clerkUserId: "user_clerk_cold",
    };

    expect(await gate.resolve(identity, T0)).toBe(false);
    const callsAfterFirstRead = isFeatureEnabled.mock.calls.length;
    expect(callsAfterFirstRead).toBeGreaterThan(0);

    // The remaining reads of the same page load are answered from the backoff
    // entry rather than each taking another swing at a failing service.
    expect(await gate.resolve(identity, T0 + 1)).toBe(false);
    expect(isFeatureEnabled).toHaveBeenCalledTimes(callsAfterFirstRead);

    // Past the backoff, recovery is picked up.
    isFeatureEnabled.mockResolvedValue(true);
    expect(await gate.resolve(identity, T0 + UNAVAILABLE_BACKOFF_MS + 1)).toBe(
      true
    );
  });

  it("keys the memo on the RESOLVED distinct ids, not on the raw identity", async () => {
    // ISS-4556: inheriting another viewer's decision means serving a
    // dark-launched feature to someone PostHog never enabled it for. The
    // separator collision that motivated the key needed a two-id list and is
    // unreachable since ISS-8196, so what is pinned here is the half that is
    // still live: the key is built from what `resolveDistinctIdsForIdentity`
    // ANSWERS. Keyed on the raw identity, the last read below would miss the
    // entry the first one seeded and take its own PostHog evaluation.
    const isFeatureEnabled = vi
      .fn()
      .mockImplementation((_flag: string, distinctId: string) =>
        Promise.resolve(distinctId === "a")
      );
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;

    // Resolves ["a"] through the Clerk id — enabled, because "a" is enrolled.
    expect(await gate.resolve({ clerkUserId: "a", userId: "b" }, T0)).toBe(
      true
    );

    // Resolves ["b"] — a DIFFERENT principal, enrolled in nothing.
    expect(await gate.resolve({ userId: "b" }, T0)).toBe(false);

    // Resolves ["a"] too, through the clerk-less fallback: the SAME entry, so it
    // answers from the memo with no further evaluation.
    const callsBefore = isFeatureEnabled.mock.calls.length;
    expect(await gate.resolve({ userId: "a" }, T0)).toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledTimes(callsBefore);
  });

  it("evicts the least-recently-refreshed viewer, not the first one ever seen", async () => {
    // ISS-4556: `Map.set` on an existing key keeps its ORIGINAL insertion slot, so
    // eviction from the front was first-SEEN order — which preferentially drops
    // the most ACTIVE viewers, the ones refreshing most often.
    const isFeatureEnabled = vi.fn().mockResolvedValue(true);
    vi.mocked(analytics).isFeatureEnabled = isFeatureEnabled;
    const busyViewer = { userId: "internal-busy" };

    // The busy viewer is seen FIRST, then the map is filled to exactly the cap —
    // no eviction yet, so the ordering question is still open when it refreshes.
    expect(await gate.resolve(busyViewer, T0)).toBe(true);
    for (let i = 0; i < MAX_ENTRIES - 1; i++) {
      await gate.resolve({ userId: `internal-filler-${i}` }, T0);
    }
    // The busy viewer refreshes, which must move it to the BACK of the queue.
    expect(await gate.resolve(busyViewer, AFTER_TTL)).toBe(true);

    // One more viewer pushes the map over the cap. The victim must be the oldest
    // UNREFRESHED filler, so the busy viewer is still memoized: it answers with no
    // further PostHog call. Without the delete-before-set the busy viewer is still
    // sitting in its original first slot and is the one evicted here.
    await gate.resolve({ userId: "internal-newcomer" }, AFTER_TTL);
    const callsBefore = isFeatureEnabled.mock.calls.length;
    expect(await gate.resolve(busyViewer, AFTER_TTL)).toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledTimes(callsBefore);
  });

  it("bounds the decision map on the UNAVAILABLE path too", async () => {
    // ISS-4556: the entry cap is this map's ONLY bound, and the UNAVAILABLE
    // branch inserts an entry per viewer just as the success branch does — but
    // pruning used to run only after the success path, so the bound was
    // unenforced on exactly the path that runs when PostHog cannot answer.
    //
    // That is steady state, not merely an outage: with no `NEXT_PUBLIC_POSTHOG_KEY`
    // the analytics stub exposes no `isFeatureEnabled` at all, and posthog-node
    // resolves `undefined` for a flag key not yet created in the project — both
    // report UNAVAILABLE. So every viewer takes this branch for the whole window
    // before the flag exists, on an instance that is long-lived because `apps/api`
    // also serves Socket.IO.
    const strandedViewer = { userId: "internal-stranded" };

    // Seed ONE real decision first. That is what makes eviction observable: a
    // surviving entry keeps answering `true` (the branch's promise to "hold the
    // last known decision", which it does even once expired), so only an EVICTED
    // entry can fall back to the cold-start `false`.
    vi.mocked(analytics).isFeatureEnabled = vi.fn().mockResolvedValue(true);
    expect(await gate.resolve(strandedViewer, T0)).toBe(true);

    // ...then PostHog stops answering, and distinct viewers keep arriving. The
    // deleted property is the real "no analytics client configured" shape the
    // production guard tests, not a stand-in for it.
    Reflect.deleteProperty(analytics, "isFeatureEnabled");
    for (let i = 0; i <= MAX_ENTRIES; i++) {
      await gate.resolve({ userId: `internal-outage-${i}` }, T0);
    }

    // The oldest entry — the seeded one — must have been evicted by the cap.
    // Unpruned, the map simply grows and this viewer still answers `true`.
    expect(await gate.resolve(strandedViewer, T0)).toBe(false);
  });
});
