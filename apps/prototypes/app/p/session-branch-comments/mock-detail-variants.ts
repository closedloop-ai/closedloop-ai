import { chartColor } from "@repo/design-system/components/ui/chart-colors";
import type { FileChange, SessionLane, TraceTurn } from "./mock";
import type { BranchScenario } from "./mock-detail";
import { idleTimelineColumn, timelineColumn } from "./timeline-fixtures";

type TraceUserId = "u-alex" | "u-sam" | "u-jordan" | "u-parker";

type VariantConfig = {
  title: string;
  prompt: string;
  firstResult: string;
  followUp: string;
  finalResult: string;
  failure: string;
  ownerId: TraceUserId;
  reviewerId?: TraceUserId;
  sessionCount: number;
  files: FileChange[];
};

const ACTOR_NAMES: Record<TraceUserId, string> = {
  "u-alex": "Alex Rivera",
  "u-sam": "Sam Chen",
  "u-jordan": "Jordan Lee",
  "u-parker": "Parker Byrd",
};

const ACTOR_COLORS = [chartColor(0), chartColor(1)];

function makeVariantScenario(
  base: BranchScenario,
  config: VariantConfig
): BranchScenario {
  const reviewerId = config.reviewerId ?? config.ownerId;
  const actorIds = [config.ownerId, reviewerId];
  const sessions: SessionLane[] = Array.from(
    { length: config.sessionCount },
    (_, index) => {
      const userId = actorIds[index % actorIds.length] ?? config.ownerId;
      const startPct = Math.min(index * 14, 72);
      return {
        id: `s${index + 1}`,
        actorId: userId,
        actor: ACTOR_NAMES[userId],
        sub: `${config.title.toLowerCase().replaceAll(" ", "-")}-${index + 1}`,
        color: ACTOR_COLORS[index % ACTOR_COLORS.length] ?? ACTOR_COLORS[0],
        activeLabel: index === 0 ? "42m" : `${18 + index * 7}m`,
        startPct,
        endPct: Math.min(42 + index * 13, 100),
        bursts: [{ leftPct: startPct, widthPct: Math.max(12, 28 - index * 2) }],
      };
    }
  );
  const trace: TraceTurn[] = [
    {
      id: "t1",
      userId: config.ownerId,
      side: "human",
      timeLabel: "9:08am",
      blocks: [{ type: "p", spans: [config.prompt] }],
    },
    {
      id: "t2",
      userId: config.ownerId,
      side: "agent",
      timeLabel: "9:09am",
      durationLabel: "31m 18s",
      costLabel: "$3.84",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            config.firstResult,
            " Committed the first pass and pushed it to GitHub.",
          ],
        },
        {
          type: "tools",
          summary: "Ran 4 tools · 4 tools",
          rows: [
            { label: "Read", detail: config.files[0]?.path },
            { label: "Edit", detail: config.files[0]?.path },
            { label: "Bash", detail: "pnpm test" },
            { label: "Bash", detail: "git push origin HEAD" },
          ],
        },
      ],
    },
    {
      id: "t3",
      userId: reviewerId,
      side: "human",
      timeLabel: "9:54am",
      blocks: [{ type: "p", spans: [config.followUp] }],
    },
    {
      id: "t4",
      userId: reviewerId,
      side: "agent",
      timeLabel: "9:55am",
      durationLabel: "24m 09s",
      costLabel: "$2.76",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            config.failure,
            " ",
            config.finalResult,
            " Pushed the follow-up commit to GitHub.",
          ],
        },
        {
          type: "tools",
          summary: "Ran 3 tools · 3 tools",
          rows: [
            { label: "Edit", detail: config.files[1]?.path },
            { label: "Bash", detail: "pnpm test — all passing" },
            { label: "Bash", detail: "git push origin HEAD" },
          ],
        },
      ],
    },
  ];

  return {
    ...base,
    ...variantMetadata(config),
    prBody: config.prompt,
    files: config.files,
    sessions,
    trace,
    timelineColumns: [
      timelineColumn({ input: 1300, output: 7800, cacheRead: 131_200 }, [
        { color: ACTOR_COLORS[0], pct: 100 },
      ]),
      timelineColumn({ input: 2100, output: 11_700, cacheRead: 205_800 }, [
        { color: ACTOR_COLORS[0], pct: 60 },
        { color: ACTOR_COLORS[1], pct: 40 },
      ]),
      timelineColumn({ input: 1100, output: 6400, cacheRead: 108_400 }, [
        { color: ACTOR_COLORS[0], pct: 100 },
      ]),
      timelineColumn({ input: 1800, output: 10_400, cacheRead: 183_000 }, [
        { color: ACTOR_COLORS[1], pct: 50 },
        { color: ACTOR_COLORS[0], pct: 50 },
      ]),
      timelineColumn({ input: 2400, output: 13_200, cacheRead: 234_500 }, [
        { color: ACTOR_COLORS[1], pct: 55 },
        { color: ACTOR_COLORS[0], pct: 45 },
      ]),
      timelineColumn({ input: 1500, output: 8500, cacheRead: 148_600 }, [
        { color: ACTOR_COLORS[0], pct: 100 },
      ]),
      idleTimelineColumn(),
      timelineColumn({ input: 900, output: 5400, cacheRead: 97_400 }, [
        { color: ACTOR_COLORS[1], pct: 100 },
      ]),
    ],
    eventDots: [
      {
        leftPct: 8,
        kind: "blue",
        label: config.prompt,
        at: "09:08",
        targetTurnId: "t1",
      },
      {
        leftPct: 28,
        kind: "green",
        label: "Initial commit pushed to GitHub",
        at: "09:40",
        targetTurnId: "t2",
      },
      {
        leftPct: 48,
        kind: "red",
        label: config.failure,
        at: "09:51",
        targetTurnId: "t4",
      },
      {
        leftPct: 60,
        kind: "blue",
        label: config.followUp,
        at: "09:54",
        targetTurnId: "t3",
      },
      {
        leftPct: 72,
        kind: "green",
        label: "Follow-up commit pushed; checks passing",
        at: "10:19",
        targetTurnId: "t4",
      },
    ],
  };
}

