/**
 * ISS-8126 — the memo's CROSS-INSTANCE contract.
 *
 * ISS-7860's suite next door proves that one gate's reads agree with each other.
 * It structurally cannot reach this defect, because every case there shares one
 * memo: `apps/api` is serverless, and the surviving symptom was two reads served
 * by two COLD instances during a PostHog outage resolving differently — one
 * holding the parity decision, the other failing closed — with the reader watching
 * the status facet change between two nearby page loads.
 *
 * So every case here uses TWO SEPARATE GATES. That is not a stylistic choice: a
 * case that resolved twice through one gate would re-prove ISS-7860 and say
 * nothing about this one, and it would stay green with the shared store deleted.
 * The `without a shared store` case below is the explicit counterfactual — same
 * two gates, same evaluator script, opposite outcome — so the delta this change
 * buys is asserted rather than described.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMOIZED_GATE_SAMPLE_FLAG } from "@/__tests__/support/lib/memoized-feature-flag-gate.test-fixtures";
import type {
  SharedFlagDecision,
  SharedFlagDecisionStore,
} from "@/lib/feature-flag-decision-store";
import type { FeatureFlagIdentity } from "@/lib/feature-flag-identity";
import {
  createMemoizedFeatureFlagGate,
  type MemoizedFeatureFlagGate,
  type MemoizedFeatureFlagGateOptions,
} from "@/lib/memoized-feature-flag-gate";

const mocks = vi.hoisted(() => ({
  evaluateFeatureFlagForAnyIdentity: vi.fn(),
}));

// Only the evaluator is replaced: `resolveDistinctIdsForIdentity` stays real so
// both gates key this viewer exactly as production does — and so a key that
// stopped being stable across instances would fail here rather than silently
// give each instance its own row.
vi.mock("@/lib/feature-flag-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feature-flag-identity")>()),
  evaluateFeatureFlagForAnyIdentity: mocks.evaluateFeatureFlagForAnyIdentity,
}));

const FLAG = MEMOIZED_GATE_SAMPLE_FLAG;
const FLAG_KEY = FLAG.key;
const UNAVAILABLE_LOG_KEY = "cross_instance_test_flag_unavailable";
const TTL_MS = 60_000;
const UNAVAILABLE_BACKOFF_MS = 5000;
const MAX_ENTRIES = 100;
const SHARED_TTL_MS = 3_600_000;

const VIEWER: FeatureFlagIdentity = {
  userId: "user_alpha",
  clerkUserId: "clerk_alpha",
};

/**
 * The store key both gates derive for {@link VIEWER}, spelled out rather than
 * computed from `resolveDistinctIdsForIdentity` on purpose: a case below asserts
 * the published row lands on THIS key, and deriving it would make that assertion
 * agree with any keying the resolver happens to produce. Kept as one constant so
 * the three setup sites cannot drift from each other.
 *
 * ISS-8196 narrowed the resolver to the Clerk id alone, so this is
 * `["clerk_alpha"]` and no longer `["clerk_alpha", "user_alpha"]`.
 */
const VIEWER_GATE_KEY = JSON.stringify(["clerk_alpha"]);

// The gates take `now` as a parameter, so every window below is arithmetic on
// this rather than a clock the test would have to fake.
const T0 = 1_000_000;

/**
 * An in-memory stand-in for the Postgres store, shared by both gates.
 *
 * A fake rather than the real one because what is under test here is the GATE's
 * use of a shared record — which instance reads it, when, and what it does with
 * a stale or absent one. The production store's own SQL (the conditional upsert
 * that refuses to let an older evaluation overwrite a newer verdict) is proved
 * against a real Postgres in `feature-flag-decision-store.integration.test.ts`;
 * asserting it twice against a Map here would prove only that the Map works.
 */
function createFakeStore(): SharedFlagDecisionStore & {
  rows: Map<string, SharedFlagDecision>;
  reads: string[];
} {
  const rows = new Map<string, SharedFlagDecision>();
  const reads: string[] = [];
  return {
    rows,
    reads,
    read(flagKey, viewerKey) {
      reads.push(`${flagKey}:${viewerKey}`);
      return Promise.resolve(rows.get(`${flagKey}:${viewerKey}`) ?? null);
    },
    publish(flagKey, viewerKey, decision) {
      const key = `${flagKey}:${viewerKey}`;
      const existing = rows.get(key);
      // Mirrors the production upsert's freshness guard so the fake cannot make
      // the gate look better behaved than the real store would.
      if (!existing || existing.decidedAt <= decision.decidedAt) {
        rows.set(key, decision);
      }
      return Promise.resolve();
    },
  };
}

