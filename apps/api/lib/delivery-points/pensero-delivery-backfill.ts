/**
 * The Pensero delivery backfill (ISS-8399): plan → fetch → join → match →
 * attach, over a segmented, throttled date-range lookback.
 *
 * TWO PHASES, and the split is load-bearing rather than tidiness. A `creator`
 * row carries the large point values and NO pull-request number; it can only
 * get one from a sibling `pull_request_review` row sharing its interaction id —
 * and that sibling may land in a DIFFERENT window. So every segment is fetched
 * and folded into one interaction index first, and only then is anything
 * matched. Matching per segment as it arrives would leave a creator row
 * permanently unresolved purely because its reviewer reviewed on a Monday.
 *
 * WHAT THIS RUN CANNOT TELL YOU, and says so rather than implying otherwise:
 * the delivery endpoint returns no `hasMore`, no cursor and no total, so a
 * segment that came back short is indistinguishable from a quiet period. The
 * report carries that as `completeness`, and it is never `complete`.
 */

import type { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import { NumeratorProvider as NumeratorProviderValues } from "@repo/api/src/types/numerator-provider";
import { DeliveryMatchOutcome } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  type FetchedDeliverySegment,
  fetchDeliverySegment,
  type PenseroRequestCredential,
  SegmentCompleteness,
} from "@repo/pensero/delivery-client";
import {
  type PenseroDeliveryRow,
  PenseroInteractionKind,
} from "@repo/pensero/delivery-contract";
import {
  buildInteractionIndex,
  type InteractionIndex,
  mergeInteractionIndexes,
  PullRequestResolution,
  resolveDeliveryRows,
} from "@repo/pensero/delivery-interaction-join";
import {
  type BackfillSegment,
  DEFAULT_SEGMENT_THROTTLE_MS,
  isPlanTruncated,
  planBackfillSegments,
} from "./backfill-plan";
import { matchDeliveryRows } from "./delivery-point-matcher";
import {
  type DeliveryPointWrite,
  persistDeliveryPoints,
} from "./delivery-point-store";
import { toNormalizedDeliveryPoint } from "./pensero-delivery-adapter";
import { readStoredInteractionIndex } from "./stored-interaction-index";

/** One segment that could not be fetched, and why — never silently skipped. */
export type FailedSegment = {
  readonly segment: BackfillSegment;
  readonly error: string;
};

/**
 * What one backfill run did and, as importantly, what it could not establish.
 *
 * The four match-outcome counts are reported SEPARATELY and never summed into a
 * single "unmatched" figure: "we have no such pull request", "we could not
 * arbitrate between two", and "the feed never gave us a number" are three
 * different problems with three different fixes.
 */
export type DeliveryBackfillReport = {
  readonly organizationId: string;
  readonly providerId: NumeratorProvider;
  readonly segmentsPlanned: number;
  readonly segmentsFetched: number;
  readonly segmentsFailed: readonly FailedSegment[];
  /** True when `maxSegments` cut the plan short of the requested lookback. */
  readonly planTruncated: boolean;
  readonly rowsExtracted: number;
  readonly rowsRejected: number;
  /**
   * Person envelopes the boundary schema refused. Counted apart from
   * `rowsRejected` (which counts ROWS) because a malformed person hides a
   * number of rows that is only sometimes readable.
   */
  readonly peopleRejected: number;
  /**
   * Interactions whose pull request came from rows an EARLIER run stored rather
   * than from this run's feed. A non-zero here is the carry-forward working: it
   * is how a creator row keeps the number its reviewer supplied in a window this
   * run never asked for.
   */
  readonly interactionsSeededFromStore: number;
  /** People present in the feed whose email matched no user in this org. */
  readonly peopleUnbridged: number;
  readonly resolutionCounts: Record<PullRequestResolution, number>;
  readonly outcomeCounts: Record<DeliveryMatchOutcome, number>;
  readonly rowsWritten: number;
  readonly artifactAssociationsWritten: number;
  /**
   * The WEAKEST completeness across every fetched segment. Never `complete` —
   * see the module docstring. A `truncation_signalled` here means the provider
   * grew pagination this client does not follow, and the run is known partial.
   */
  readonly completeness: SegmentCompleteness;
};

