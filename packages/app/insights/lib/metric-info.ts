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
    what: "Median time from a PR opening to merge.",
    how: "Merge time minus the PR artifact's creation time, median across merged PRs.",
    sessions:
      "Open and merge timestamps come from the PR and its authoring session.",
  },
  "kpi:kloc": {
    what: "Thousands of lines landed via merged PRs.",
    how: "Sum of additions + deletions across merged branches, divided by 1,000.",
    sessions: "Line counts come from the merged branch's file changes.",
  },
  "kpi:cost": {
    what: "Estimated model spend in the period.",
    how: "Sum of estimated cost across agent sessions in range.",
    sessions: "Cost is summed from each session's recorded token spend.",
  },
  "kpi:merge-rate": {
    what: "Share of opened PRs that merged.",
    how: "Merged PRs divided by PRs opened in the range.",
    sessions: "Opened and merged PRs are read from PR state.",
  },
  "kpi:pr-size": {
    what: "Median size of a merged PR.",
    how: "Median of additions + deletions per merged branch.",
    sessions: "Lines changed come from the merged branch's file diffs.",
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
    what: "Model tokens consumed in the period.",
    how: "Sum of input + output tokens across sessions in range.",
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
    what: "Merged-PR throughput over time.",
    how: "Each merged PR is bucketed by its merge day across the period.",
    sessions:
      "Merge events are linked to the authoring session, so every point is attributable to the work that produced it.",
  },
  "chart:klocTrend": {
    what: "Thousands of changed lines landed over time.",
    how: "Merged PR line-change totals are bucketed by merge day and divided by 1,000.",
    sessions:
      "Line counts come from branch file changes on the session's merged PR.",
  },
  "chart:prByRepo": {
    what: "Merged PRs grouped by repository.",
    how: "Merged PRs counted per source repository.",
    sessions: "Repo comes from the session that opened each PR.",
  },
  "chart:meanTimeToMerge": {
    what: "Distribution of time-to-merge.",
    how: "Merged PRs bucketed by how long they took to merge.",
    sessions:
      "First-commit and merge timestamps are read from the authoring session's event log.",
  },
  "chart:prByState": {
    what: "PRs grouped by lifecycle state.",
    how: "PRs counted by their current state.",
    sessions: "Status comes from PR state on each session's proposal.",
  },
  "chart:checkStatus": {
    what: "CI health across branches.",
    how: "Branches grouped by their latest checks status.",
    sessions: "Check outcomes are captured from CI events on the session's PR.",
  },
  "chart:branchLifespan": {
    what: "How long branches live before merge.",
    how: "Merged branches bucketed by open-to-merge duration.",
    sessions:
      "Creation and close times come from the sessions that first touched and last closed the branch.",
  },
  "chart:branchesWithoutPr": {
    what: "Branches that have a PR vs. those that don't.",
    how: "Branches split by whether a current pull request exists.",
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
  "chart:sessionsByStatus": {
    what: "Sessions grouped by lifecycle status.",
    how: "Counts sessions by their current status.",
    sessions: "Status comes from the latest synced session record.",
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
    what: "Token consumption per model over time.",
    how: "Token usage bucketed by day and stacked by model.",
    sessions: "Model and token counts are recorded on every session turn.",
  },
  "chart:modelBreakdown": {
    what: "Token share by model.",
    how: "Total tokens grouped by model.",
    sessions:
      "Model attribution and token spend come straight from session logs.",
  },
  "chart:tokenDistribution": {
    what: "Token usage split by token class.",
    how: "Input, output, cache-read, and cache-write tokens are summed separately.",
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
