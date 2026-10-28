import { BoundedMap } from "@repo/lib/bounded-map";
import type {
  SharedFlagDecision,
  SharedFlagDecisionStore,
} from "@/lib/feature-flag-decision-store";
import {
  evaluateFeatureFlagForAnyIdentity,
  type FeatureFlagIdentity,
  resolveDistinctIdsForIdentity,
} from "@/lib/feature-flag-identity";
import { recordCheckedServerFeatureFlag } from "@/lib/feature-flags/feature-flag-request-scope";
import { resolveUnmemoizedFeatureFlagValue } from "@/lib/feature-flags/server-feature-flag-evaluation";
import type { RegisteredServerFeatureFlag } from "@/lib/feature-flags/server-feature-flags";

/**
 * ISS-4556's per-viewer flag memo, generalized (ISS-7860).
 *
 * The pattern this owns is not "cache a boolean". It is the narrower promise
 * that a viewer's reads AGREE with each other: several requests inside one page
 * load resolve the same gate, and a flag service that answers for one of them
 * and not the next silently splits a screen across two regimes — a table built
 * with one predicate above summary cards built with the other, a ratio computed
 * against one cost basis after the reader already saw the other. Neither shows
 * an error, because from each read's own point of view nothing went wrong.
 *
 * FOUR PROPERTIES MAKE THAT HOLD, and each one is load-bearing:
 *
 *  • An EVALUATED answer is reused for {@link MemoizedFeatureFlagGateOptions.ttlMs},
 *    so the reads of one page load share one answer rather than taking N
 *    independent chances at PostHog.
 *  • CONCURRENT reads of an expired entry share ONE evaluation instead of
 *    racing. Two round trips can come back differently — one evaluated, one
 *    unavailable — and the loser's fallback would otherwise both answer its own
 *    caller with the other value and overwrite the evaluated one.
 *  • An UNAVAILABLE evaluation holds the viewer's LAST KNOWN decision instead of
 *    silently reading as `false`. This is the whole point: `false` and "could not
 *    ask" are indistinguishable to a caller, and collapsing them is what flips a
 *    reader's number mid-session.
 *  • A cold cache with no prior decision still fails CLOSED, because an
 *    unreachable flag service must not open a dark-launched feature. The
 *    unavailable entry is then re-armed on the SHORT
 *    {@link MemoizedFeatureFlagGateOptions.unavailableBackoffMs} rather than the
 *    full TTL, so a recovered PostHog is picked up within a page load or two
 *    while a sustained outage still costs one blocking call per viewer per
 *    window.
 *
 * A FIFTH PROPERTY, OPT-IN (ISS-8126), CLOSES THE RESIDUAL WINDOW THE FOUR
 * ABOVE CANNOT. `apps/api` is serverless, so two reads landing on two instances
 * that both have a cold cache still disagreed when PostHog was failing for one
 * of them: the third property holds a viewer's LAST KNOWN decision, and a cold
 * instance has none to hold. A gate given a
 * {@link MemoizedFeatureFlagGateOptions.sharedDecisionStore} publishes every
 * EVALUATED decision to a record both instances can see, and consults it — only
 * on the UNAVAILABLE path — when its own memo has nothing fresher. The record is
 * honored for {@link MemoizedFeatureFlagGateOptions.sharedDecisionTtlMs} after
 * the EVALUATION, not after the write.
 *
 * THREE THINGS THAT DID NOT CHANGE, because each is the thing a reader of this
 * module is most likely to assume did:
 *
 *  • FAIL-CLOSED. A genuinely unanswered lookup — nothing local, nothing fresh
 *    on record — still resolves `false`. This narrows what counts as
 *    "unanswered"; it does not reverse the answer.
 *  • POSTHOG STAYS AUTHORITATIVE. The store is never read when an evaluation
 *    succeeds, so turning a rollout off still takes effect within `ttlMs`
 *    instead of being pinned by a stored decision.
 *  • A GATE WITHOUT A STORE IS BYTE-FOR-BYTE THE OLD GATE. Both options are
 *    optional, and a consumer that omits them gets ISS-7860's gate unchanged.
 *    The guided required-phases gate (ISS-11073) is the one that sets them,
 *    because it decides a BLOCKING sequence rather than a presentation detail.
 *
 * THE FALLBACK IS THE FRESHEST DECISION, not the local one. Two instances can
 * hold different decisions — one evaluated ON before the rollout changed, the
 * other OFF after — and preferring whichever happens to be local would let the
 * superseded value win on the instance that still has it, putting the two back
 * in disagreement through the very record meant to keep them together. Both
 * candidates carry the moment PostHog decided them, and the later one wins; an
 * exact TIE goes to the stored record, which is the only copy both instances
 * can see and therefore the only tie-break they can agree on.
 *
 * AND AN ADOPTED DECISION AGES OUT ON ITS OWN CLOCK — EXACTLY, not
 * approximately. An instance that inherits a record writes a copy into its own
 * memo and re-arms it on every unavailable lookup. That copy is marked as
 * inherited and stops being honored once `sharedDecisionTtlMs` has passed SINCE
 * THE ORIGINAL EVALUATION — otherwise the window would apply to the record and
 * not to the copy, and a warm recipient would hold a removed rollout for the
 * whole outage.
 *
 * That takes BOTH halves, because the two bound different things. Refusing an
 * expired copy as a fallback CANDIDATE bounds what may be adopted; clipping an
 * inherited re-arm's `expiresAt` to the end of the record's window bounds what
 * may be SERVED, since the cached read returns before the candidate check is
 * ever reached. With only the first, the last re-arm before the window closed
 * went on being handed out for a whole `unavailableBackoffMs` past it. Holding
 * your own EVALUATED answer is unbounded, as it was before ISS-8126: that is
 * ISS-7860's contract and this does not touch it.
 *
 * EXTRACTED, NOT COPIED. A second inline implementation of this is how one gate
 * ends up with negative caching and its sibling does not, or how one prunes its
 * map and the other grows unbounded. Every consumer gets the same four
 * properties or none of them.
 */

