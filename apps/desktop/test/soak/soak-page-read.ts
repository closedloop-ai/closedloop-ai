/**
 * @file soak-page-read.ts
 * @description ISS-6100 — grading for one sample of the production Sessions
 * page-data IPC.
 *
 * The grade used to be the PRESENCE OF A KEY:
 *
 * ```ts
 * if (result && typeof result === "object" && "list" in result) { stats.ok += 1; }
 * ```
 *
 * `{ list: [] }` — and `{ list: { items: [], total: 0 } }` — scored `ok`. During
 * the heaviest drain windows, exactly when a read is most likely to come back
 * empty or partial, the harness could not tell "answered correctly" from
 * "answered emptily". That is the loading-vs-true-zero conflation the logical-QA
 * discipline exists to catch, sitting inside the oracle itself.
 *
 * Grading now needs CONTENT:
 *
 *  - `list.items` must be a non-empty array, and
 *  - `list.total` must not have fallen below the population established for this
 *    query at the start of the cycle.
 *
 * The expected population is established once per cycle, from a read taken after
 * the app authenticates and before the drain poll begins — the "expected
 * population for the query" in the ticket's words. It is compared with `>=`
 * rather than `===` on purpose: sync never deletes local sessions, but a
 * collector may legitimately ADD one mid-cycle, and a harness that reddened on
 * legitimate growth would be a false-alarm generator. A read that SHRINKS is the
 * failure this ticket is about, and `>=` catches every one of them.
 *
 * Note what this probe is and is not evidence of, since the ticket's second
 * point is that the harness never named it: `pageData` is the DESKTOP's LOCAL
 * read. It measures local read responsiveness and correctness while the sync
 * drain runs. It is not evidence about the cloud — that is what the read-back
 * pass in `soak-cloud-content.ts` covers.
 */

import type { PageReadGrade, PageReadStats } from "./soak-types";

export const PageReadOutcome = {
  Ok: "ok",
  /** The list answered, but with zero rows. */
  Empty: "empty",
  /** The list answered with fewer rows in total than the established population. */
  Short: "short",
  /** Not a page-data shape at all. */
  Malformed: "malformed",
} as const;
export type PageReadOutcome =
  (typeof PageReadOutcome)[keyof typeof PageReadOutcome];

type PageDataShape = {
  list?: { items?: unknown; total?: unknown } | null;
};

/**
 * True only for a value that can actually be a population size.
 *
 * `typeof total === "number"` is not that test: it admits `NaN`, `Infinity`,
 * negatives and fractions. `NaN` is the dangerous one — it passes the type
 * check, then makes EVERY subsequent comparison false, so a `NaN` total slips
 * past the short-read check and scores Ok, and `Math.min` in
 * `applyPageReadGrade` poisons `shortestTotal` for the rest of the cycle. A
 * value that cannot be a population is malformed, not a passing read.
 */
function isPopulationTotal(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Grade one page-data result against the population established for this cycle.
 *
 * `expectedTotal` of `null` means the population is not established yet — the
 * establishing read itself — so only the non-degenerate checks apply.
 */
export function gradePageRead(
  result: unknown,
  expectedTotal: number | null
): PageReadGrade {
  if (!(result && typeof result === "object")) {
    return { outcome: PageReadOutcome.Malformed, itemCount: null, total: null };
  }
  const list = (result as PageDataShape).list;
  if (!(list && typeof list === "object")) {
    return { outcome: PageReadOutcome.Malformed, itemCount: null, total: null };
  }
  const { items, total } = list;
  if (!(Array.isArray(items) && isPopulationTotal(total))) {
    return { outcome: PageReadOutcome.Malformed, itemCount: null, total: null };
  }
  if (items.length === 0) {
    return { outcome: PageReadOutcome.Empty, itemCount: 0, total };
  }
  if (total < items.length) {
    // A population smaller than the page it just returned cannot be true of any
    // real read. Grading it Ok (or Short) would report a number the answer
    // itself contradicts.
    return { outcome: PageReadOutcome.Malformed, itemCount: null, total: null };
  }
  if (expectedTotal !== null && total < expectedTotal) {
    return {
      outcome: PageReadOutcome.Short,
      itemCount: items.length,
      total,
    };
  }
  return { outcome: PageReadOutcome.Ok, itemCount: items.length, total };
}

/** Fold one grade into the cycle's accumulated page-read stats. */
export function applyPageReadGrade(
  stats: PageReadStats,
  grade: PageReadGrade,
  elapsedMs: number
): void {
  if (grade.outcome === PageReadOutcome.Ok) {
    stats.ok += 1;
    stats.latenciesMs.push(elapsedMs);
    return;
  }
  if (grade.outcome === PageReadOutcome.Empty) {
    stats.empty += 1;
    return;
  }
  if (grade.outcome === PageReadOutcome.Short) {
    stats.short += 1;
    stats.shortestTotal =
      stats.shortestTotal === null
        ? grade.total
        : Math.min(stats.shortestTotal, grade.total ?? stats.shortestTotal);
    return;
  }
  stats.errors += 1;
}

/**
 * One raw page-data read: its result, how long it took, and whether the read
 * deadline won the race. The Playwright/Electron read that produces this lives
 * in `soak-app.ts`; keeping the SHAPE here is what lets the two functions below
 * be graded and tested without an Electron runtime.
 */
export type PageReadSample = {
  result: unknown;
  elapsedMs: number;
  timedOut: boolean;
};

/**
 * ISS-6100 — establish the population this cycle's page reads are graded
 * against, from one read taken after the app authenticates and before the drain
 * poll begins.
 *
 * Returns the observed total, or `null` when the establishing read timed out,
 * threw, or itself came back degenerate; the caller records that as a fail
 * reason rather than silently grading the rest of the cycle against nothing.
 */
export async function establishPageReadPopulation(
  readOnce: () => Promise<PageReadSample>,
  stats: PageReadStats
): Promise<number | null> {
  let sample: PageReadSample;
  try {
    sample = await readOnce();
  } catch {
    return null;
  }
  if (sample.timedOut) {
    return null;
  }
  const grade = gradePageRead(sample.result, null);
  if (grade.outcome !== PageReadOutcome.Ok || grade.total === null) {
    return null;
  }
  stats.expectedTotal = grade.total;
  return grade.total;
}

/**
 * Fold one drain-time sample into the cycle's stats. A timeout is recorded as a
 * timeout; anything else is graded on CONTENT against the established
 * population.
 */
export function recordPageReadSample(
  stats: PageReadStats,
  sample: PageReadSample
): void {
  if (sample.timedOut) {
    stats.timeouts += 1;
    return;
  }
  applyPageReadGrade(
    stats,
    gradePageRead(sample.result, stats.expectedTotal),
    sample.elapsedMs
  );
}

export function newPageReadStats(): PageReadStats {
  return {
    ok: 0,
    errors: 0,
    timeouts: 0,
    empty: 0,
    short: 0,
    expectedTotal: null,
    shortestTotal: null,
    latenciesMs: [],
  };
}
