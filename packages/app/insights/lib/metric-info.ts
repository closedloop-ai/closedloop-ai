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
    what: "Pull requests merged in the selected period.",
    how: "Counts PRs whose merge date falls in the range.",
    sessions: "Merge events are linked to their authoring agent session.",
  },
  "kpi:ttm": {
    what: "How long delivery takes. The two surfaces measure different intervals: the cloud dashboard measures time to merge, the desktop dashboard measures time to open a PR.",
    how: "On the cloud dashboard, median of merge time minus the branch's creation time, across merged PRs only. On desktop, median of a PR's first-observed time minus its linked session's start — the session that created the PR when available, otherwise the earliest linked session — across all captured PRs (merged or not).",
    sessions:
      "Cloud reads branch-creation and merge timestamps from PR state. Desktop reads the PR's first-observed time and the start of its linked session (the creating session when available, otherwise the earliest linked one) from local session logs.",
  },
  "kpi:kloc": {
    what: "Thousands of lines changed. The two surfaces measure different PR populations: the cloud dashboard sums merged PRs ('KLOC merged'), the desktop dashboard sums all captured PRs ('KLOC captured').",
    how: "On both surfaces, sum of additions + deletions (gross), divided by 1,000 and rounded to one decimal. Cloud sums merged branches only; desktop sums every captured PR in the window (merged or not), folding un-enriched PRs in as 0. Either surface shows a dash instead of a number when it has no line counts to sum — cloud when no merged PR carries both counts, desktop when no captured PR carries either. A dash means unknown, not zero.",
    sessions:
      "Cloud reads line counts from the merged branch's file changes. Desktop reads added + removed line counts from each captured PR harvested from local session logs.",
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
    // ISS-5502: neither producer medians "per merged branch" from branch file
    // diffs — PLN-1535 M4 moved cloud onto each PR's own projected counts, and
    // desktop was always a captured-PR median. Names both populations, like the
    // sibling `kpi:kloc` / `kpi:ttm` entries, and both edges that shrink them:
    // cloud's MERGED_PR_SCAN_CAP row scan (merged-pr-queries.ts) and desktop's
    // non-delivery gate (non-delivery-artifacts.ts), which drops a PR whose only
    // session links are reviews OR prose mentions.
    what: "Median size of a PR. The two surfaces measure different PR populations: the cloud dashboard medians merged PRs, the desktop dashboard medians captured PRs (merged or not).",
    how: "On both surfaces, median of additions + deletions across the PRs whose size is known. Cloud medians merged PRs — deduplicated so a PR seen by more than one source counts once — and skips any PR missing either count; it reads at most the newest 25,000 merged PRs in the range, so a very wide range can leave older merged PRs out of the median altogether. Desktop medians the captured PRs it holds both counts for, dropping any PR it only ever saw reviewed or only ever saw mentioned in prose. Either surface shows a dash when no PR it read has a known size — which is not proof that no PR in the range has one. A dash means unknown, not zero.",
    // The popover heading over this field is the fixed literal "From session
    // logs" (info-tip.tsx), and neither line count is read from one — so this
    // field says where they DO come from rather than leaving the heading to
    // assert an origin the producers contradict.
    sessions:
      "Neither figure is read from a session log. Cloud takes additions and deletions from each merged PR's own record. Desktop uses local session logs only to decide which PRs it captured; their line counts come from the PR record synced down from the cloud.",
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
    what: "Pull-request delivery volume over time.",
    how: "On desktop, each PR captured from local sessions is bucketed by the local day it was first observed and split into Agent-raised vs Manual/untracked. On the cloud dashboard, merged PRs are bucketed by merge day.",
    sessions:
      "Agent-raised means a captured session created the PR (PR-creation evidence on the artifact link). PRs without that evidence — raised by hand, on another machine, or by a bot — fall in Manual/untracked.",
  },
  "chart:klocTrend": {
    what: "Thousands of lines changed over time. The two surfaces measure different PR populations: the cloud dashboard sums merged PRs ('KLOC merged'), the desktop dashboard sums all captured PRs ('KLOC captured').",
    how: "Both sum additions + deletions (gross) and divide by 1,000. The cloud dashboard buckets merged PRs by merge day and leaves a merged PR it cannot size out of that day's sum — so a day plots as 0 whether nothing merged or nothing that merged could be sized, and any window holding unsized PRs reads as a lower bound over the PRs with known line counts. Desktop buckets every captured PR by the local day it was first observed, and shows no chart at all when no captured PR carries line counts — an unknown period, not a flat line at zero.",
    sessions:
      "Cloud line counts come from branch file changes on the session's merged PR. Desktop line counts come from each captured PR harvested from local session logs.",
  },
  "chart:prByRepo": {
    what: "Merged PRs grouped by repository.",
    how: "Merged PRs counted per source repository.",
    sessions: "Repo comes from the session that opened each PR.",
  },
  "chart:meanTimeToMerge": {
    what: "Distribution of delivery latency, using the same interval as the Time-to-merge/PR KPI.",
    how: "On the cloud dashboard, merged PRs are bucketed by branch-creation → merge duration. On desktop, captured PRs are bucketed by authoring-session-start → PR-opened duration.",
    sessions:
      "Cloud timestamps come from PR state (branch creation, merge); desktop timestamps come from the authoring session's start and the PR's first-observed time in local session logs.",
  },
  "chart:prByState": {
    what: "PRs grouped by lifecycle state.",
    how: "PRs counted by their current state.",
    sessions: "Status comes from PR state on each session's proposal.",
  },
  "chart:checkStatus": {
    what: "CI health across every branch we observed active in the selected period.",
    how: "The range picks which branches are counted by their last activity; each is grouped by its checks status right now. Counts every non-deleted branch, so it can be broader than the Branches list's session-linked filter.",
    sessions: "Check outcomes are captured from CI events on the session's PR.",
  },
  "chart:branchLifespan": {
    what: "How long branches live before merge.",
    how: "Merged branches bucketed by open-to-merge duration.",
    sessions:
      "Creation and close times come from the sessions that first touched and last closed the branch.",
  },
  "chart:branchesWithoutPr": {
    what: "Whether every branch we observed active in the selected period has a pull request.",
    how: "The range picks which branches are counted by their last activity; each is split by whether it has a PR right now. Counts every non-deleted branch, so it can be broader than the Branches list's session-linked filter.",
    sessions:
      "PR association is taken from session metadata linking a branch to its proposal.",
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
  "chart:eventsByType": {
    what: "Session events grouped by event type.",
    how: "Counts events by normalized event type.",
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
  "chart:toolUsage": {
    what: "Tool usage grouped by tool name.",
    how: "Counts tool-bearing session events by tool name.",
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

export function getMetricInfo(tileId: string): MetricInfo | undefined {
  if (METRIC_INFO[tileId]) {
    return METRIC_INFO[tileId];
  }
  const [kind, key] = tileId.split(":");
  return kind && key ? METRIC_INFO[`${kind}:${key}`] : undefined;
}