/** How a gate's memo behaves. Each consumer owns its own map and its own keys. */
export type MemoizedFeatureFlagGateOptions = {
  /**
   * The classified server flag to evaluate (ISS-7778). The descriptor rather
   * than a bare key, so a gate cannot be built for an unclassified flag.
   */
  flag: RegisteredServerFeatureFlag;
  /**
   * Structured-log event name handed to the evaluator, which emits it only when
   * an evaluation THROWS — never for the ordinary "no client configured" or
   * "flag unevaluated" silence.
   */
  unavailableLogKey: string;
  /**
   * How long one viewer's EVALUATED decision is reused. Long enough to cover the
   * reads a single page load issues, short enough that flipping the PostHog
   * rollout takes effect promptly.
   */
  ttlMs: number;
  /**
   * How long an UNAVAILABLE evaluation is honored before PostHog is asked again.
   * Deliberately much shorter than {@link ttlMs}: the cached answer there is a
   * fallback rather than an evaluation, so the cost of holding it too long is a
   * viewer stuck on a stale decision.
   */
  unavailableBackoffMs: number;
  /**
   * Hard entry cap, per the AGENTS.md bounded-growth rule for in-memory maps
   * keyed on external input. Evicts least-recently-refreshed first; a viewer
   * evicted early simply re-evaluates.
   */
  maxEntries: number;
  /**
   * ISS-8126: where an EVALUATED decision is published so a DIFFERENT instance
   * can hold it, and where an unavailable evaluation looks for one.
   *
   * Optional because it is a different risk class from the memo — shared state
   * on a serverless request path — and is worth taking only for a gate whose
   * flicker a reader can actually see. Omitted, this gate behaves exactly as it
   * did before ISS-8126.
   *
   * Its `read` must not throw: it is called only because PostHog has ALREADY
   * failed, and turning a second infrastructure failure into a thrown request
   * would take a whole page down to avoid a divisor changing. The production
   * implementation honors that by reporting a failed round trip as "no decision
   * on record".
   */
  sharedDecisionStore?: SharedFlagDecisionStore;
  /**
   * ISS-8126: how long after its EVALUATION a shared decision is still honored
   * by an instance whose own lookup came back unanswered — the window across
   * which a viewer's decision is stable.
   *
   * Necessarily much longer than {@link ttlMs}, which is sized for one page
   * load: the case this exists for is a cold instance during an outage, and an
   * outage outlasts a page load by orders of magnitude. Necessarily BOUNDED,
   * because a record honored forever would let a viewer removed from the
   * rollout keep the feature for as long as PostHog stayed unreachable.
   *
   * Required in practice whenever {@link sharedDecisionStore} is set: without
   * it no stored decision is ever honored and the store is inert.
   */
  sharedDecisionTtlMs?: number;
};

