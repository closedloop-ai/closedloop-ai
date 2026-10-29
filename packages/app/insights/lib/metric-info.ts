// Definitions powering the (i) info button on every tile: what the metric
// measures, how it is computed, and what session data powers it. Keyed by tile
// id (see tile-catalog.ts). Mirrors the three-field shape (What / How / From
// session logs) used in the Insights mockup's METRIC_INFO registry.

export type MetricInfo = {
  what: string;
  how: string;
  sessions: string;
};

export const METRIC_INFO: Record<string, MetricInfo> = {
  "kpi:merged": {
    what: "Pull-request volume. The cloud dashboard counts PRs merged in the period ('Merged PRs').",
    how: "On the cloud dashboard, counts PRs whose merge date falls in the range.",
    // ISS-5505 (review): the cloud count is NOT session-derived. Its query
    // (`mergedPrWhere` in apps/api/app/insights/merged-pr-queries.ts) scopes the
    // PR/branch projection by org/user/team and filters on `prState` MERGED plus
    // `mergedAt` in range — no authoring-session link anywhere. Saying otherwise
    // claimed a provenance the count does not have.
    sessions:
      "Cloud reads merge state and merge dates from the provider's PR record, over the pull requests on branches in scope — no authoring-session link is required, so a merged PR no captured session ever touched still counts.",
  },
  "kpi:ttm": {
    // ISS-6849: the cloud median is taken over the MERGED_PR_SCAN_CAP-bounded
    // row scan (`fetchMergedPrs`, apps/api/app/insights/merged-pr-queries.ts),
    // not over every merged PR in the range. State that edge here, in the
    // wording `kpi:pr-size` already uses for the same scan.
    what: "How long delivery takes. The cloud dashboard measures time to merge.",
    how: "On the cloud dashboard, median of merge time minus the branch's creation time, across merged PRs only; it reads at most the newest 25,000 merged-PR rows in the range, so a very wide range can leave older merged PRs out of the median altogether.",
    sessions: "Cloud reads branch-creation and merge timestamps from PR state.",
  },
  "kpi:kloc": {
    what: "Thousands of lines changed. The cloud dashboard sums merged PRs ('KLOC merged').",
    // ISS-5503: PLN-1535 M4 deleted the branch-file-cache derivation this copy
    // used to describe — it gave every merged PR on a branch that branch's whole
    // line total, so a two-PR branch counted twice.
    how: "Sum of additions + deletions (gross), divided by 1,000 and rounded to one decimal. Cloud sums merged PRs only, each contributing its own diff exactly once after duplicate projections of the same PR are collapsed, and it reads at most the newest 25,000 merged-PR rows in the range — the cut is taken on those rows, before the duplicates are collapsed, so fewer than that many distinct PRs can survive it and a very wide range can leave older merged PRs out of the sum altogether. It shows a dash instead of a number when it has no line counts to sum — when no merged PR carries both counts. A dash means unknown, not zero.",
    // ISS-5503 (review): the cloud line counts are GitHub's, read from the
    // projected pull request, which the fixed "From session logs" heading above
    // this field overstates.
    sessions:
      "Cloud reads each merged PR's own additions + deletions as GitHub reported them on that pull request's projected record, not from its branch.",
  },
  "kpi:cost": {
    // ISS-4994: "spend" claimed this was money billed. It is the estimated cost of
    // all usage, most of which a subscription already covered.
    what: "Estimated cost of all model usage in the period.",
    how: "Sum of estimated cost across agent sessions in range, including usage covered by a subscription. Sessions shows the non-subscription portion separately.",
    sessions: "Cost is summed from each session's recorded token spend.",
  },
  "kpi:merge-rate": {
    // ISS-5501: this said "divided by PRs opened in the range", a denominator
    // neither producer uses — both compute merged ÷ decided through the shared
    // `ssotMergeRateFromCounts` SSOT, and the tile's own caption right beside
    // this popover already says "of decided PRs (merged + closed)".
    what: "Share of decided PRs (merged or closed) that merged.",
    how: "Merged PRs divided by decided PRs (merged + closed). PRs still open are excluded, so they don't drag the rate down.",
    sessions: "Merged and closed PRs are read from PR state.",
  },
  "kpi:pr-size": {
    // ISS-5502: not a median "per merged branch" from branch file diffs —
    // PLN-1535 M4 moved cloud onto each PR's own projected counts. Cloud's median
    // no longer passes MERGED_PR_SCAN_CAP (ISS-11589).
    what: "Median size of a PR. The cloud dashboard medians merged PRs.",
    how: "Median of additions + deletions across the PRs whose size is known. Cloud medians merged PRs — deduplicated so a PR seen by more than one source counts once — and skips any PR missing either count; it reads the merged-PR rows in the range. It shows a dash when no PR it read has a known size — which is not proof that no PR in the range has one. A dash means unknown, not zero.",
    // The popover heading over this field is the fixed literal "From session
    // logs" (info-tip.tsx), and neither line count is read from one — so this
    // field says where they DO come from rather than leaving the heading to
    // assert an origin the producers contradict.
    sessions:
      "Neither figure is read from a session log. Cloud takes additions and deletions from each merged PR's own record.",
  },
  "kpi:sessions": {
    what: "Agent sessions run in the period.",
    how: "Counts agent sessions started in the range.",
    sessions: "Counted directly from harvested agent sessions.",
  },
  "kpi:runtime": {
    what: "Total agent execution time.",
    how: "Sum of session end minus start across sessions in range.",
    sessions: "Computed from each session's start and end timestamps.",
  },
  "kpi:backlog": {
    what: "Open PRs awaiting their first review.",
    how: "Open PRs with no review decision yet.",
    sessions: "Queue state is derived from PR review status.",
  },
  "kpi:events": {
    what: "Captured local or synced session events in the period.",
    how: "Counts events attached to sessions in the selected range.",
    sessions: "Events come from the session event stream.",
  },
  "kpi:tokens": {
    what: "Model tokens consumed in the period, excluding cache.",
    // ISS-5004: the other half of the reconciliation. Stated on BOTH entries so
    // a reader who opens either one learns the same thing about the other.
    how: "Sum of input + output tokens across sessions in range. Cache read and write are excluded here and shown in the all-tokens chart.",
    sessions: "Summed from per-session token usage.",
  },
  "kpi:input-tokens": {
    what: "Prompt/input tokens consumed in the period.",
    how: "Sums input token counts across matching sessions.",
    sessions: "Input tokens are recorded in session token usage.",
  },
  "kpi:output-tokens": {
    what: "Completion/output tokens produced in the period.",
    how: "Sums output token counts across matching sessions.",
    sessions: "Output tokens are recorded in session token usage.",
  },
  "kpi:cache-tokens": {
    what: "Cache read/write tokens recorded in the period.",
    how: "Sums cache read and cache write token counts.",
    sessions: "Cache token counts are recorded alongside session token usage.",
  },
  "kpi:models": {
    what: "Distinct models used in the period.",
    how: "Unique model identifiers seen in session token usage.",
    sessions: "Model attribution comes straight from session logs.",
  },
  "kpi:tool-runs": {
    what: "Tool invocations across sessions.",
    how: "Sum of tool-use counts across sessions in range.",
    sessions: "Summed from each session's recorded tool invocations.",
  },
  "chart:prTrend": {
    // ISS-6849: cloud buckets the deduped rows of the same capped scan
    // (`bucketCountByDay` over `dedupedMerged`, apps/api/app/insights/service
    // .ts), so this trend is bounded by the cap beside a headline "Merged PRs"
    // count that is exact and uncapped. ISS-12408 added a second divergence the
    // `how` below does not state: the scan is not gated on Product eligibility,
    // so the trend can also sum ABOVE the headline. ISS-12485.
    what: "Pull-request delivery volume over time.",
    how: "On the cloud dashboard, merged PRs are bucketed by merge day, over at most the newest 25,000 merged-PR rows in the range — so a very wide range can leave older merged PRs out of their day's bar altogether.",
    sessions:
      "Agent-raised means a captured session created the PR (PR-creation evidence on the artifact link). PRs without that evidence — raised by hand, on another machine, or by a bot — fall in Manual/untracked.",
  },
  "chart:klocTrend": {
    what: "Thousands of changed lines over time. The cloud dashboard buckets merged PRs ('KLOC merged').",
    how: "Sums additions + deletions (gross) and divides by 1,000. The cloud dashboard buckets merged PR totals by merge day and leaves a merged PR it cannot size out of that day's sum — so a day plots as 0 whether nothing merged or nothing that merged could be sized, and any window holding unsized PRs reads as a lower bound over the PRs with known line counts. The cloud dashboard also reads at most the newest 25,000 merged-PR rows in the range, so a very wide range can leave older merged PRs out of their day's total altogether.",
    // ISS-5503: same per-PR derivation as the volume KPI above — bucketKlocByDay
    // reads mergedPullRequestLoc over the deduped merged PRs, not the branch
    // file cache.
    // Provenance matches the KPI's.
    sessions:
      "Cloud reads each merged PR's own additions + deletions as GitHub reported them, collapsed to one contribution per pull request before bucketing.",
  },
  "chart:prByRepo": {
    // ISS-6849: cloud counts the deduped merged PRs of the
    // MERGED_PR_SCAN_CAP-bounded scan (`buildPrByRepoBuckets` over
    // `dedupedMerged`, apps/api/app/insights/service.ts).
    what: "Merged PRs grouped by repository.",
    how: "On the cloud dashboard, merged PRs are counted per source repository, over at most the newest 25,000 merged-PR rows in the range — so a very wide range can leave older merged PRs out of the chart altogether.",
    // ISS-6845 (review): the bucket label is read off the PR row itself —
    // `pr.repository?.name`, else the short name from `pr.repositoryFullName`
    // (`buildPrByRepoBuckets`, apps/api/app/insights/service/buckets.ts) — and
    // `artifacts.repo_full_name` in the desktop query. Neither producer resolves
    // a repo through a session. But a session does gate the POPULATION on both
    // surfaces — `orgMergedPullRequestMembershipSql` (apps/api/lib/pull-request-
    // population.ts) has required a session link since ISS-8153, and desktop
    // inner-joins its `relation='created'` links — so this must not overcorrect
    // into "no session is involved". Attribute and membership are separate
    // claims; name which one the session answers.
    //
    // ISS-6845 (review 2): and the membership claim LEADS, because this field's
    // heading is the fixed literal "From session logs" (info-tip.tsx). A body
    // that opens by denying session provenance reads as a flat contradiction of
    // the heading above it — the same bad claim, now made twice. Answering the
    // heading first with what the session actually decides is what retires it.
    sessions:
      "A session link decides whether a merged PR is charted at all: one no captured session touched is absent rather than bucketed under its repo. The repository label itself is read off each pull request's own record — the repository named on the PR — rather than resolved through that session.",
  },
  "chart:meanTimeToMerge": {
    // ISS-6849: this histogram buckets the SAME capped `ttms` array the
    // median-TTM KPI medians, so it carries the same disclosure — and the same
    // UNIT. Cloud feeds `lifespanHistogram` one duration per DEDUPED MERGED PR
    // (`ttms` over `dedupedMerged`, apps/api/app/insights/service.ts);
    // branch-keyed prose reads as one sample per branch, which is the
    // branch-file-cache arithmetic PLN-1535 M4 deleted.
    what: "Distribution of delivery latency, using the same interval as the Time-to-merge/PR KPI.",
    how: "On the cloud dashboard, one branch-creation → merge duration per merged PR is bucketed — the sample is the PR, not the branch, so two merged PRs on one branch contribute two — over at most the newest 25,000 merged-PR rows in the range, so a very wide range can leave older merged PRs out of the distribution altogether.",
    sessions: "Cloud timestamps come from PR state (branch creation, merge).",
  },
  "chart:prByState": {
    // ISS-6845 (review): both producers are `mergedStateBuckets(<merged count>)`,
    // whose population is already filtered to merged PRs — so "grouped by state"
    // only ever resolves to one bucket, and to none at a count of zero. Said in
    // both fields rather than left for the reader to infer from a chart that
    // never shows a second bar.
    what: "PRs grouped by lifecycle state. It charts a merged-only population, so there is only ever one bucket to group into.",
    // ISS-6845 (review 2): "nothing renders" was wrong. `mergedStateBuckets`
    // returns `[]` at a count of zero, and `renderCategory` (tile-content.tsx)
    // turns an empty bucket list into the tile's empty state — a card is still
    // on the dashboard. The claim that holds is about the BUCKET.
    how: "Counts PRs by their current state. The single Merged bucket is sized by the merged-PR count, and no state bucket is produced at all when no PR merged in the range — the tile shows its empty state rather than a zero-height bar.",
    // Same attribute-vs-membership split as `chart:prByRepo` above — and the
    // same heading-first ordering, for the same reason: the state is the PR
    // record's, but the count sizing the bucket is the session-linked, verified
    // merged population (ISS-8153), and that is what the "From session logs"
    // heading is owed.
    sessions:
      "A session link decides which merged PRs reach the count the Merged bucket is sized by. The state itself is read off each pull request's own record rather than a session's proposal.",
  },
  "chart:checkStatus": {
    what: "CI health across every branch we observed active in the selected period.",
    how: "The range picks which branches are counted by their last activity; each is grouped by its checks status right now.",
    // ISS-6845: `fetchCheckStatusBuckets` groups `BranchDetail.checksStatus`
    // over the Branches list population for the period (ISS-11915,
    // insights-branch-population.ts) — the status stored on the branch, not CI
    // events on a session's PR.
    sessions:
      "No session log feeds this donut. The check outcome is read from each branch's own record — the checks status stored on the branch as it stands now — rather than from CI events on a session's PR.",
  },
  "chart:branchLifespan": {
    // ISS-6849: this histogram buckets the very same duration array the
    // time-to-merge histogram does (`lifespanHistogram(ttms)` in
    // apps/api/app/insights/service.ts), so it inherits cloud's capped scan and
    // the same UNIT — one duration per merged PR, never per branch: two merged
    // PRs on one branch are two samples.
    //
    // ISS-6845: same array also means `sessions` is the Time-to-merge
    // distribution's word for word. The ONLY difference is the band edges —
    // day-scale (< 1d / 1–7d / > 7d) against that chart's hour-scale five
    // (`LIFESPAN_HISTOGRAM_BUCKETS`, packages/loops-api/src/insights.ts) —
    // which is what `what` names and what `how` closes on, so a reader looking
    // at two charts of the same intervals is owed the reason they disagree on
    // shape.
    what: "The same delivery latency as the Time-to-merge chart, in day-scale bands. Despite the name, the bands count pull requests rather than branches.",
    how: "On the cloud dashboard, one branch-creation → merge duration per merged PR is bucketed — the sample is the PR, not the branch, so two merged PRs on one branch contribute two — over at most the newest 25,000 merged-PR rows in the range, so a very wide range can leave older merged PRs out of the distribution altogether. Same intervals as the Time-to-merge chart, grouped into wider day-scale bands.",
    sessions: "Cloud timestamps come from PR state (branch creation, merge).",
  },
  "chart:branchesWithoutPr": {
    what: "Whether every branch we observed active in the selected period has a pull request.",
    how: "The range picks which branches are counted by their last activity; each is split by whether it has a PR right now.",
    // ISS-6845: the split is `branchHasAnyPullRequestWhere` /
    // `branchHasNoPullRequestWhere` (branch-canonical-pull-request.ts) — the
    // pull-request rows owned by the branch's own artifact, over the Branches
    // list population for the period (ISS-11915).
    sessions:
      "No session log feeds this donut. The PR association is read from each branch's own record — whether any pull request is attached to that branch — rather than from session metadata.",
  },
  "chart:eventActivity": {
    what: "Session activity over time.",
    how: "Agent sessions bucketed by their start day.",
    sessions: "Every point is a direct count of harvested session events.",
  },
  "chart:eventVolume": {
    what: "Event volume over time.",
    how: "Session events are bucketed by event day.",
    sessions: "Events come from the local or synced session event stream.",
  },
  // ISS-9842: `chart:eventsByType` is the ring and `chart:eventsByType:bar`
  // is the leaderboard. Both read the same desktop query, which keeps the 12
  // most common types in Local mode (`local-insights.ts`, LIMIT 12), but only
  // the ring folds the rest into an Other slice — the bar drops them. One
  // shared sentence was describing the ring's residual on a tile that has none,
  // so each tile states its own retained population.
  "chart:eventsByType": {
    what: "Session events grouped by event type.",
    how: "Counts events by normalized event type. Synced data lists every type. Local data keeps the 12 most common types and folds the rest into one Other slice on the ring that names how many types it holds.",
    sessions: "Event type is recorded on each session event.",
  },
  "chart:eventsByType:bar": {
    what: "Session events grouped by event type.",
    how: "Counts events by normalized event type. Synced data lists every type. Local data keeps the 12 most common types and drops the rest, so the bars are a leaderboard, not the whole population.",
    sessions: "Event type is recorded on each session event.",
  },
  "chart:userBreakdown": {
    what: "Sessions grouped by operator.",
    how: "Agent sessions counted per initiating user.",
    sessions: "Initiating user is recorded on each session at launch.",
  },
  "chart:reviewerLoad": {
    what: "Review workload per reviewer.",
    how: "Reviews grouped by reviewer with approvals and median wait.",
    sessions:
      "Review events and timestamps come from the session's PR (auto-review attributed to the review agent).",
  },
  "chart:reviewQueue": {
    what: "Where merged-ready work waits.",
    how: "Open PRs grouped by review decision.",
    sessions: "Queue state is derived from PR review status on each proposal.",
  },
  "chart:modelUsageOverTime": {
    what: "Estimated model cost (USD) over time, including subscription-covered usage.",
    how: "Estimated cost bucketed by day and stacked by model.",
    sessions:
      "Per-session token usage is priced per model; cost is cache-neutral, unlike a raw token count.",
  },
  "chart:modelBreakdown": {
    what: "Estimated cost (USD) share by model, including subscription-covered usage.",
    how: "Estimated cost summed per model. Cost — not input+output tokens — so cache-heavy harnesses (e.g. Claude Code) aren't understated.",
    sessions:
      "Model attribution and estimated cost come straight from session token usage.",
  },
  "chart:spendByOutcome": {
    what: "Estimated spend (USD) split by the outcome of the session it came from.",
    how: "Estimated cost summed over the same session token usage as 'Spend by model', in four buckets: sessions that ended clean, sessions that ended with an error, sessions still running, and sessions whose outcome was never recorded. The four sum to total spend for the period.",
    sessions:
      "A session counts as ended only once it has an end time. Until then its spend sits under 'Still running' rather than being given an outcome it has not reached. For sessions that did end, the outcome comes from whether their own logs ended in an error; where the logs never reported either way the spend is counted as 'Not recorded' rather than assumed clean. Outcome is recorded per session, so a long session that hit an error and then recovered still counts wholly as ended with an error.",
  },
  "chart:tokenDistribution": {
    what: "Every token class recorded, including cache.",
    // ISS-5004: says out loud that this chart and the Tokens KPI count different
    // populations. Without it the two just disagree on screen.
    how: "Input, output, cache-read, and cache-write tokens are summed separately. The total is larger than the Tokens metric, which counts input and output only.",
    sessions: "Token classes are recorded in session token usage.",
  },
  // ISS-9842: `chart:toolUsage` is the leaderboard and `chart:toolUsage:donut`
  // is the ring. Same split as `chart:eventsByType` above: the desktop query
  // keeps the 20 most-used tools in Local mode (`local-insights-agents.ts`,
  // LIMIT 20); the ring folds the rest into an Other slice, the bar drops them.
  "chart:toolUsage": {
    what: "Tool usage grouped by tool name.",
    how: "Counts tool-bearing session events by tool name. Synced data lists every tool. Local data keeps the 20 most-used tools and drops the rest, so the bars are a leaderboard, not the whole population.",
    sessions: "Tool names are recorded on tool invocation events.",
  },
  "chart:toolUsage:donut": {
    what: "Tool usage share by tool name.",
    how: "Counts tool-bearing session events by tool name. Synced data lists every tool. Local data keeps the 20 most-used tools and folds the rest into one Other slice on the share ring that names how many tools it holds.",
    sessions: "Tool names are recorded on tool invocation events.",
  },
  "chart:agentsByStatus": {
    what: "Agents grouped by lifecycle status.",
    how: "Counts captured agents by their current status.",
    sessions: "Agent status is stored in each session's agent metadata.",
  },
  "chart:agentsByType": {
    what: "Agents grouped by agent type.",
    how: "Counts captured agents by type.",
    sessions: "Agent type is stored in each session's agent metadata.",
  },
  "chart:toolRunsOverTime": {
    what: "Tool invocations over time.",
    how: "Tool-use counts are summed by session start day.",
    sessions: "Tool invocations are recorded on each agent session.",
  },
};

