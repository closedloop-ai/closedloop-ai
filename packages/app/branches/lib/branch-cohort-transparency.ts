import type { BranchLastActiveCohort } from "@repo/api/src/types/branch-list-cohort";
import {
  BranchListCohortScope,
  branchLastActiveCohortSchema,
} from "@repo/api/src/types/branch-list-cohort";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import type { BranchRow } from "./branch-row";

export const BranchCohortNoticeKind = {
  Hidden: "hidden",
  Complete: "complete",
  Partial: "partial",
  Unavailable: "unavailable",
  Updating: "updating",
  UpdateFailed: "update_failed",
} as const;
export type BranchCohortNoticeKind =
  (typeof BranchCohortNoticeKind)[keyof typeof BranchCohortNoticeKind];

export type BranchCohortNoticeModel =
  | {
      kind:
        | typeof BranchCohortNoticeKind.Hidden
        | typeof BranchCohortNoticeKind.Unavailable
        | typeof BranchCohortNoticeKind.Updating
        | typeof BranchCohortNoticeKind.UpdateFailed;
      total: number;
    }
  | {
      kind: typeof BranchCohortNoticeKind.Complete;
      total: number;
      knownInWindow: number;
      retainedUnavailable: number;
    }
  | {
      kind: typeof BranchCohortNoticeKind.Partial;
      total: number;
      retainedUnavailable: number;
    };

/** Resolve truthful finite-window copy from the rendered cohort and envelope. */
export function resolveBranchCohortNotice(input: {
  rows: readonly BranchRow[];
  total: number;
  /**
   * `branchListCohortKey` of the filter set this list is rendering. Producers
   * stamp the same key on the cohort they emit, so it is the only field that
   * names WHICH request a cohort answered — required so a caller cannot read
   * another request's counts by forgetting to say which one it is showing.
   */
  cohortKey: string;
  hasData: boolean;
  hasFiniteWindow: boolean;
  isPlaceholderData: boolean;
  placeholderFailed: boolean;
  completeCorpus: boolean;
  /**
   * The instant the rendered rows are judged against. Supply the producer's own
   * clock (`resolveBranchCohortEvaluationNow`); the local clock is only the
   * last-resort fallback, because the notice reports a property of the DATA and
   * a viewer's browser clock must not decide whether it renders.
   */
  renderNow?: string | number | Date;
  producerCohort?: unknown;
}): BranchCohortNoticeModel {
  if (!(input.hasData && input.hasFiniteWindow)) {
    return { kind: BranchCohortNoticeKind.Hidden, total: input.total };
  }
  if (input.isPlaceholderData) {
    return {
      kind: input.placeholderFailed
        ? BranchCohortNoticeKind.UpdateFailed
        : BranchCohortNoticeKind.Updating,
      total: input.total,
    };
  }
  if (input.completeCorpus) {
    const retainedUnavailable = countUnavailableRows(
      input.rows,
      input.renderNow ?? Date.now()
    );
    if (retainedUnavailable === 0) {
      return { kind: BranchCohortNoticeKind.Hidden, total: input.total };
    }
    return {
      kind: BranchCohortNoticeKind.Complete,
      total: input.total,
      knownInWindow: input.total - retainedUnavailable,
      retainedUnavailable,
    };
  }
  const parsed = branchLastActiveCohortSchema.safeParse(input.producerCohort);
  if (parsed.success) {
    const resolved = noticeFromProducer(
      parsed.data,
      input.total,
      input.cohortKey
    );
    if (resolved) {
      return resolved;
    }
  }
  const visibleUnavailable = countUnavailableRows(
    input.rows,
    input.renderNow ?? Date.now()
  );
  if (visibleUnavailable > 0) {
    return {
      kind: BranchCohortNoticeKind.Partial,
      total: input.total,
      retainedUnavailable: visibleUnavailable,
    };
  }
  return { kind: BranchCohortNoticeKind.Unavailable, total: input.total };
}

/**
 * Resolve one response-stable clock without trusting a window's end-of-day.
 *
 * Precedence is server-authoritative: the cohort's own evaluation instant, then
 * the envelope's `pageInfo.now` — a sibling optional field carrying the same
 * instant — and only then the local clock. ISS-10350 retired the clock as a
 * REQUEST parameter; both of these are fields the producer still stamps on the
 * RESPONSE, so they remain the authority for presentation. A viewer whose system
 * clock trails the API's would otherwise see a genuinely recent `lastActivityAt`
 * land in its own future and be dropped as invalid — rendered as an em-dash and
 * excluded from the last-active facets, which is a measurement nobody made.
 */
export function resolveBranchCohortEvaluationNow(
  producerNow: string | undefined,
  responseNow?: string,
  fallbackNow: number = Date.now()
): number {
  return instantMs(producerNow) ?? instantMs(responseNow) ?? fallbackNow;
}

function noticeFromProducer(
  cohort: BranchLastActiveCohort,
  total: number,
  cohortKey: string
): BranchCohortNoticeModel | null {
  // A cohort that counted a differently-sized population than the list reports
  // is not describing this list, whatever else it says. No caller reaches here
  // with that divergence today: the complete-list path returns `hasMore: false`
  // with `items.length === total`, so `completeCorpus` short-circuits above,
  // and on the server-page path `total` IS `data.total` — the number the
  // producer counted. This is the reject-by-default floor if that stops
  // holding, not a branch either path takes.
  if (cohort.total !== total) {
    return null;
  }
  // `scope` names the KIND of corpus a producer counted, never WHICH request it
  // answered — two filter sets can select equally-sized corpora, so an equal
  // `total` does not make a cohort this list's. `cohortKey` is the request's own
  // identity, so a stale or reordered response is rejected here rather than
  // renaming another population's counts as this one's.
  if (cohort.cohortKey !== cohortKey) {
    return null;
  }
  // ISS-7125: both producers emit `RequestFilters` — counts taken over the
  // corpus the request's own filters select, which is the population `total`
  // reports. `AllActiveFacets` ignores those facets, so its counts would not
  // describe this list and stay rejected.
  if (cohort.scope !== BranchListCohortScope.RequestFilters) {
    return null;
  }
  if (
    cohort.knownInWindow.state !== BranchMetricAvailability.Complete ||
    cohort.retainedUnavailable.state !== BranchMetricAvailability.Complete
  ) {
    return { kind: BranchCohortNoticeKind.Unavailable, total };
  }
  if (cohort.retainedUnavailable.value === 0) {
    return { kind: BranchCohortNoticeKind.Hidden, total };
  }
  return {
    kind: BranchCohortNoticeKind.Complete,
    total,
    knownInWindow: cohort.knownInWindow.value,
    retainedUnavailable: cohort.retainedUnavailable.value,
  };
}

function countUnavailableRows(
  rows: readonly BranchRow[],
  renderNow: string | number | Date
): number {
  const now = instantMs(renderNow);
  return rows.filter((row) => {
    const occurredAt = instantMs(row.lastActivityAt);
    return occurredAt === null || now === null || occurredAt > now;
  }).length;
}

function instantMs(value: string | number | Date | undefined): number | null {
  if (value === undefined || value === "") {
    return null;
  }
  let parsed: number;
  if (value instanceof Date) {
    parsed = value.getTime();
  } else if (typeof value === "number") {
    parsed = value;
  } else {
    parsed = Date.parse(value);
  }
  return Number.isFinite(parsed) ? parsed : null;
}