export type MemoizedFeatureFlagGate = {
  /**
   * Resolve the gate for one viewer. `now` is injectable so expiry is testable
   * without a wall clock.
   */
  resolve(identity: FeatureFlagIdentity, now?: number): Promise<boolean>;
  /**
   * Test seam: drop every memoized decision for this gate.
   *
   * IN-PROCESS ONLY. It does not reach a {@link
   * MemoizedFeatureFlagGateOptions.sharedDecisionStore}, and it must not — an
   * instance clearing its own memo has no business deleting a record other
   * instances are holding. A suite that drives a store-backed gate and needs a
   * genuinely cold start therefore needs `purgeFeatureFlagDecisions` as well;
   * clearing only the memo leaves the gate able to inherit the decision the
   * previous case published.
   */
  clear(): void;
};

type GateDecision = {
  value: boolean;
  /**
   * When PostHog EVALUATED this value, or `null` when the entry is the
   * fail-closed default rather than a decision.
   *
   * The distinction is load-bearing (ISS-8126), not bookkeeping. A cold
   * instance that fails closed writes `false` here too, and if that `false`
   * carried a timestamp it would look NEWER than a real decision another
   * instance made moments earlier — so the freshness comparison would prefer a
   * value nobody ever evaluated and pin the viewer to it for a whole backoff
   * window. `null` means "not a candidate".
   */
  decidedAt: number | null;
  expiresAt: number;
  /**
   * Whether this entry's value came from the SHARED record rather than from
   * this instance's own PostHog evaluation.
   *
   * Provenance, not bookkeeping. `decidedAt` survives every unavailable-backoff
   * refresh, so without this an adopted decision becomes an UNBOUNDED local
   * fallback: {@link readSharedDecision} stops returning the row once
   * `sharedDecisionTtlMs` has passed, but the copy this instance wrote into its
   * own memo when it adopted the row would keep winning, and keep re-arming
   * itself on every unavailable lookup, for the rest of the outage. That would
   * preserve a removed rollout indefinitely on exactly the instances that never
   * evaluated it. A locally EVALUATED decision is not bounded this way — holding
   * your own last-known answer through an outage is ISS-7860's contract and is
   * unchanged here.
   */
  inherited: boolean;
};

/**
 * A fallback candidate and where it came from.
 *
 * The origin is carried because it decides EQUAL-TIMESTAMP ties, which are not
 * the non-event they look like: two instances can evaluate one viewer in the
 * same millisecond either side of a rollout flip and get OPPOSITE verdicts, and
 * the conditional upsert accepts whichever equal-timestamp write lands last. If
 * each instance then preferred its own local verdict on the tie, the two would
 * go on disagreeing while reading the same row — the exact split this store
 * exists to close.
 */
type FallbackCandidate = SharedFlagDecision & {
  origin: "local" | "shared";
};

export function createMemoizedFeatureFlagGate(
  options: MemoizedFeatureFlagGateOptions
): MemoizedFeatureFlagGate {
  const memo = createGateMemo(options, (identity) =>
    evaluateFeatureFlagForAnyIdentity(
      options.flag,
      identity,
      options.unavailableLogKey
    )
  );
  return {
    clear: memo.clear,
    // ISS-12048: a pinned snapshot or the caller's own Dev Mode override is
    // answered first and never cached or published, so one person's override
    // cannot reach another viewer through the memo or the shared store.
    async resolve(
      identity: FeatureFlagIdentity,
      now: number = Date.now()
    ): Promise<boolean> {
      recordCheckedServerFeatureFlag(options.flag.key);
      const unmemoized = await resolveUnmemoizedFeatureFlagValue(
        options.flag,
        resolveDistinctIdsForIdentity(identity)
      );
      if (unmemoized !== undefined) {
        return unmemoized;
      }
      return (await memo.resolveMemoized(identity, now)) ?? false;
    },
  };
}