export function buildVariantScenarios(
  base: BranchScenario
): Record<string, BranchScenario> {
  return {
    br_1270: makeVariantScenario(base, {
      title: "repository overrides migration",
      prompt:
        "Move repository overrides into workspace configuration without changing existing resolution behavior.",
      firstResult:
        "Moved override loading behind the workspace config adapter and added compatibility reads for existing records.",
      followUp:
        "The migration must preserve repository-level precedence. Add a mixed workspace and repository regression case.",
      failure: "The migration test failed on repository-level precedence.",
      finalResult:
        "Corrected the merge order and added the mixed-precedence regression case.",
      ownerId: "u-parker",
      reviewerId: "u-alex",
      sessionCount: 3,
      files: [
        {
          path: "packages/config/src/repository-overrides.ts",
          additions: 146,
          deletions: 92,
        },
        {
          path: "packages/config/src/workspace-config.ts",
          additions: 74,
          deletions: 38,
        },
        {
          path: "packages/config/src/repository-overrides.test.ts",
          additions: 41,
          deletions: 20,
        },
      ],
    }),
    br_dark_mode: makeVariantScenario(base, {
      title: "design system dark mode",
      prompt:
        "Add dark-mode tokens and migrate core surfaces without changing component APIs.",
      firstResult:
        "Added semantic dark tokens and migrated buttons, cards, inputs, and navigation to consume them.",
      followUp:
        "The muted border loses contrast in dark mode. Correct the token and cover both themes in the visual fixture.",
      failure: "The visual contrast check failed for muted borders.",
      finalResult:
        "Adjusted the semantic border token and updated the light and dark visual fixtures.",
      ownerId: "u-jordan",
      sessionCount: 2,
      files: [
        {
          path: "packages/design-system/styles/tokens.css",
          additions: 168,
          deletions: 22,
        },
        {
          path: "packages/design-system/components/theme-provider.tsx",
          additions: 82,
          deletions: 18,
        },
        {
          path: "packages/design-system/stories/dark-mode.stories.tsx",
          additions: 64,
          deletions: 18,
        },
      ],
    }),
    br_1289: makeVariantScenario(base, {
      title: "skill registry loader",
      prompt:
        "Load skill manifests from the registry with deterministic caching and clear failures for invalid manifests.",
      firstResult:
        "Added registry discovery, schema validation, and a cache keyed by manifest digest.",
      followUp:
        "A deleted manifest remains cached after refresh. Invalidate missing entries and retain the validation error context.",
      failure:
        "Registry checks failed because deleted manifests remained cached.",
      finalResult:
        "Invalidated missing entries and preserved manifest paths in validation errors; two unrelated checks remain blocked.",
      ownerId: "u-alex",
      reviewerId: "u-sam",
      sessionCount: 5,
      files: [
        {
          path: "packages/skills/src/registry-loader.ts",
          additions: 72,
          deletions: 144,
        },
        {
          path: "packages/skills/src/registry-cache.ts",
          additions: 18,
          deletions: 46,
        },
        {
          path: "packages/skills/src/registry-loader.test.ts",
          additions: 6,
          deletions: 20,
        },
      ],
    }),
    br_session_cost: makeVariantScenario(base, {
      title: "session cost rounding",
      prompt:
        "Fix session cost totals so line items and the displayed aggregate use the same rounding rule.",
      firstResult:
        "Moved rounding to the final currency boundary and added fractional-token coverage.",
      followUp:
        "Also cover the half-cent boundary and confirm the branch total matches the session rows.",
      failure:
        "The half-cent regression test exposed double rounding in the aggregate.",
      finalResult:
        "Removed intermediate rounding and verified the aggregate against its session rows.",
      ownerId: "u-jordan",
      sessionCount: 1,
      files: [
        {
          path: "packages/billing/src/session-cost.ts",
          additions: 16,
          deletions: 4,
        },
        {
          path: "packages/billing/src/session-cost.test.ts",
          additions: 8,
          deletions: 2,
        },
      ],
    }),
    br_dependabot: {
      ...base,
      activeLabel: "0m",
      comments: [],
      costSegments: [],
      costTotal: "$0",
      deliveredArtifacts: [],
      idleLabel: "0m",
      idlePct: 0,
      leadTimeMergedLabel: "0m",
      prBody: "Bumps Next.js from 15.3.4 to 15.4.2.",
      valuePerDollar: "0.00",
      waterfall: [],
      files: [
        { path: "package.json", additions: 1, deletions: 1 },
        { path: "pnpm-lock.yaml", additions: 11, deletions: 11 },
      ],
      sessions: [],
      trace: [],
      timelineColumns: base.timelineColumns.map(idleTimelineColumn),
      eventDots: [],
    },
  };
}

