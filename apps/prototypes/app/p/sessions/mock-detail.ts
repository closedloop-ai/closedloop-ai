// Detail fixture builder for the Sessions prototype. Presentational only.
// Mirrors the in-product `AgentSessionDetail` transcript-first layout: title,
// properties, a cost-bar session timeline with event dots, the Session Trace
// conversation, and a persistent comments rail.
//
// Everything here is DERIVED from the clicked row (duration, cost, harness,
// provenance, status, name, repo) so the detail view reflects the session the
// reader actually opened — a 4-minute 28-cent Copilot bump renders a short
// two-turn trace, a 2-hour agent run renders a long one (review: the detail is
// the handoff spec; it must not contradict the row).

import {
  formatAgo,
  formatDuration,
  HARNESS_CONFIG,
  type Harness,
  Provenance,
  SESSION_STATUS_CONFIG,
  type SessionRow,
  SessionStatus,
  type SessionStatus as SessionStatusType,
  shortRepoName,
} from "./mock";

// --- Session trace (the agents `SessionTrace` transcript) ------------------

export type TraceInline = string | { code: string } | { pr: number };

export type TraceBlock =
  | { type: "p"; spans: TraceInline[] }
  | { type: "ul"; items: TraceInline[][] }
  | {
      type: "tools";
      summary: string;
      rows: { label: string; detail?: string }[];
    };

export type TraceTurn = {
  id: string;
  row?: number;
  side: "human" | "agent";
  /** Elapsed offset within the session (e.g. "0:02"). */
  timeLabel: string;
  /** Wall-clock time the message was sent (e.g. "9:16 AM"). */
  sentLabel?: string;
  durationLabel?: string;
  costLabel?: string;
  model?: string;
  blocks: TraceBlock[];
};

// --- Session timeline (timestamped costs + trace markers) ------------------

export type TimelineCostEvent = {
  atMinutes: number;
  model: string;
  phase: "Planning" | "Research" | "Implementation" | "Verification";
  cIn: number;
  cOut: number;
  cCache: number;
  traceRow: number;
};

export type TimelineMarkerKind =
  | "commit"
  | "fail"
  | "frust"
  | "limit"
  | "pr"
  | "prompt";

export type TimelineMarker = {
  atMinutes: number;
  kind: TimelineMarkerKind;
  label: string;
  traceRow: number;
};

// --- Linked artifacts + comments -------------------------------------------

export type LinkedArtifact = { slug: string; name: string; kind: string };

export type SessionComment = {
  id: string;
  author: string;
  at: string;
  anchorPreview?: string;
  body: string;
  traceRow: number;
};

// --- Detail shape ----------------------------------------------------------

export type SessionDetail = {
  id: string;
  name: string;
  externalSessionId: string;
  status: SessionStatusType;
  harness: Harness;
  harnessLabel: string;
  statusLabel: string;
  ownerName: string;
  model: string;
  autonomy: number | null;
  repo: string | null;
  branch: string | null;
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  prStateLabel: string | null;
  durationLabel: string;
  durationMinutes: number;
  timelineStartMinutes: number;
  costLabel: string;
  startedLabel: string;
  workingDir: string;
  tokensLabel: string;
  turnCount: number;
  toolCount: number;
  linkedArtifacts: LinkedArtifact[];
  timelineStartLabel: string;
  timelineEndLabel: string;
  costEvents: TimelineCostEvent[];
  timelineMarkers: TimelineMarker[];
  trace: TraceTurn[];
  comments: SessionComment[];
};