/** A memoized gate for a flag evaluated per organization (a PostHog group). */
export type MemoizedOrganizationFeatureFlagGate = {
  /**
   * The organization's decision: evaluated, or held through an outage as
   * {@link createMemoizedFeatureFlagGate} holds one. `null` when PostHog did
   * not answer and no decision is held, so a caller that must not record an
   * answer it never got can tell that apart from `false`.
   */
  resolve(organizationId: string, now?: number): Promise<boolean | null>;
  /** Test seam: drop every memoized decision for this gate. */
  clear(): void;
};

/**
 * ISS-12552: the same memo for an organization-level (group) flag, keyed by
 * organization id. `evaluate` asks PostHog for one organization and resolves
 * `null` when it could not. Overrides and pinned snapshots are the caller's
 * to apply first, because they belong to the caller, not to the organization.
 */
export function createMemoizedOrganizationFeatureFlagGate(
  options: Omit<
    MemoizedFeatureFlagGateOptions,
    "sharedDecisionStore" | "sharedDecisionTtlMs"
  > & {
    evaluate: (organizationId: string) => Promise<boolean | null>;
  }
): MemoizedOrganizationFeatureFlagGate {
  const memo = createGateMemo(options, (identity) =>
    options.evaluate(identity.userId)
  );
  return {
    clear: memo.clear,
    resolve: (organizationId, now = Date.now()) =>
      memo.resolveMemoized({ userId: organizationId }, now),
  };
}

/**
 * The memo both gates share. Resolves `null` only for the fail-closed default,
 * the entry an unavailable evaluation writes when no decision is held anywhere.
 */