/** One instance's gate, identical across cases but for what a case overrides. */
function createGate(
  overrides: Partial<MemoizedFeatureFlagGateOptions> = {}
): MemoizedFeatureFlagGate {
  return createMemoizedFeatureFlagGate({
    flag: FLAG,
    unavailableLogKey: UNAVAILABLE_LOG_KEY,
    ttlMs: TTL_MS,
    unavailableBackoffMs: UNAVAILABLE_BACKOFF_MS,
    maxEntries: MAX_ENTRIES,
    ...overrides,
  });
}

describe("createMemoizedFeatureFlagGate across instances (ISS-8126)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.evaluateFeatureFlagForAnyIdentity.mockReset();
  });

  it("gives a cold instance the decision another instance already evaluated", async () => {
    const store = createFakeStore();
    const instanceA = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });
    const instanceB = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });

    // Instance A serves the first page load while PostHog is healthy.
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(true);
    const first = await instanceA.resolve(VIEWER, T0);

    // The next read lands on a DIFFERENT, cold instance a minute later, and
    // PostHog cannot answer it. Before this change that instance had nothing to
    // hold and fell to the closed default, swapping the reader's status predicate.
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(null);
    const second = await instanceB.resolve(VIEWER, T0 + TTL_MS + 1);

    expect(first).toBe(true);
    expect(second).toBe(true);
    // Both gates were really consulted — a fake that answered from one memo
    // would show a single evaluation.
    expect(mocks.evaluateFeatureFlagForAnyIdentity).toHaveBeenCalledTimes(2);
  });

  it("without a shared store, the same two instances disagree", async () => {
    // The counterfactual for the case above, in the suite rather than in a
    // reviewer's head: identical gates, identical evaluator script, no store.
    const instanceA = createGate();
    const instanceB = createGate();

    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(true);
    const first = await instanceA.resolve(VIEWER, T0);

    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(null);
    const second = await instanceB.resolve(VIEWER, T0 + TTL_MS + 1);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("still fails closed when no instance has ever evaluated this viewer", async () => {
    const store = createFakeStore();
    const instanceB = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });

    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(null);
    const resolved = await instanceB.resolve(VIEWER, T0);

    // The house default, unchanged and deliberately so: an unreachable flag
    // service must not open a dark-launched feature. This change narrows what
    // counts as "genuinely unanswered", it does not reverse the answer.
    expect(resolved).toBe(false);
    // And the store really was consulted before falling back, so this is the
    // fail-closed path and not a path that never looked.
    expect(store.reads).toHaveLength(1);
  });

  it("honors a stored decision at the edge of the stability window and not past it", async () => {
    const store = createFakeStore();
    const instanceA = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });

    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(true);
    await instanceA.resolve(VIEWER, T0);

    const atEdge = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(null);
    expect(await atEdge.resolve(VIEWER, T0 + SHARED_TTL_MS)).toBe(true);

    // One millisecond past the window the record is history rather than a
    // decision, and the gate returns to the closed default. Asserted on a THIRD
    // gate: reusing `atEdge` would read its own freshly re-armed entry and pass
    // for the wrong reason — the same shape of false green ISS-7860's review
    // caught when a case advanced 1s into a 60s TTL.
    const pastEdge = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(null);
    expect(await pastEdge.resolve(VIEWER, T0 + SHARED_TTL_MS + 1)).toBe(false);
  });

  it("prefers a newer stored decision over its own stale local one", async () => {
    const store = createFakeStore();
    const instanceA = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });

    // A evaluates ON and holds it locally.
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(true);
    expect(await instanceA.resolve(VIEWER, T0)).toBe(true);

    // Meanwhile the rollout is turned off and instance B evaluates OFF.
    const instanceB = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(false);
    expect(await instanceB.resolve(VIEWER, T0 + 1000)).toBe(false);

    // A's memo expires and its own PostHog lookup now fails. Holding its stale
    // local ON here is the failure this ordering exists to prevent: it would
    // resurrect a decision another instance has already superseded, and put the
    // two instances back in disagreement through the very record meant to keep
    // them together.
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(null);
    expect(await instanceA.resolve(VIEWER, T0 + TTL_MS + 1)).toBe(false);
  });

  it("leaves an evaluated answer alone rather than reading the store for it", async () => {
    const store = createFakeStore();
    const gate = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });

    // A stale ON on record for this viewer, which a store consulted on the happy
    // path would let win.
    await store.publish(FLAG_KEY, VIEWER_GATE_KEY, {
      value: true,
      decidedAt: T0,
    });

    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(false);
    const resolved = await gate.resolve(VIEWER, T0 + 1000);

    // PostHog stays authoritative when it answers, so turning a rollout off
    // still takes effect within the memo's TTL instead of being pinned by the
    // stored decision.
    expect(resolved).toBe(false);
    expect(store.reads).toHaveLength(0);
  });

  it("publishes an evaluated decision so the next cold instance can inherit it", async () => {
    const store = createFakeStore();
    const gate = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });

    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(true);
    await gate.resolve(VIEWER, T0);

    // Keyed on the gate's own cache key, so a change to how viewers are keyed
    // cannot silently give each instance its own row — which would leave every
    // instance cold and this whole change inert.
    expect([...store.rows.entries()]).toEqual([
      [`${FLAG_KEY}:${VIEWER_GATE_KEY}`, { value: true, decidedAt: T0 }],
    ]);
  });

  it("stops honoring a decision it ADOPTED once that decision's own window ends", async () => {
    const store = createFakeStore();
    const publisher = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });
    const recipient = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });

    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(true);
    expect(await publisher.resolve(VIEWER, T0)).toBe(true);

    // The recipient is cold, cannot reach PostHog, and adopts the record. From
    // here on it is WARM — it holds a copy of a decision it never evaluated.
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(null);
    expect(await recipient.resolve(VIEWER, T0 + TTL_MS + 1)).toBe(true);

    // Still inside the window the adoption is honored, which is what stops the
    // assertion below from passing merely because everything went closed.
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(null);
    expect(await recipient.resolve(VIEWER, T0 + SHARED_TTL_MS)).toBe(true);

    // ONE MILLISECOND past the ORIGINAL evaluation's window, on the SAME
    // instance that adopted it — the exact boundary, not the boundary plus a
    // backoff. The read immediately above re-armed the adoption, so this asserts
    // both halves of the bound at once: the re-arm's `expiresAt` was CLIPPED to
    // the end of the record's window, so the cached-read fast path cannot serve
    // it here, and the candidate check then refuses to re-adopt it.
    //
    // Clipping is what makes this millisecond the boundary. Without it the
    // re-arm is a negative-cache entry like any other and is served without
    // re-deciding until `unavailableBackoffMs` elapses, so a removed rollout
    // outlived its own window by that much on exactly the instances that never
    // evaluated it.
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(null);
    expect(await recipient.resolve(VIEWER, T0 + SHARED_TTL_MS + 1)).toBe(false);

    // And it does not come back: the expired adoption must not be re-armed as a
    // fresh local decision by the very lookup that rejected it, which would
    // restart this cycle every backoff for as long as the outage lasted.
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(null);
    expect(
      await recipient.resolve(
        VIEWER,
        T0 + SHARED_TTL_MS + UNAVAILABLE_BACKOFF_MS + 2
      )
    ).toBe(false);
  });

  it("breaks an equal-timestamp tie toward the stored verdict, so both instances agree", async () => {
    const store = createFakeStore();
    const instanceA = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });

    // A evaluates ON and publishes it.
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(true);
    expect(await instanceA.resolve(VIEWER, T0)).toBe(true);

    // A second instance evaluated the SAME viewer in the same millisecond, on
    // the other side of a rollout flip, and got the opposite verdict. Its write
    // lands second, and the conditional upsert accepts an equal-timestamp write
    // — mirrored by the fake's `<=`. The record now says OFF at T0.
    await store.publish(FLAG_KEY, VIEWER_GATE_KEY, {
      value: false,
      decidedAt: T0,
    });

    // A's memo expires and PostHog cannot answer. Its local ON and the stored
    // OFF are equally fresh, so the tie decides the answer. Preferring its own
    // copy would leave A serving ON while every other instance reads OFF from
    // the same row — two instances disagreeing through the record that exists to
    // keep them together.
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(null);
    const fromWarmInstance = await instanceA.resolve(VIEWER, T0 + TTL_MS + 1);

    // What a cold instance sees, as the reference: it has no local copy, so it
    // can only read the row.
    const instanceC = createGate({
      sharedDecisionStore: store,
      sharedDecisionTtlMs: SHARED_TTL_MS,
    });
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(null);
    const fromColdInstance = await instanceC.resolve(VIEWER, T0 + TTL_MS + 1);

    expect(fromWarmInstance).toBe(false);
    // Asserted as an EQUALITY rather than two independent `false`s: the promise
    // this store makes is that instances agree, and it is the agreement that
    // must hold whichever way the tie is settled.
    expect(fromWarmInstance).toBe(fromColdInstance);
  });
});