// Timestamped, model-priced events are aggregated into the selected clock
// scale by the timeline. Gaps in this profile therefore become genuine
// zero-token / zero-cost idle intervals instead of decorative "idle" bars.
function formatMoney(cost: number): string {
  return cost < 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(1)}`;
}

function formatTokens(cost: number): string {
  // A plausible tokens-per-dollar factor so the figure tracks the cost.
  const tokens = cost * 165_000;
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  }
  return `${Math.round(tokens / 1000)}k tokens`;
}

const COST_EVENT_PROFILE = [
  { at: 0.01, weight: 0.05, model: 0, phase: "Planning" },
  { at: 0.04, weight: 0.08, model: 0, phase: "Research" },
  { at: 0.28, weight: 0.09, model: 0, phase: "Research" },
  { at: 0.32, weight: 0.12, model: 0, phase: "Implementation" },
  { at: 0.36, weight: 0.1, model: 1, phase: "Implementation" },
  { at: 0.42, weight: 0.11, model: 0, phase: "Implementation" },
  { at: 0.47, weight: 0.09, model: 1, phase: "Verification" },
  { at: 0.53, weight: 0.08, model: 0, phase: "Implementation" },
  { at: 0.72, weight: 0.08, model: 0, phase: "Verification" },
  { at: 0.78, weight: 0.07, model: 1, phase: "Implementation" },
  { at: 0.86, weight: 0.06, model: 0, phase: "Verification" },
  { at: 0.94, weight: 0.07, model: 0, phase: "Verification" },
] as const;

function buildCostEvents(
  totalCost: number,
  durationMinutes: number,
  primaryModel: string,
  traceRows: number,
  markers: readonly TimelineMarker[]
): TimelineCostEvent[] {
  if (totalCost <= 0) {
    return [];
  }
  if (durationMinutes <= 0) {
    return [
      {
        atMinutes: 0,
        model: primaryModel,
        phase: "Planning",
        cIn: totalCost * 0.08,
        cOut: totalCost * 0.23,
        cCache: totalCost * 0.69,
        traceRow: 0,
      },
    ];
  }
  const secondaryModel =
    primaryModel.includes("opus") || primaryModel.includes("sonnet")
      ? "claude-haiku-4-5"
      : primaryModel;

  // Event dots are never placed over an idle interval. A prompt, delivery
  // event, failure, limit, or correction practically implies token-bearing
  // agent activity in that same interval. Add a small cost sample at every
  // distinct marker timestamp, then normalize all samples so their sum still
  // reconciles exactly to the session's displayed total.
  const markerSamples = [
    ...new Set(markers.map((marker) => marker.atMinutes)),
  ].map((atMinutes) => ({
    atMinutes,
    weight: 0.015,
    model: primaryModel,
    phase: "Verification" as const,
  }));
  const samples = [
    ...COST_EVENT_PROFILE.map((event) => ({
      atMinutes: durationMinutes * event.at,
      weight: event.weight,
      model: event.model === 0 ? primaryModel : secondaryModel,
      phase: event.phase,
    })),
    ...markerSamples,
  ];
  const totalWeight = samples.reduce((sum, event) => sum + event.weight, 0);

  return samples.map((event) => {
    const eventCost = totalCost * (event.weight / totalWeight);
    return {
      atMinutes: event.atMinutes,
      model: event.model,
      phase: event.phase,
      cIn: eventCost * 0.08,
      cOut: eventCost * 0.23,
      cCache: eventCost * 0.69,
      traceRow: Math.min(
        Math.max(0, traceRows - 1),
        Math.floor((event.atMinutes / durationMinutes) * traceRows)
      ),
    };
  });
}

function buildTimelineMarkers(
  row: SessionRow,
  durationMinutes: number,
  traceRows: number
): TimelineMarker[] {
  const lastRow = Math.max(0, traceRows - 1);
  const markers: TimelineMarker[] = [
    {
      atMinutes: 0,
      kind: "prompt",
      label: `Start: ${row.name}`,
      traceRow: 0,
    },
  ];
  if (traceRows >= 4) {
    markers.push(
      {
        atMinutes: durationMinutes * 0.55,
        kind: "commit",
        label: "Commit implementation checkpoint",
        traceRow: Math.min(2, lastRow),
      },
      {
        atMinutes: durationMinutes * 0.72,
        kind: "prompt",
        label: "Also cover the edge case with no linked branch",
        traceRow: Math.min(3, lastRow),
      },
      {
        atMinutes: durationMinutes * 0.72,
        kind: "frust",
        label: "Change requested after implementation review",
        traceRow: Math.min(3, lastRow),
      }
    );
  }
  if (row.prNumber) {
    markers.push({
      atMinutes: durationMinutes * 0.9,
      kind: "pr",
      label: `Pull request #${row.prNumber} updated`,
      traceRow: lastRow,
    });
  }
  if (row.status === SessionStatus.Failed) {
    markers.push({
      atMinutes: durationMinutes * 0.82,
      kind: "fail",
      label: "Tool execution failed",
      traceRow: lastRow,
    });
  }
  if (durationMinutes > 60) {
    markers.push({
      atMinutes: durationMinutes * 0.63,
      kind: "limit",
      label: "Provider throttled; resumed after retry window",
      traceRow: Math.min(2, lastRow),
    });
  }
  return markers;
}