function createGateMemo(
  options: MemoizedFeatureFlagGateOptions,
  evaluate: (identity: FeatureFlagIdentity) => Promise<boolean | null>
): {
  clear(): void;
  resolveMemoized(
    identity: FeatureFlagIdentity,
    now: number
  ): Promise<boolean | null>;
} {
  /**
   * ISS-4556: the cap is the ONLY bound on this map, deliberately, and it is
   * enforced by {@link BoundedMap} at the single write point rather than on
   * the caller's success path — the UNAVAILABLE branch below inserts an entry
   * per viewer too, and that is the path which runs when PostHog cannot answer.
   * That is steady state, not just an outage: with no `NEXT_PUBLIC_POSTHOG_KEY`
   * the analytics stub exposes no `isFeatureEnabled`, and posthog-node resolves
   * `undefined` for a flag key that does not exist in the project yet — both
   * report UNAVAILABLE, so every viewer takes that branch for the whole window
   * before the flag is created, on a long-lived (Socket.IO) instance.
   *
   * ISS-4556: there was a companion expired-entry SWEEP, and it was removed
   * rather than fixed: it walked the WHOLE map, so any one viewer's successful
   * evaluation deleted every OTHER viewer's expired entry — destroying exactly
   * the fallback the UNAVAILABLE branch promises ("hold the last known
   * decision"), for every viewer except the one doing the sweeping. An expired
   * entry is not garbage here; it is the outage answer. `BoundedMap` evicts on
   * the cap alone and never on age, which is the behaviour this needs.
   */
  const decisions = new BoundedMap<string, GateDecision>(options.maxEntries);

  /**
   * ISS-7860: at most ONE evaluation in flight per viewer key.
   *
   * Without this the memo has a same-isolate race AT EXPIRY that produces the
   * exact inconsistency the memo exists to prevent. Two reads that both find
   * the entry expired both call PostHog. One comes back with a real `false` —
   * the rollout was genuinely turned off — and stores it. The other comes back
   * UNAVAILABLE and computes its fallback from the entry it read BEFORE its own
   * await, the stale `true`. That fallback then overwrites the authoritative
   * answer and is returned to its own caller, so the two responses of one page
   * load divide by different cost bases and the memo goes on serving the
   * discarded value for a whole backoff window. Ordering the writes is not
   * enough on its own: the two callers have already been handed different
   * answers by then.
   *
   * A follower therefore JOINS the leader's resolution rather than starting a
   * second one. Concurrent reads cannot diverge, and exactly one write happens
   * per evaluation. The follower inherits the leader's `now` for expiry, which
   * differs only by the width of a round trip already in progress.
   *
   * This map is not a cache and needs no cap: an entry exists only while its
   * resolution is in flight and is removed when it settles, so it is bounded by
   * concurrent requests rather than by viewers ever seen.
   */
  const inFlight = new Map<string, Promise<boolean | null>>();

  async function evaluateAndStore(
    cacheKey: string,
    identity: FeatureFlagIdentity,
    now: number
  ): Promise<boolean | null> {
    const evaluated = await evaluate(identity);

    if (evaluated !== null) {
      decisions.set(cacheKey, {
        value: evaluated,
        decidedAt: now,
        expiresAt: now + options.ttlMs,
        inherited: false,
      });
      // ISS-8126: published AFTER the memo is written and awaited before the
      // answer is returned. Awaited rather than fired and forgotten because a
      // dropped publish is silent — the decision still looks right to this
      // instance, and only a DIFFERENT instance later discovers there was
      // nothing to inherit. The cost is one upsert per viewer per TTL per
      // instance, not per request: the memo in front of this absorbs the rest.
      // A `false` is published too; the promise is that instances AGREE, not
      // that the gate is open.
      await options.sharedDecisionStore?.publish(options.flag.key, cacheKey, {
        value: evaluated,
        decidedAt: now,
      });
      return evaluated;
    }

    // Unavailable: hold the last known decision rather than silently reporting
    // OFF and splitting this viewer's page across two regimes. No prior
    // decision ANYWHERE means fail closed.
    //
    // Re-read rather than closing over the entry seen before the await, so the
    // fallback is the freshest decision ON RECORD. A `clear()` during the round
    // trip must not resurrect the local decision it just dropped — though with a
    // shared store a cleared gate can still inherit from the record, which is
    // the same inheritance a cold instance gets and exactly the point.
    const local = decisions.get(cacheKey);
    const candidates: FallbackCandidate[] = [];
    // An INHERITED local copy is admitted only while the record it came from
    // would still be honored. Skipping this check is what turned an adopted
    // decision into a fallback with no expiry at all.
    if (
      local &&
      local.decidedAt !== null &&
      !isExpiredInheritance(local, now)
    ) {
      candidates.push({
        value: local.value,
        decidedAt: local.decidedAt,
        origin: local.inherited ? "shared" : "local",
      });
    }
    const shared = await readSharedDecision(cacheKey, now);
    if (shared) {
      candidates.push({ ...shared, origin: "shared" });
    }
    const fallback = freshest(candidates);

    // Re-arm on the SHORT backoff instead of returning without touching the
    // entry. Leaving `expiresAt` in the past meant every subsequent read
    // re-issued a blocking PostHog call against a service already known to be
    // failing, and gave the outage no negative caching at all. Re-arming also
    // keeps the fallback ALIVE for its own viewer.
    //
    // `decidedAt` carries the fallback's OWN evaluation time, so an inherited
    // decision does not age-reset by being adopted, and the fail-closed default
    // stays marked as not-a-decision.
    decisions.set(cacheKey, {
      value: fallback?.value ?? false,
      decidedAt: fallback?.decidedAt ?? null,
      expiresAt: reArmExpiresAt(fallback, now),
      // Sticky: an inherited decision that this instance re-arms stays marked
      // inherited, so the window below keeps being measured against the
      // ORIGINAL evaluation rather than being reset by the act of holding it.
      inherited: fallback?.origin === "shared",
    });
    return fallback?.value ?? null;
  }

  /**
   * When a re-armed entry stops being served from {@link resolve}'s cached read.
   *
   * An INHERITED value is clipped to the end of the window its record has, so an
   * adopted decision can never be HANDED BACK past
   * `decidedAt + sharedDecisionTtlMs`. {@link isExpiredInheritance} alone does
   * not give that: it bounds which candidate may be ADOPTED, and the cached-read
   * fast path returns before it is ever consulted — so the last re-arm before
   * the window closed stayed live for a whole `unavailableBackoffMs` beyond it.
   * Clipping at write time keeps the hot read branch-free.
   *
   * A locally EVALUATED fallback is never clipped: holding your own last-known
   * answer through an outage is ISS-7860's contract and this does not touch it.
   */
  function reArmExpiresAt(
    fallback: FallbackCandidate | null,
    now: number
  ): number {
    const backoffExpiry = now + options.unavailableBackoffMs;
    const windowMs = options.sharedDecisionTtlMs;
    if (fallback?.origin !== "shared" || windowMs === undefined) {
      return backoffExpiry;
    }
    return Math.min(backoffExpiry, fallback.decidedAt + windowMs);
  }

  /**
   * Whether an adopted decision has outlived the window its record would have.
   *
   * Only ever true for an INHERITED entry: this is the same window
   * {@link readSharedDecision} applies to the row itself, applied to the copy
   * an earlier unavailable lookup wrote into this instance's memo. Without a
   * configured window nothing can be inherited, so the guard is inert.
   */
  function isExpiredInheritance(entry: GateDecision, now: number): boolean {
    const windowMs = options.sharedDecisionTtlMs;
    return (
      entry.inherited &&
      entry.decidedAt !== null &&
      windowMs !== undefined &&
      now - entry.decidedAt > windowMs
    );
  }

  /**
   * The stored decision for this viewer, if there is one and it is still inside
   * the stability window.
   *
   * A record older than the window is history rather than a decision: honoring
   * it forever would let a viewer removed from the rollout keep the feature for
   * as long as PostHog stayed unreachable.
   */
  async function readSharedDecision(
    cacheKey: string,
    now: number
  ): Promise<SharedFlagDecision | null> {
    const store = options.sharedDecisionStore;
    const windowMs = options.sharedDecisionTtlMs;
    if (!(store && windowMs)) {
      return null;
    }
    const stored = await store.read(options.flag.key, cacheKey);
    if (!stored || now - stored.decidedAt > windowMs) {
      return null;
    }
    return stored;
  }

  return {
    clear() {
      decisions.clear();
    },
    resolveMemoized,
  };

  // Deliberately NOT `async`: the in-flight registration below must happen in
  // the same synchronous turn as the promise it registers, and an `async`
  // wrapper here would only add a suspension point between them.
  function resolveMemoized(
    identity: FeatureFlagIdentity,
    now: number
  ): Promise<boolean | null> {
    const cacheKey = buildGateCacheKey(identity);
    const cached = decisions.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return Promise.resolve(cached.decidedAt === null ? null : cached.value);
    }

    const pending = inFlight.get(cacheKey);
    if (pending) {
      return pending;
    }

    // Registered before the first suspension point, so no concurrent caller
    // can observe an absent entry for a key already being resolved.
    const resolution = evaluateAndStore(cacheKey, identity, now).finally(() => {
      inFlight.delete(cacheKey);
    });
    inFlight.set(cacheKey, resolution);
    return resolution;
  }
}

