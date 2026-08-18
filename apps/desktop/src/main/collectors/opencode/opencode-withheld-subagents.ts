/**
 * @file opencode-withheld-subagents.ts
 * @description ISS-5266: turn the OpenCode subagent WITHHOLD from a log line into
 * a durable, countable record, so the resulting under-count stops reading as a
 * true zero.
 *
 * ISS-5238 (F2) made `reemitOrphanedChildren` withhold a dropped root's children
 * instead of re-emitting them at top level, and PR #4440 extended that withhold
 * to the transcript materializer. Both are right about the session GRAPH — a
 * subagent presented as its own root is a lie about the hierarchy — but they left
 * a METRIC gap. When an OpenCode root row is malformed on the FIRST import its
 * children never land at all, `markSourceImported` advances the DB fingerprint,
 * and the spend those children carry silently vanishes from every roll-up. The
 * only signal was the monitored `collector opencode import failed: withheld N …`
 * line, which no user ever sees.
 *
 * Three states must stay distinguishable, and this record is what keeps them so:
 *
 * - **complete** — no withheld record for the store. A root whose `subagents` is
 *   empty genuinely HAD no subagents; its zero is a real zero and stays one.
 * - **incomplete by N** — a withheld record naming the root, how many children
 *   were withheld, and (because the CHILDREN parsed fine — only the root did not)
 *   exactly how much spend is missing and over what window.
 * - **unknown** — the store has not been imported yet. Owned by the pre-existing
 *   ingest-progress surface, not by this record; a store with no withheld rows is
 *   only "complete" once it has actually been imported.
 *
 * `withheldTokens` is the load-bearing part. The withheld children are fully
 * parsed sessions, so the size of the under-count is KNOWN, not merely suspected
 * — this is the one place the metric gap can be quantified rather than gestured
 * at. It is reported on the SAME basis as the total it is quoted against
 * (`dashboard-queries.ts` builds the headline total as input + output only), with
 * cache tokens carried in a separate `withheldCacheTokens` so neither figure has
 * to be reconciled against a basis it was not measured on. Either can be `null`,
 * meaning UNAVAILABLE, when the aggregate leaves the JS-safe integer range.
 *
 * `earliestChildStartedAt` / `latestChildEndedAt` bound the affected window so a
 * period-scoped total can say WHICH period is incomplete, and `windowPartial`
 * says whether those bounds are the exact extent or merely a lower bound,
 * because a child carrying no instants is skipped rather than widening them.
 *
 * NOTE ON REVISITS: steady state never rescans. A withhold is caused by an
 * {@link OpencodeParseFailureKind.MalformedRow}, which
 * `opencode-parse-failure.ts` defines as failing "identically on every tick" — so
 * re-reading unchanged bytes re-derives an identical withhold and buys nothing.
 * What was actually missing is DURABILITY of the last verdict, which this record
 * supplies. When the bytes DO move the fingerprint gate re-parses and the store's
 * record set is reconciled wholesale, so a root that starts parsing again drops
 * its record rather than leaving a stale claim behind.
 *
 * There is exactly ONE exception, and it is the upgrade path (ISS-5266, wongk
 * review). An install that ran a pre-ISS-5266 release has an unchanged store, a
 * matching persisted fingerprint, and therefore no verdict — and no way to ever
 * acquire one, because the fingerprint gate suppresses the read that would
 * produce it. So a store with no recorded scan re-reads ONCE, on the first
 * launch after upgrade (see `hasRecordedWithheldScan` in `opencode-collector.ts`),
 * and converges the moment that scan commits. Without it every existing install
 * would upgrade into a permanently empty table whose emptiness reads as the
 * "nothing is withheld" claim this file exists to stop the product making.
 */
import { addStorageTokenCounts } from "../../cost/token-counts.js";
import type { NormalizedSession } from "../types.js";

/** One dropped OpenCode root and the subagent subtree withheld beneath it. */
export type OpencodeWithheldSubagentRoot = {
  /** The RAW opencode session id of the root that could not be parsed. */
  rootRawId: string;
  /** How many subagent sessions were withheld under it. Always >= 1. */
  withheldCount: number;
  /** Why the root row was dropped (`OpencodeDroppedSession.reason`). */
  reason: string;
  /**
   * BILLABLE tokens (input + output) across the withheld children.
   *
   * Deliberately the SAME basis as the desktop's headline token total, which
   * `dashboard-queries.ts` builds as `SUM(input_tokens) + SUM(output_tokens)`
   * with the cache columns left out. This number is quoted to the reader as the
   * amount that total is short by, so it has to be measured the way that total
   * is measured; folding cache in here would print a shortfall that cannot be
   * reconciled against the figure it references.
   *
   * `null` means UNAVAILABLE, not zero: the sum left the JS-safe integer range,
   * so the exact size of the hole is no longer known. An unavailable size is a
   * far smaller lie than a silently-rounded one.
   */
  withheldTokens: number | null;
  /**
   * CACHE tokens (cacheRead + cacheWrite) across the withheld children, carried
   * separately so the tab can say which basis is short by how much rather than
   * mixing two into one unreconcilable figure. `null` is UNAVAILABLE, as above.
   */
  withheldCacheTokens: number | null;
  /** Earliest `startedAt` across the withheld children, or null if none had one. */
  earliestChildStartedAt: string | null;
  /** Latest `endedAt` across the withheld children, or null if none had one. */
  latestChildEndedAt: string | null;
  /**
   * True when at least one withheld child carried no `startedAt` or no
   * `endedAt`, so the bounds above are a LOWER BOUND on the affected window
   * rather than its exact extent.
   *
   * Without this, skipping a child that has no instants makes the surviving
   * children's window look exact, and a period-scoped total would be declared
   * incomplete over a narrower span than the one actually affected.
   */
  windowPartial: boolean;
};