function durationLabelAt(durationMinutes: number, fraction: number): string {
  const minutes = Math.round(durationMinutes * fraction);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** Turn count scales with duration; a bot bump is a single automated turn. */
function turnCountFor(row: SessionRow): number {
  if (row.provenance === Provenance.Bot) {
    return 1;
  }
  const durationMinutes = row.durationMs / 60_000;
  if (durationMinutes <= 12) {
    return 2;
  }
  if (durationMinutes <= 75) {
    return 4;
  }
  return 6;
}

function buildBotTrace(row: SessionRow, model: string): TraceTurn[] {
  return [
    {
      id: "t1",
      side: "agent",
      timeLabel: "0:00",
      durationLabel: formatDuration(row.durationMs),
      costLabel: formatMoney(row.cost),
      model,
      blocks: [
        {
          type: "p",
          spans: [
            "Automated dependency bump: ",
            { code: "next 15.3.4 → 15.4.2" },
            ". Updated the manifest and lockfile, then verified the build.",
          ],
        },
        {
          type: "tools",
          summary: "Ran 3 tools · edit manifest, install, typecheck",
          rows: [
            { label: "Edit", detail: "package.json" },
            { label: "Bash", detail: "pnpm install --lockfile-only" },
            { label: "Bash", detail: "pnpm --filter web typecheck" },
          ],
        },
        {
          type: "ul",
          items: [
            ["No breaking changes in the changelog for this range"],
            ["Opened ", { pr: row.prNumber ?? 1292 }, " for review"],
          ],
        },
      ],
    },
  ];
}

function buildAgentTrace(row: SessionRow, model: string): TraceTurn[] {
  const repoShort = row.repo ? shortRepoName(row.repo) : "the repo";
  const turnCount = turnCountFor(row);
  const failed = row.status === SessionStatus.Failed;
  const turns: TraceTurn[] = [
    {
      id: "t1",
      side: "human",
      timeLabel: "0:00",
      blocks: [
        {
          type: "p",
          spans: [
            "Let's tackle: ",
            { code: row.name },
            ". Match the existing patterns in ",
            { code: repoShort },
            " before writing anything.",
          ],
        },
      ],
    },
    {
      id: "t2",
      side: "agent",
      timeLabel: "0:02",
      durationLabel: formatDuration(row.durationMs * 0.35),
      costLabel: formatMoney(row.cost * 0.32),
      model,
      blocks: [
        {
          type: "p",
          spans: [
            "Scanning the relevant modules and tests so the change fits the current conventions.",
          ],
        },
        {
          type: "tools",
          summary: "Ran 6 tools · read the entrypoints, grepped for callers",
          rows: [
            { label: "Grep", detail: `${repoShort} · 7 matches` },
            { label: "Read", detail: "the primary module + its test" },
            { label: "List", detail: `${repoShort} package tree` },
          ],
        },
      ],
    },
  ];

  if (turnCount >= 4) {
    turns.push({
      id: "t3",
      side: "agent",
      timeLabel: durationLabelAt(row.durationMs / 60_000, 0.5),
      durationLabel: formatDuration(row.durationMs * 0.4),
      costLabel: formatMoney(row.cost * 0.42),
      model,
      blocks: [
        {
          type: "tools",
          summary: "Ran 9 tools · wrote the change, ran typecheck",
          rows: [
            { label: "Write", detail: "the new module" },
            { label: "Edit", detail: "wired it into the entrypoint" },
            { label: "Bash", detail: `pnpm --filter ${repoShort} typecheck` },
          ],
        },
        {
          type: "p",
          spans: failed
            ? [
                "Typecheck surfaced an unresolved error the run couldn't get past before it stopped.",
              ]
            : [
                "Threaded the new dependency through and the typecheck is green.",
              ],
        },
      ],
    });
  }

  if (turnCount >= 6) {
    turns.push(
      {
        id: "t4",
        side: "human",
        timeLabel: durationLabelAt(row.durationMs / 60_000, 0.72),
        blocks: [
          {
            type: "p",
            spans: [
              "Looks good. Also cover the edge case with no linked branch.",
            ],
          },
        ],
      },
      {
        id: "t5",
        side: "agent",
        timeLabel: durationLabelAt(row.durationMs / 60_000, 0.78),
        durationLabel: formatDuration(row.durationMs * 0.22),
        costLabel: formatMoney(row.cost * 0.24),
        model,
        blocks: [
          {
            type: "p",
            spans: ["Added the variant and a focused unit test:"],
          },
          {
            type: "ul",
            items: [
              ["Handles the branch-less path"],
              ["Test round-trips the new shape"],
              row.prNumber
                ? ["Pushed to ", { pr: row.prNumber }]
                : ["Change staged locally (no PR opened)"],
            ],
          },
        ],
      }
    );
  }

  if (row.durationMs >= 60 * 60_000) {
    const followups = [
      [
        "agent",
        0.82,
        "Validated the change against the production data path and compared the resulting trace timestamps.",
        "Ran 12 tools · inspected events, costs, and persisted activity",
      ],
      [
        "human",
        0.85,
        "Check the long idle spans and make sure a later event still anchors to the correct turn.",
        undefined,
      ],
      [
        "agent",
        0.88,
        "The idle spans remain zero-cost, while every event marker lands in a token-bearing bucket and opens this matching turn.",
        "Ran 8 tools · replayed timeline navigation scenarios",
      ],
      [
        "human",
        0.91,
        "Now verify the session boundary and the final activity time.",
        undefined,
      ],
      [
        "agent",
        0.94,
        `Verified the ${row.name} session boundary, final activity, and aggregate cost against the source session.`,
        "Ran 6 tools · reconciled totals and timestamps",
      ],
      [
        "agent",
        0.98,
        "Finished the production comparison and recorded the remaining follow-up work.",
        "Ran 4 tools · final checks and handoff",
      ],
    ] as const;
    for (const [side, fraction, text, tools] of followups) {
      turns.push({
        id: `t${turns.length + 1}`,
        side,
        timeLabel: durationLabelAt(row.durationMs / 60_000, fraction),
        costLabel: side === "agent" ? formatMoney(row.cost * 0.04) : undefined,
        model: side === "agent" ? model : undefined,
        blocks: [
          { type: "p", spans: [text] },
          ...(tools
            ? [
                {
                  type: "tools" as const,
                  summary: tools,
                  rows: [
                    {
                      label: "Read",
                      detail: "production session event stream",
                    },
                    {
                      label: "Compare",
                      detail: "timeline and transcript offsets",
                    },
                    { label: "Verify", detail: "cost and activity totals" },
                  ],
                },
              ]
            : []),
        ],
      });
    }
  }

  return turns;
}

/**
 * A long-form trace based on the real 8h 52m production session
 * “Find Peter's assigned tickets from Mike” (305 events). The transcript keeps
 * every visible conversational turn from the main thread while tool activity
 * is summarized in the same expandable groups used elsewhere in this mock.
 */
function _buildLongProductionTrace(model: string): TraceTurn[] {
  const messages: Array<{
    side: TraceTurn["side"];
    at: string;
    text: string;
    tools?: string;
    rows?: { label: string; detail?: string }[];
  }> = [
    {
      side: "human",
      at: "0:00",
      text: "Please help me find the tickets Mike said are assigned to me (Peter Ulsteen) in this Slack message. The linked ChatGPT conversation contains a table of guidelines that should become enforceable checks.",
    },
    {
      side: "agent",
      at: "0:15",
      text: "I found 11 tickets, all created together, assigned to Peter, and still TODO. They cover navigation, CI package coverage, client logging, source-text tests, timing assertions, unsafe casts, design-system boundaries, database access, migrations, dependency direction, and environment access.",
      tools: "Ran 7 tools · searched Slack context and matched tracker records",
      rows: [
        { label: "Search", detail: "message context and linked table" },
        { label: "Query", detail: "11 matching FEA records" },
        { label: "Verify", detail: "owner, state, and creation time" },
      ],
    },
    {
      side: "human",
      at: "0:22",
      text: "Let's take all of these plus FEA-4120 and parent them under a new PRD, unless you strongly recommend keeping FEA-4120 standalone.",
    },
    {
      side: "agent",
      at: "0:31",
      text: "Created PRD-564, “Ratchet documented guidelines into enforceable gates (AGENTS.md → CI),” as a high-priority draft assigned to Peter. All 12 FEAs are linked; FEA-4120 belongs because it is the integration-level capstone rather than a separate initiative.",
      tools: "Ran 21 tools · reviewed children, created PRD, and linked work",
      rows: [
        { label: "Read", detail: "12 FEA definitions and acceptance criteria" },
        { label: "Create", detail: "PRD-564" },
        { label: "Update", detail: "parent links and project membership" },
      ],
    },
    {
      side: "human",
      at: "0:38",
      text: "Make prose deletion part of done and require each gate to be observed failing in every child FEA. Verify the unresolved questions in code and GitHub, build a dependency graph, and add a clear execution order to the PRD.",
    },
    {
      side: "agent",
      at: "0:56",
      text: "Verified each child against the codebase and current GitHub state. The PRD now includes the shared acceptance criteria, dependency graph, wave ordering, blockers, and the evidence behind each sequencing decision.",
      tools:
        "Ran 34 tools · inspected code, workflows, branches, and issue state",
      rows: [
        { label: "GitHub", detail: "checked open and merged dependencies" },
        { label: "Code", detail: "located current enforcement mechanisms" },
        { label: "Update", detail: "PRD dependency graph and execution waves" },
      ],
    },
    {
      side: "human",
      at: "3:03",
      text: "Start an orchestrated goal for PRD-564. Delegate each FEA to a fresh worktree, require plan debate, execute the plan, run deep review, and babysit every PR through comments and checks.",
    },
    {
      side: "agent",
      at: "3:08",
      text: "Acknowledged. Three unblocked pipelines are starting in parallel: FEA-4244, FEA-4114, and FEA-4118. Each follows the requested plan, debate, upload, implementation, review, push, PR, and babysit sequence.",
      tools: "Ran 3 tools · launched independent workstreams",
      rows: [
        { label: "Delegate", detail: "FEA-4244 · Wave 0" },
        { label: "Delegate", detail: "FEA-4114 · Wave 1" },
        { label: "Delegate", detail: "FEA-4118 · independent" },
      ],
    },
    {
      side: "human",
      at: "3:13",
      text: "Let's discuss Q3 and reason toward an answer based on data and evidence.",
    },
    {
      side: "agent",
      at: "3:31",
      text: "The two proposed gates have different risk profiles. Repository-boundary enforcement is deterministic and should be required immediately with narrowly documented exemptions. CI-package coverage should also be required immediately, but its generated inventory must make legitimate exclusions explicit.",
      tools: "Ran 6 tools · measured violations and reviewed workflow history",
      rows: [
        { label: "Measure", detail: "current violations by rule" },
        {
          label: "History",
          detail: "recent false-positive and CI failure rate",
        },
        {
          label: "Compare",
          detail: "warn-only bake period versus day-one gate",
        },
      ],
    },
    {
      side: "human",
      at: "4:44",
      text: "Why is #3618 the reason main is red?",
    },
    {
      side: "agent",
      at: "4:51",
      text: "Fair challenge. I verified the symptom but had repeated the causal claim too quickly. The only failing tests are the two sessions added by #3618, but the divergence is content rather than schema: identical input produced different stored output. That makes the failure real without proving the PR itself introduced the nondeterminism.",
      tools: "Ran 4 tools · reproduced failures and compared fixtures",
      rows: [
        { label: "Test", detail: "isolated the two failing session cases" },
        { label: "Diff", detail: "row counts match; stored content differs" },
        { label: "Trace", detail: "identified the nondeterministic boundary" },
      ],
    },
    {
      side: "human",
      at: "4:58",
      text: "Using summary commit messages always: squash-merge #3848, and #3845/#3846 once green.",
    },
    {
      side: "agent",
      at: "5:04",
      text: "#3848 is merged with a summary commit. FEA-4118 and its plan are complete. I am holding #3845 and #3846 until their rebases and babysit passes finish so an in-flight push cannot race the merge.",
      tools: "Ran 5 tools · merged, updated work items, and checked successors",
      rows: [
        { label: "Merge", detail: "#3848 · squash with summary" },
        { label: "Update", detail: "FEA-4118 DONE · plan EXECUTED" },
        { label: "Check", detail: "no blocked successor to launch" },
      ],
    },
    {
      side: "human",
      at: "5:08",
      text: "I thought we already settled Q3: both required day one with the exemptions you named.",
    },
    {
      side: "agent",
      at: "5:16",
      text: "Understood; recording that as the decision. Both checks become required immediately, with explicit exemptions. A new required context must first be green on main, and the desktop-version-bump escape-hatch label must be created before the rule can rely on it.",
      tools: "Ran 2 tools · verified repository and label prerequisites",
      rows: [
        { label: "Repository", detail: "confirmed live ruleset worktree" },
        { label: "Labels", detail: "desktop-version-bump does not yet exist" },
      ],
    },
    {
      side: "human",
      at: "5:33",
      text: "This repo moves VERY quickly during US central business hours.",
    },
    {
      side: "agent",
      at: "5:42",
      text: "Agreed. Committer timestamps show main moving several times inside a normal verification window, so merge-queue behavior is load-bearing. The process should trust the queue for freshness while retaining deterministic local and CI checks for semantic conflicts.",
      tools: "Ran 4 tools · measured merge cadence and reviewed queue behavior",
      rows: [
        { label: "Git", detail: "committer-time merge cadence" },
        { label: "Review", detail: "prior merge-queue investigation" },
        {
          label: "Decision",
          detail: "queue for freshness, gates for semantics",
        },
      ],
    },
    {
      side: "human",
      at: "5:54",
      text: "I agree. Keep this directionally aligned: turn AGENTS.md directives into deterministic checks that run locally and in CI, leaving AGENTS.md narrowly scoped.",
    },
    {
      side: "agent",
      at: "6:02",
      text: "PRD-564 is updated with a measurable enforcement-coverage metric, a locally-and-CI-enforceable acceptance criterion, the resolved Q3 decision, and an auditable rule ledger. The next unblocked FEA is launching now.",
      tools: "Ran 4 tools · revised PRD and advanced the dependency graph",
      rows: [
        { label: "Update", detail: "coverage metric and AC-7" },
        { label: "Resolve", detail: "Q2 obsolete · Q3 decided" },
        { label: "Launch", detail: "next dependency-ready FEA" },
      ],
    },
    {
      side: "human",
      at: "6:14",
      text: "PR #3864 has the api-integration-tests fix and will soon merge. At that point all blocked PRs can rebase and merge on main.",
    },
    {
      side: "agent",
      at: "6:21",
      text: "#3864 contains the expected fixture and database-helper fix, with nine passing and two pending tests. A watch is armed so the rebase cascade starts only after a confirmed merge, not a close-without-merge event.",
      tools: "Ran 3 tools · verified fix and armed merge watch",
      rows: [
        { label: "Inspect", detail: "#3864 changed files and checks" },
        { label: "Verify", detail: "9 passing · 2 pending" },
        { label: "Watch", detail: "merge-specific completion signal" },
      ],
    },
    {
      side: "human",
      at: "6:42",
      text: "Merge #3862 and #3860 once green AND all comments have been addressed and replied to.",
    },
    {
      side: "agent",
      at: "6:49",
      text: "I checked the stronger bar rather than trusting the unresolved-thread count. Two new review threads had no replies. Both expose the same deterministic-failure class we have been addressing, so I stopped the merge and routed the findings back for fixes and explicit responses.",
      tools: "Ran 4 tools · audited reviews, read findings, and paused merge",
      rows: [
        { label: "Reviews", detail: "found two unreplied threads" },
        { label: "Assess", detail: "both findings valid and blocking" },
        { label: "Route", detail: "fixes plus explicit reviewer replies" },
      ],
    },
    {
      side: "agent",
      at: "8:52",
      text: "The session remains open while the corrected branches rebase and checks settle. No merge will proceed until every required check is green and every review comment has a substantive reply.",
      tools: "Ran 3 tools · final status sweep",
      rows: [
        { label: "Checks", detail: "required contexts monitored" },
        { label: "Reviews", detail: "reply status monitored" },
        { label: "Queue", detail: "merges held behind verified readiness" },
      ],
    },
  ];

  return messages.map((message, index) => {
    const isAgent = message.side === "agent";
    const isLastMessage = index === messages.length - 1;
    let durationLabel: string | undefined;
    if (isAgent) {
      durationLabel = isLastMessage ? "2:03" : "0:07";
    }
    return {
      id: `production-${index + 1}`,
      side: message.side,
      timeLabel: message.at,
      durationLabel,
      costLabel: isAgent ? `$${(0.72 + index * 0.19).toFixed(2)}` : undefined,
      model: isAgent ? model : undefined,
      blocks: [
        { type: "p", spans: [message.text] },
        ...(message.tools && message.rows
          ? [
              {
                type: "tools" as const,
                summary: message.tools,
                rows: message.rows,
              },
            ]
          : []),
      ],
    };
  });
}

const COMMENTS: SessionComment[] = [
  {
    id: "c1",
    author: "Parker Byrd",
    at: "34m ago",
    anchorPreview: "Match the existing patterns before writing anything",
    body: "Can we make this deterministic so two runs produce the same result? A seeded approach would keep the golden tests from flapping.",
    traceRow: 2,
  },
  {
    id: "c2",
    author: "Sam Chen",
    at: "20m ago",
    body: "Agreed. Otherwise the checks will flake on re-run.",
    traceRow: 4,
  },
];

function linkedArtifactsFor(row: SessionRow): LinkedArtifact[] {
  // A bot bump references nothing; agent/human sessions cite the work items.
  if (row.provenance === Provenance.Bot) {
    return [];
  }
  return [
    { slug: "FEA-3948", name: row.name, kind: "Feature" },
    { slug: "PLN-1034", name: "Fixture drift remediation", kind: "Plan" },
  ];
}

// Deterministic wall-clock anchor for a session's first message (mock only).
const SESSION_START_MINUTES = 9 * 60 + 14; // 9:14 AM

function elapsedMinutesFromLabel(label: string): number {
  const [hours, minutes] = label.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function clockLabel(minutesOfDay: number): string {
  const wrapped = ((minutesOfDay % 1440) + 1440) % 1440;
  const hours24 = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  const period = hours24 < 12 ? "AM" : "PM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(minutes).padStart(2, "0")} ${period}`;
}

// Stamp each turn with a wall-clock "sent" time derived from the session start
// anchor plus the turn's elapsed offset (its `timeLabel`).
function withSentLabels(turns: TraceTurn[]): TraceTurn[] {
  return turns.map((turn) => ({
    ...turn,
    sentLabel: clockLabel(
      SESSION_START_MINUTES + elapsedMinutesFromLabel(turn.timeLabel)
    ),
  }));
}

export function buildSessionDetail(row: SessionRow): SessionDetail {
  const statusConfig = SESSION_STATUS_CONFIG[row.status];
  const model = row.model ?? "model";
  const durationMinutes = row.durationMs / 60_000;
  const prStateLabel = row.prState
    ? row.prState.charAt(0).toUpperCase() + row.prState.slice(1)
    : null;
  const trace = withSentLabels(
    row.provenance === Provenance.Bot
      ? buildBotTrace(row, model)
      : buildAgentTrace(row, model)
  ).map((turn, index) => ({ ...turn, row: index }));
  const turnCount = trace.length;
  const toolCount = trace.reduce(
    (sum, turn) =>
      sum + turn.blocks.filter((block) => block.type === "tools").length * 3,
    0
  );
  const timelineMarkers = buildTimelineMarkers(row, durationMinutes, turnCount);

  return {
    id: row.id,
    name: row.name,
    externalSessionId: row.externalSessionId,
    status: row.status,
    harness: row.harness,
    harnessLabel: HARNESS_CONFIG[row.harness].label,
    statusLabel: statusConfig.label,
    ownerName: row.user?.name ?? "Unattributed",
    model,
    autonomy: row.autonomy,
    repo: row.repo,
    branch: row.branch,
    prNumber: row.prNumber,
    prTitle: row.prTitle,
    prUrl: row.prUrl,
    prStateLabel,
    durationLabel: formatDuration(row.durationMs),
    durationMinutes,
    timelineStartMinutes: SESSION_START_MINUTES,
    costLabel: formatMoney(row.cost),
    startedLabel: formatAgo(row.startedAgoMinutes),
    workingDir: row.workingDir,
    tokensLabel: formatTokens(row.cost),
    turnCount,
    toolCount,
    linkedArtifacts: linkedArtifactsFor(row),
    timelineStartLabel: "0:00",
    timelineEndLabel: formatDuration(row.durationMs),
    costEvents: buildCostEvents(
      row.cost,
      durationMinutes,
      model,
      turnCount,
      timelineMarkers
    ),
    timelineMarkers,
    trace,
    comments: COMMENTS,
  };
}