/**
 * The memo key for a request principal.
 *
 * ISS-4556: `JSON.stringify` over the id LIST, not `join("|")`. A
 * separator-joined key is ambiguous — a principal whose id happens to contain
 * the separator can collide with a different principal's two-id key, and
 * inheriting another viewer's cached decision means a dark-launched feature
 * served to someone PostHog never enabled it for. Encoding the array makes the
 * key injective at zero cost.
 */
function buildGateCacheKey(identity: FeatureFlagIdentity): string {
  return JSON.stringify(resolveDistinctIdsForIdentity(identity));
}

/**
 * The most recently EVALUATED of the fallback candidates, or `null` when there
 * are none. An exact tie goes to the SHARED record.
 *
 * The tie-break is a total order, deliberately, and it is not the no-op it looks
 * like. This once kept the earlier candidate — the local one by construction —
 * on the reasoning that two decisions made in the same millisecond are the same
 * decision. They need not be: two instances can evaluate one viewer either side
 * of a rollout flip within the same millisecond and reach OPPOSITE verdicts, and
 * the conditional upsert (`decided_at <= EXCLUDED.decided_at`) accepts whichever
 * of those equal-timestamp writes lands last. Each instance preferring its own
 * copy on the tie would leave them disagreeing while reading one row, for the
 * whole outage, which is precisely the split the shared record exists to close.
 *
 * The stored row is the canonical side because it is the one both instances can
 * see: preferring it makes them converge on the same value whatever order those
 * two writes landed in.
 */
function freshest(
  candidates: readonly FallbackCandidate[]
): FallbackCandidate | null {
  let winner: FallbackCandidate | null = null;
  for (const candidate of candidates) {
    if (winner === null || outranks(candidate, winner)) {
      winner = candidate;
    }
  }
  return winner;
}

/** Strictly fresher, or equally fresh and canonical. */
function outranks(
  candidate: FallbackCandidate,
  winner: FallbackCandidate
): boolean {
  if (candidate.decidedAt !== winner.decidedAt) {
    return candidate.decidedAt > winner.decidedAt;
  }
  return candidate.origin === "shared" && winner.origin === "local";
}