/**
 * Everything one batch load withheld, for one OpenCode store.
 *
 * The report is COMPLETE for its `sourcePath`: OpenCode is a batch harness that
 * reads the whole DB in one pass, so an empty `roots` is a positive statement
 * ("this store withheld nothing this load"), not an absence of information. That
 * is what lets the persistence layer reconcile by deleting rows the current load
 * no longer names, instead of accumulating stale claims forever.
 */
export type OpencodeWithheldSubagentReport = {
  /** Absolute path of the `opencode.db` this load read. */
  sourcePath: string;
  roots: OpencodeWithheldSubagentRoot[];
};

/** Field labels handed to the checked adder, for its error messages. */
const BILLABLE_FIELD = "opencodeWithheldSubagents.withheldTokens";
const CACHE_FIELD = "opencodeWithheldSubagents.withheldCacheTokens";

/**
 * Add one counter to a running total through the shared checked helper, with
 * UNAVAILABLE (`null`) as an absorbing state.
 *
 * `addStorageTokenCounts` THROWS when a total leaves the JS-safe integer range.
 * Throwing is right for a storage write, but here it would fail the whole import
 * over an aggregate the reader never asked to be exact — so the overflow is
 * caught and turned into "unavailable", which is what the surface then renders.
 * Once unavailable, always unavailable: no later child can restore a total whose
 * precision is already gone.
 */
function addChecked(
  current: number | null,
  delta: number,
  field: string
): number | null {
  if (current === null) {
    return null;
  }
  try {
    return addStorageTokenCounts(current, delta, field);
  } catch {
    return null;
  }
}

/** One session's tokens, split on the two bases the surface reports separately. */
type SessionTokenSplit = {
  billable: number | null;
  cache: number | null;
};

/** Sum one session's per-model counts into the billable/cache split. */
function splitSessionTokens(session: NormalizedSession): SessionTokenSplit {
  let billable: number | null = 0;
  let cache: number | null = 0;
  for (const counts of Object.values(session.tokensByModel)) {
    billable = addChecked(billable, counts.input, BILLABLE_FIELD);
    billable = addChecked(billable, counts.output, BILLABLE_FIELD);
    cache = addChecked(cache, counts.cacheRead, CACHE_FIELD);
    cache = addChecked(cache, counts.cacheWrite, CACHE_FIELD);
  }
  return { billable, cache };
}

/** The earlier of an accumulated instant (possibly absent) and a present one. */
function earlier(current: string | null, candidate: string): string {
  if (current === null) {
    return candidate;
  }
  return candidate < current ? candidate : current;
}

/** The later of an accumulated instant (possibly absent) and a present one. */
function later(current: string | null, candidate: string): string {
  if (current === null) {
    return candidate;
  }
  return candidate > current ? candidate : current;
}

/**
 * Build the durable record for ONE withheld subtree.
 *
 * `children` is the withheld population itself, so `withheldCount` is its length
 * rather than a separately-tracked tally — a counter that can drift from the set
 * it describes is exactly the shape this ticket exists to remove.
 */
export function buildWithheldSubagentRoot(
  rootRawId: string,
  reason: string,
  children: readonly NormalizedSession[]
): OpencodeWithheldSubagentRoot {
  let withheldTokens: number | null = 0;
  let withheldCacheTokens: number | null = 0;
  let earliestChildStartedAt: string | null = null;
  let latestChildEndedAt: string | null = null;
  let windowPartial = false;
  for (const child of children) {
    const split = splitSessionTokens(child);
    withheldTokens =
      split.billable === null
        ? null
        : addChecked(withheldTokens, split.billable, BILLABLE_FIELD);
    withheldCacheTokens =
      split.cache === null
        ? null
        : addChecked(withheldCacheTokens, split.cache, CACHE_FIELD);
    if (child.startedAt) {
      earliestChildStartedAt = earlier(earliestChildStartedAt, child.startedAt);
    } else {
      windowPartial = true;
    }
    if (child.endedAt) {
      latestChildEndedAt = later(latestChildEndedAt, child.endedAt);
    } else {
      windowPartial = true;
    }
  }
  return {
    rootRawId,
    withheldCount: children.length,
    reason,
    withheldTokens,
    withheldCacheTokens,
    earliestChildStartedAt,
    latestChildEndedAt,
    windowPartial,
  };
}
