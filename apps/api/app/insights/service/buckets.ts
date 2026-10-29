import { GITHUB_PR_STATE_LABELS } from "@repo/api/src/types/github";
import type {
  CategoryBucket,
  TimeSeries,
  TimeSeriesSeries,
} from "@repo/api/src/types/insights";
import { MERGED_LOC_LABEL } from "@repo/api/src/types/insights-loc-terminology-flag";
import { GitHubPRState } from "@repo/database";
import { mergedPullRequestLoc } from "@repo/lib/pull-requests/merged-pr-twin-resolution";
import { eachDayKey, makeDayKey } from "../lib/daily-buckets";
import type { MergedPrRow } from "../merged-pr-queries";

/**
 * Buckets pre-aggregated (label, count) pairs coming from a DB `groupBy`. Merges
 * any labels that collide after transformation and sorts by descending count —
 * the key mirrors the label, as before.
 *
 * ISS-4754: ties break on the LABEL, ascending. Without a secondary key, equal
 * counts fell through to `Map` insertion order, which is the row order of an
 * unordered Postgres `groupBy`/`GROUPING SETS` — so the same data could emit a
 * different array on two reads. The golden corpus makes that concrete: its tool
 * tally holds a ten-way tie at 1, and Layer 5 freezes these responses as byte-
 * compared fixtures, which a nondeterministic order would make permanently flaky.
 */
export function bucketByLabelCounts(
  entries: { label: string; value: number }[]
): CategoryBucket[] {
  const counts = new Map<string, number>();
  for (const { label, value } of entries) {
    counts.set(label, (counts.get(label) ?? 0) + value);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ key: label, label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/**
 * FEA-2732 / review: build the (label, count) entries for the "PRs by repo"
 * chart, collapsing the App and desktop lanes for one physical repo into a
 * single bucket. The App lane supplies GitHub's canonical-case short
 * `repository.name`; the repo-less desktop lane only has `repositoryFullName`
 * (owner/name), lowercased by normalizeRepoFullName. Grouping by a
 * case-insensitive key prevents "Foo-Bar" and "foo-bar" from becoming two
 * buckets; the display label prefers the App's canonical casing when any row in
 * the group supplies it, else falls back to the (lowercased) short name. Rows
 * carrying neither identity cannot be bucketed by repo and are dropped.
 *
 * ISS-5411 split the two inputs. Buckets are COUNTED over `dedupedMerged`,
 * because case-folding the label only stops the two lanes from fragmenting into
 * two BUCKETS — it never stopped one pull request counting twice inside one.
 * Casing is still resolved over ALL `scanned` rows: when a repo-less desktop row
 * wins the dedupe (it is the sized one), dropping its App twin would otherwise
 * take the only canonical-case name for that repo with it and downgrade the
 * label to "foo-bar". A row excluded from the count can still name its repo.
 */
export function buildPrByRepoBuckets(
  dedupedMerged: MergedPrRow[],
  scanned: MergedPrRow[]
): { label: string; value: number }[] {
  const canonicalByKey = new Map<string, string>();
  for (const pr of scanned) {
    const canonicalName = pr.repository?.name;
    if (canonicalName) {
      canonicalByKey.set(canonicalName.toLowerCase(), canonicalName);
    }
  }
  const byKey = new Map<string, { label: string; value: number }>();
  for (const pr of dedupedMerged) {
    const label =
      pr.repository?.name ?? pr.repositoryFullName?.split("/").at(-1) ?? null;
    if (!label) {
      continue;
    }
    const key = label.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.value += 1;
    } else {
      byKey.set(key, { label: canonicalByKey.get(key) ?? label, value: 1 });
    }
  }
  return [...byKey.values()];
}

export function bucketCountByDay(
  dates: Date[],
  start: Date,
  end: Date,
  series: TimeSeriesSeries,
  timeZone?: string
): TimeSeries {
  const toKey = makeDayKey(timeZone);
  const counts = new Map<string, number>();
  for (const date of dates) {
    if (date >= start && date <= end) {
      const key = toKey(date);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const points = eachDayKey(start, end, timeZone).map((date) => ({
    date,
    values: { [series.key]: counts.get(date) ?? 0 },
  }));
  return { series: [series], points };
}

/**
 * PLN-1535 M4: takes ALREADY-DEDUPED merged PRs and reads each PR's own
 * projected size, so the daily series is taken of the same population as the
 * KLOC tile. A PR with unknown LOC contributes nothing to its day rather than a
 * zero — the day's bar is a lower bound over what is known, matching the tile.
 */
export function bucketKlocByDay(
  dedupedMerged: MergedPrRow[],
  start: Date,
  end: Date,
  timeZone?: string
): TimeSeries {
  const toKey = makeDayKey(timeZone);
  const counts = new Map<string, number>();
  for (const pr of dedupedMerged) {
    if (!(pr.mergedAt && pr.mergedAt >= start && pr.mergedAt <= end)) {
      continue;
    }
    const loc = mergedPullRequestLoc(pr);
    if (loc === null) {
      continue;
    }
    const key = toKey(pr.mergedAt);
    counts.set(key, (counts.get(key) ?? 0) + loc / 1000);
  }
  const points = eachDayKey(start, end, timeZone).map((date) => ({
    date,
    values: { kloc: round(counts.get(date) ?? 0, 1) },
  }));
  return { series: [{ key: "kloc", label: "KLOC merged" }], points };
}

/**
 * ISS-8184: {@link bucketKlocByDay} on its true basis — raw lines per day, so the
 * series under a "Merged LOC over time" heading carries no scale factor.
 *
 * A separate function rather than a parameter on the one above, because the two
 * series ship side by side while the LOC terminology flag is off for anyone:
 * this is the additive half of the same migration the `loc` / `mergedLoc` KPIs
 * make, not a replacement.
 */
export function bucketLocByDay(
  dedupedMerged: MergedPrRow[],
  start: Date,
  end: Date,
  timeZone?: string
): TimeSeries {
  const toKey = makeDayKey(timeZone);
  const counts = new Map<string, number>();
  for (const pr of dedupedMerged) {
    if (!(pr.mergedAt && pr.mergedAt >= start && pr.mergedAt <= end)) {
      continue;
    }
    const loc = mergedPullRequestLoc(pr);
    if (loc === null) {
      continue;
    }
    const key = toKey(pr.mergedAt);
    counts.set(key, (counts.get(key) ?? 0) + loc);
  }
  const points = eachDayKey(start, end, timeZone).map((date) => ({
    date,
    values: { loc: counts.get(date) ?? 0 },
  }));
  return { series: [{ key: "loc", label: MERGED_LOC_LABEL }], points };
}

// FEA-2878: every fetched row is MERGED, so the state distribution is a single
// bucket sized by the merged count — not the (possibly capped) row array —
// keeping it consistent with the "Merged PRs" KPI at any org size. ISS-5411:
// that count is now the distinct-pull-request one, so the bucket and the KPI
// still agree.
export function mergedStateBuckets(mergedCount: number): CategoryBucket[] {
  if (mergedCount === 0) {
    return [];
  }
  return [
    {
      key: GitHubPRState.MERGED,
      label: GITHUB_PR_STATE_LABELS[GitHubPRState.MERGED],
      value: mergedCount,
    },
  ];
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