/**
 * ISS-8184: the LOC-terminology registry — the whole table, not a patch, so a
 * caller holds one shape or the other and never composes them itself.
 *
 * Only the two volume entries differ: their labels are quoted in the copy, and
 * the `how` text no longer describes a divide-by-1,000 that the LOC operand does
 * not perform.
 */
export const LOC_TERMINOLOGY_METRIC_INFO: Record<string, MetricInfo> = {
  ...METRIC_INFO,
  "kpi:kloc": {
    ...(METRIC_INFO["kpi:kloc"] as MetricInfo),
    what: "Lines changed. The cloud dashboard sums merged PRs ('Merged LOC').",
    how: "Sum of additions + deletions (gross). Cloud sums merged PRs only, each contributing its own diff exactly once after duplicate projections of the same PR are collapsed, and it reads at most the newest 25,000 merged-PR rows in the range — the cut is taken on those rows, before the duplicates are collapsed, so fewer than that many distinct PRs can survive it and a very wide range can leave older merged PRs out of the sum altogether. It shows a dash instead of a number when it has no line counts to sum — when no merged PR carries both counts. A dash means unknown, not zero.",
  },
  "chart:klocTrend": {
    ...(METRIC_INFO["chart:klocTrend"] as MetricInfo),
    what: "Changed lines over time. The cloud dashboard buckets merged PRs ('Merged LOC').",
    how: "Sums additions + deletions (gross). The cloud dashboard buckets merged PR totals by merge day and leaves a merged PR it cannot size out of that day's sum — so a day plots as 0 whether nothing merged or nothing that merged could be sized, and any window holding unsized PRs reads as a lower bound over the PRs with known line counts. The cloud dashboard also reads at most the newest 25,000 merged-PR rows in the range, so a very wide range can leave older merged PRs out of their day's total altogether.",
  },
};

export function getMetricInfo(
  tileId: string,
  registry: Record<string, MetricInfo> = METRIC_INFO
): MetricInfo | undefined {
  if (registry[tileId]) {
    return registry[tileId];
  }
  const [kind, key] = tileId.split(":");
  return kind && key ? registry[`${kind}:${key}`] : undefined;
}