function variantMetadata(
  config: VariantConfig
): Pick<
  BranchScenario,
  | "activeLabel"
  | "comments"
  | "costSegments"
  | "costTotal"
  | "deliveredArtifacts"
  | "idleLabel"
  | "idlePct"
  | "leadTimeMergedLabel"
  | "valuePerDollar"
  | "waterfall"
> {
  const activeMinutes = 38 + config.sessionCount * 17;
  const idleMinutes = 8 + config.sessionCount * 4;
  const totalMinutes = activeMinutes + idleMinutes;
  const totalCost = 90 + config.sessionCount * 83;
  const reviewPct = config.reviewerId ? 18 : 8;
  const reworkPct = config.reviewerId ? 16 : 7;
  const buildPct = 100 - reviewPct - reworkPct;

  return {
    activeLabel: formatDuration(activeMinutes),
    comments: [],
    costSegments: [
      {
        key: "build",
        label: "Build",
        duration: formatDuration(Math.round((activeMinutes * buildPct) / 100)),
        cost: `$${Math.round((totalCost * buildPct) / 100)}`,
        pct: buildPct,
        color: "#4f7df0",
      },
      {
        key: "review",
        label: "Review",
        duration: formatDuration(Math.round((activeMinutes * reviewPct) / 100)),
        cost: `$${Math.round((totalCost * reviewPct) / 100)}`,
        pct: reviewPct,
        color: "#8b5cf6",
      },
      {
        key: "rework",
        label: "Rework",
        duration: formatDuration(Math.round((activeMinutes * reworkPct) / 100)),
        cost: `$${Math.round((totalCost * reworkPct) / 100)}`,
        pct: reworkPct,
        color: "#c2412d",
      },
    ],
    costTotal: `$${totalCost}`,
    deliveredArtifacts: [],
    idleLabel: formatDuration(idleMinutes),
    idlePct: Math.round((idleMinutes / totalMinutes) * 100),
    leadTimeMergedLabel: formatDuration(totalMinutes),
    valuePerDollar: (3.4 + config.sessionCount * 0.71).toFixed(2),
    waterfall: [
      { type: "build", pct: buildPct },
      { type: "review", pct: reviewPct },
      { type: "rework", pct: reworkPct },
    ],
  };
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours > 0
    ? `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`
    : `${remainingMinutes}m`;
}