export type DeliveryBackfillOptions = {
  readonly organizationId: string;
  /**
   * Provider-specific team narrowing for THIS organization, or absent for none
   * (ISS-8761). Absent omits the provider's `team_identifiers` parameter and
   * accepts its all-teams response — see `FetchDeliveryOptions`.
   */
  readonly teamIdentifiers?: readonly string[];
  /**
   * The organization's resolved Pensero credential, supplied by the caller for
   * the life of this run and never stored. Absent falls back to the
   * deployment-wide env credential, which is the single-tenant path.
   */
  readonly credential?: PenseroRequestCredential;
  readonly endDate: Date;
  readonly lookbackDays: number;
  readonly segmentDays: number;
  readonly maxSegments?: number;
  readonly throttleMs?: number;
  readonly signal?: AbortSignal;
  /** Injected in tests so no timer, provider or clock is exercised for real. */
  readonly fetchSegment?: (
    segment: BackfillSegment
  ) => Promise<FetchedDeliverySegment>;
  readonly sleep?: (ms: number) => Promise<void>;
};

/**
 * Run one Pensero delivery backfill for an organization.
 *
 * A failed segment does NOT abort the run: the remaining segments still carry
 * value, and the failure is reported so the caller can see exactly which window
 * is missing rather than inferring a quiet period from a hole.
 */
