/**
 * ISS-8554 / PLN-1853 Phase 3 (revision 12) — the list-sort shadow comparison.
 *
 * Same three properties `usage-summary-shadow.ts` holds itself to, for the
 * same reasons (see that module's header): this cannot change the response,
 * cannot fail the request, and cannot slow the response. The route hands this
 * function's returned promise to `waitUntil` rather than awaiting it.
 */

import { log } from "@repo/observability/log";
import type { AgentSessionSortRule } from "../validators";
import type { SessionListInput } from "./records";
import {
  describeSessionListSortDivergence,
  diffSessionListSortPage,
  type ListSortDiffVerdict,
  type ListSortPageRow,
} from "./session-list-sort-differ";
import {
  readSessionListPageByCompoundSort,
  readSessionListPageByDuration,
  readSessionListPageByUpdated,
  readSessionListPageByUser,
  type SqlNativeSingleSortRequest,
} from "./session-list-sql-reader";

/** Structured-log event for a completed comparison. */
export const LIST_SQL_SORT_SHADOW_EVENT = "sessions_list_sql_sort_shadow";
/** Structured-log event for a candidate that threw. */
export const LIST_SQL_SORT_SHADOW_FAILED_EVENT =
  "sessions_list_sql_sort_shadow_failed";

function readCandidate(
  input: SessionListInput,
  request: SqlNativeSingleSortRequest,
  offset: number,
  limit: number
): Promise<ListSortPageRow[]> {
  switch (request.column) {
    case "updated":
      return readSessionListPageByUpdated(input, request.dir, offset, limit);
    case "user":
      return readSessionListPageByUser(input, request.dir, offset, limit);
    case "duration":
      return readSessionListPageByDuration(input, request.dir, offset, limit);
    default: {
      const exhaustive: never = request.column;
      return exhaustive;
    }
  }
}

/**
 * Run the candidate ordering, diff it against the live page already served,
 * and log the verdict. Returns its promise so the route can hand it to
 * `waitUntil` — the reader still does not wait; the instance is kept alive
 * until the comparison finishes (same reasoning as the usage-summary shadow:
 * a floated promise would drop the SLOWEST comparisons, which is what a
 * misbehaving candidate looks like).
 *
 * `livePage` carries the served page's `updated` keys alongside its ids, so a
 * `clean:false` verdict can be attributed rather than only counted — see
 * {@link describeSessionListSortDivergence}.
 */
export function shadowSessionListSort(
  input: SessionListInput,
  request: SqlNativeSingleSortRequest,
  offset: number,
  limit: number,
  livePage: readonly ListSortPageRow[]
): Promise<void> {
  return shadowListSortCandidate(
    { column: request.column, dir: request.dir },
    () => readCandidate(input, request, offset, limit),
    livePage
  );
}

export function shadowSessionListCompoundSort(
  input: SessionListInput,
  rules: readonly AgentSessionSortRule[],
  offset: number,
  limit: number,
  livePage: readonly ListSortPageRow[]
): Promise<void> {
  return shadowListSortCandidate(
    { rules: rules.map((rule) => `${rule.column}:${rule.dir}`) },
    () => readSessionListPageByCompoundSort(input, rules, offset, limit),
    livePage
  );
}

type ListSortShadowTags =
  | { column: SqlNativeSingleSortRequest["column"]; dir: "asc" | "desc" }
  | { rules: readonly string[] };

/**
 * `tags` is spread BEFORE the fields beside it, so a tag can never shadow
 * `clean`, `durationMs` or a report field — the reserved keys win a collision.
 */
function shadowListSortCandidate(
  tags: ListSortShadowTags,
  candidate: () => Promise<ListSortPageRow[]>,
  livePage: readonly ListSortPageRow[]
): Promise<void> {
  const startedAtMs = Date.now();
  return candidate()
    .then((candidatePage) => {
      const report: ListSortDiffVerdict = diffSessionListSortPage(
        livePage.map((row) => row.id),
        candidatePage.map((row) => row.id)
      );
      if (report.clean) {
        log.info(LIST_SQL_SORT_SHADOW_EVENT, {
          ...tags,
          clean: true,
          durationMs: Date.now() - startedAtMs,
          pageSize: livePage.length,
        });
        return;
      }
      const divergences = describeSessionListSortDivergence(
        livePage,
        candidatePage
      );
      log.info(LIST_SQL_SORT_SHADOW_EVENT, {
        ...tags,
        clean: false,
        durationMs: Date.now() - startedAtMs,
        liveLength: report.liveLength,
        candidateLength: report.candidateLength,
        firstMismatchIndex: report.firstMismatchIndex,
        // EVERY diverging position, uncapped: the walk is already bounded by
        // the request's own `limit` (`SESSION_LIST_MAX_LIMIT`), and a page that
        // diverges everywhere is the one whose detail is worth the most.
        divergences,
      });
    })
    .catch((error: unknown) => {
      log.warn(LIST_SQL_SORT_SHADOW_FAILED_EVENT, {
        ...tags,
        durationMs: Date.now() - startedAtMs,
        message: error instanceof Error ? error.message : String(error),
      });
    });
}