export async function runPenseroDeliveryBackfill(
  options: DeliveryBackfillOptions
): Promise<DeliveryBackfillReport> {
  const providerId: NumeratorProvider = NumeratorProviderValues.Pensero;
  const planInput = {
    endDate: options.endDate,
    lookbackDays: options.lookbackDays,
    segmentDays: options.segmentDays,
    maxSegments: options.maxSegments,
  };
  const segments = planBackfillSegments(planInput);
  const throttleMs = Math.max(
    0,
    options.throttleMs ?? DEFAULT_SEGMENT_THROTTLE_MS
  );
  const sleep = options.sleep ?? defaultSleep;
  const fetchSegment =
    options.fetchSegment ??
    ((segment: BackfillSegment) =>
      fetchDeliverySegment({
        startDate: segment.startDate,
        endDate: segment.endDate,
        teamIdentifiers: options.teamIdentifiers,
        credential: options.credential,
        signal: options.signal,
      }));

  const rows: PenseroDeliveryRow[] = [];
  const segmentsFailed: FailedSegment[] = [];
  let segmentsFetched = 0;
  let rowsRejected = 0;
  let peopleRejected = 0;
  let completeness: SegmentCompleteness = SegmentCompleteness.Unverified;
  let fetchedIndex: InteractionIndex = new Map();

  for (const [position, segment] of segments.entries()) {
    if (position > 0 && throttleMs > 0) {
      await sleep(throttleMs);
    }
    try {
      const fetched = await fetchSegment(segment);
      segmentsFetched += 1;
      rows.push(...fetched.segment.rows);
      rowsRejected += fetched.segment.rowsRejected.length;
      peopleRejected += fetched.segment.peopleRejected;
      fetchedIndex = buildInteractionIndex(fetched.segment.rows, fetchedIndex);
      if (fetched.completeness === SegmentCompleteness.TruncationSignalled) {
        completeness = SegmentCompleteness.TruncationSignalled;
      }
    } catch (error) {
      segmentsFailed.push({ segment, error: parseError(error) });
      log.error("[pensero/backfill] Segment fetch failed", {
        organizationId: options.organizationId,
        startDate: segment.startDate,
        endDate: segment.endDate,
        error: parseError(error),
      });
    }
  }

  // Rows this run fetched are not the only evidence about an interaction: a
  // previous run may already have resolved one, and that answer is stored on
  // the row it resolved. Without seeding, a creator row whose reviewer landed
  // in a window this run did not fetch is re-derived as unresolved and — since
  // the upsert restates every column — OVERWRITES its own stored match.
  const storedIndex = await readStoredInteractionIndex(
    options.organizationId,
    providerId,
    pullRequestInteractionIds(rows)
  );
  const index = mergeInteractionIndexes(storedIndex, fetchedIndex);
  const resolved = resolveDeliveryRows(rows, index);
  const { targetsByItemId, userIdByEmail } = await matchDeliveryRows(
    options.organizationId,
    resolved
  );

  const writes: DeliveryPointWrite[] = [];
  for (const entry of resolved) {
    const target = targetsByItemId.get(entry.row.itemId);
    if (!target) {
      continue;
    }
    writes.push({
      // The Pensero vocabulary stops here: everything downstream sees the
      // neutral record, which is what makes a second provider an additional
      // adapter rather than an edit to the persistence code.
      point: toNormalizedDeliveryPoint(entry),
      target,
      userId: userIdByEmail.get(entry.row.person.email) ?? null,
    });
  }

  const persisted = await persistDeliveryPoints(
    options.organizationId,
    providerId,
    writes
  );

  return {
    organizationId: options.organizationId,
    providerId,
    segmentsPlanned: segments.length,
    segmentsFetched,
    segmentsFailed,
    planTruncated: isPlanTruncated(planInput, segments),
    rowsExtracted: rows.length,
    rowsRejected,
    peopleRejected,
    interactionsSeededFromStore: storedIndex.size,
    peopleUnbridged: countUnbridged(userIdByEmail),
    resolutionCounts: countResolutions(resolved),
    outcomeCounts: countOutcomes(writes),
    rowsWritten: persisted.rowsWritten,
    artifactAssociationsWritten: persisted.artifactAssociationsWritten,
    completeness,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function countUnbridged(userIdByEmail: ReadonlyMap<string, string | null>) {
  let unbridged = 0;
  for (const userId of userIdByEmail.values()) {
    if (!userId) {
      unbridged += 1;
    }
  }
  return unbridged;
}

/**
 * Tally resolutions over EVERY member of the closed set, initialized to zero.
 * A member absent from the tally would be indistinguishable from a member that
 * genuinely occurred zero times, and only one of those is a real measurement.
 */
function countResolutions(
  resolved: readonly { resolution: PullRequestResolution }[]
): Record<PullRequestResolution, number> {
  const counts = {
    [PullRequestResolution.Direct]: 0,
    [PullRequestResolution.Interaction]: 0,
    [PullRequestResolution.NoInteraction]: 0,
    [PullRequestResolution.NoCounterpart]: 0,
    [PullRequestResolution.Ambiguous]: 0,
  };
  for (const entry of resolved) {
    counts[entry.resolution] += 1;
  }
  return counts;
}

/** Tally match outcomes over every member of the closed set. See above. */
function countOutcomes(
  writes: readonly DeliveryPointWrite[]
): Record<DeliveryMatchOutcome, number> {
  const counts = {
    [DeliveryMatchOutcome.MATCHED]: 0,
    [DeliveryMatchOutcome.NO_COUNTERPART]: 0,
    [DeliveryMatchOutcome.AMBIGUOUS]: 0,
    [DeliveryMatchOutcome.UNMATCHABLE]: 0,
    [DeliveryMatchOutcome.PENDING_REFERENCE]: 0,
  };
  for (const write of writes) {
    counts[write.target.outcome] += 1;
  }
  return counts;
}

/**
 * The pull-request interaction ids this run's rows name — the exact key set the
 * stored-index seed has to cover, so the read is bounded by the batch.
 */
function pullRequestInteractionIds(
  rows: readonly PenseroDeliveryRow[]
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.interaction?.kind === PenseroInteractionKind.PullRequest) {
      ids.add(row.interaction.id);
    }
  }
  return [...ids];
}
