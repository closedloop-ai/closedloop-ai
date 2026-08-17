// Per-branch detail fixtures + the builder that assembles a BranchDetail from a
// list row. Split out of mock.ts to stay under the 1000-line file ceiling.
import { chartColor } from "@repo/design-system/components/ui/chart-colors";
import { applyCanonicalBranchCosts } from "./branch-cost-fixtures";
import {
  applyFileCoverageFixture,
  completeFileEvidence,
} from "./file-coverage-fixtures";
import {
  BranchCostAvailability,
  type BranchDetail,
  type BranchRow,
  BranchStatus,
  type CostSegment,
  type EventDot,
  type FileChange,
  type PrComment,
  type PrCommentsAvailability,
  type SessionLane,
  type TimelineColumn,
  type TraceTurn,
  type WaterfallSeg,
} from "./mock";
import {
  buildSessionComments,
  getPrComments,
  SEED_PROVIDER_AVAILABILITY,
  SEED_PROVIDER_COMMENTS,
} from "./mock-comments";
import { INBOX_SCENARIO } from "./mock-detail-inbox";
import { reconcileBranchScenario } from "./mock-detail-reconciliation";
import { buildVariantScenarios } from "./mock-detail-variants";
import { alignPhaseDurations } from "./phase-durations";
import { STRUCTURED_PR_DESCRIPTION } from "./pr-description-fixtures";
import { buildSelectedPullRequest } from "./selected-pull-request";
import { idleTimelineColumn, timelineColumn } from "./timeline-fixtures";

const ACTOR_COLORS = Array.from({ length: 10 }, (_, index) =>
  chartColor(index)
);

/**
 * A per-branch detail scenario. Each scenario is internally consistent: its
 * trace actors, swimlane sessions, and timeline legend all describe the same
 * set of sessions, and its files/comments/PR body describe the same change. The
 * detail builder overlays the row's identity (name, repo, status, PR) on top so
 * the header always matches the list, while the deep data stays branch-specific
 * (not one canned fixture shared across every branch).
 */
export type BranchScenario = {
  prBody: string;
  selectedPrBody?: string | null;
  costTotal: string;
  valuePerDollar: string;
  leadTimeMergedLabel: string;
  activeLabel: string;
  idleLabel: string;
  idlePct: number;
  waterfall: WaterfallSeg[];
  costSegments: CostSegment[];
  deliveredArtifacts: { slug: string }[];
  files: FileChange[];
  comments: PrComment[];
  commentsAvailability?: PrCommentsAvailability;
  sessions: SessionLane[];
  trace: TraceTurn[];
  timelineColumns: TimelineColumn[];
  startLabel: string;
  endLabel: string;
  eventDots: EventDot[];
};

const SEED_SCENARIO: BranchScenario = {
  prBody: `Adds a synthetic seed generator so local + CI fixtures can be regenerated deterministically instead of hand-maintained.

- New \`SyntheticGenerator\` walks the org/document/loop tables and emits believable rows
- Batch size is clamped (floor 1, ceiling 500) so a large org set can't exhaust the worker
- Seed config is a const-object enum; wire format unchanged
- Adds coverage for the clamp and the empty-org case

Testing: pnpm --filter database test, pnpm --filter api test`,
  costTotal: "$904",
  valuePerDollar: "5.98",
  leadTimeMergedLabel: "1h 39m",
  activeLabel: "1h 12m",
  idleLabel: "27m",
  idlePct: 24,
  waterfall: [
    { type: "build", pct: 32 },
    { type: "idle", pct: 10 },
    { type: "review", pct: 8 },
    { type: "idle", pct: 14 },
    { type: "rework", pct: 20 },
    { type: "review", pct: 16 },
  ],
  costSegments: [
    {
      key: "build",
      label: "Build",
      duration: "50m",
      cost: "$688",
      pct: 76,
      color: "#4f7df0",
    },
    {
      key: "review",
      label: "Review",
      duration: "8m",
      cost: "$120",
      pct: 13,
      color: "#8b5cf6",
    },
    {
      key: "rework",
      label: "Rework",
      duration: "14m",
      cost: "$96",
      pct: 11,
      color: "#c2412d",
    },
  ],
  deliveredArtifacts: [{ slug: "FEA-3842" }, { slug: "PLN-1148" }],
  files: [
    {
      path: "packages/database/seed/synthetic-generator.ts",
      additions: 214,
      deletions: 4,
    },
    { path: "packages/database/seed/index.ts", additions: 38, deletions: 12 },
    {
      path: "apps/api/lib/fixtures/seed-config.ts",
      additions: 96,
      deletions: 8,
    },
    {
      path: "apps/api/__tests__/seed-generator.test.ts",
      additions: 52,
      deletions: 0,
    },
    { path: "packages/database/AGENTS.md", additions: 12, deletions: 14 },
  ],
  comments: SEED_PROVIDER_COMMENTS,
  commentsAvailability: SEED_PROVIDER_AVAILABILITY,
  sessions: [
    {
      id: "s1",
      actorId: "u-alex",
      actor: "Alex Rivera",
      sub: "synthetic-seed-generator",
      color: ACTOR_COLORS[0],
      activeLabel: "1h 27m",
      startPct: 0,
      endPct: 62,
      bursts: [
        { leftPct: 0, widthPct: 18 },
        { leftPct: 26, widthPct: 22 },
        { leftPct: 54, widthPct: 8 },
      ],
    },
    {
      id: "s2",
      actorId: "u-sam",
      actor: "Sam Chen",
      sub: "build + tests follow-up",
      color: ACTOR_COLORS[1],
      activeLabel: "58m",
      startPct: 20,
      endPct: 78,
      bursts: [
        { leftPct: 20, widthPct: 30 },
        { leftPct: 62, widthPct: 16 },
      ],
    },
    {
      id: "s3",
      actorId: "u-alex",
      actor: "Alex Rivera",
      sub: "coverage follow-up",
      color: ACTOR_COLORS[2],
      isResumed: true,
      activeLabel: "22m",
      startPct: 58,
      endPct: 74,
      bursts: [{ leftPct: 58, widthPct: 16 }],
    },
    {
      id: "s4",
      actorId: "u-sam",
      actor: "Sam Chen",
      sub: "review fixes + checks",
      color: ACTOR_COLORS[3],
      isCi: true,
      activeLabel: "9m",
      startPct: 80,
      endPct: 100,
      bursts: [{ leftPct: 80, widthPct: 20 }],
    },
  ],
  trace: [
    {
      id: "t1",
      userId: "u-alex",
      side: "human",
      timeLabel: "9:14am",
      blocks: [
        {
          type: "p",
          spans: [
            "Build a synthetic seed generator so we can regenerate local and CI fixtures deterministically instead of hand-maintaining them.",
          ],
        },
      ],
    },
    {
      id: "t2",
      userId: "u-alex",
      side: "agent",
      timeLabel: "9:15am",
      durationLabel: "16m 12s",
      costLabel: "$4.10",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            "I read the schema and mapped the ",
            { code: "org" },
            " / ",
            { code: "document" },
            " / ",
            { code: "loop" },
            " tables to generate against. The generator walks each table and emits believable rows.",
          ],
        },
        {
          type: "tools",
          summary: "Ran 5 tools · 5 tool",
          rows: [
            { label: "Read", detail: "packages/database/prisma/schema.prisma" },
            { label: "Grep", detail: "organizationId across seed/*" },
            {
              label: "Edit",
              detail: "packages/database/seed/synthetic-generator.ts",
            },
            { label: "Bash", detail: "pnpm --filter database test — 2 failed" },
            {
              label: "Bash",
              detail: "pnpm --filter database test — 20 passed",
            },
          ],
        },
        {
          type: "p",
          spans: [
            "The batch size needs a floor and ceiling, otherwise an unbounded loop over the org set can exhaust the db-host worker heap:",
          ],
        },
        {
          type: "ul",
          items: [
            [
              "Clamp to ",
              { code: "Math.max(1, Math.min(500, n))" },
              " before the write loop.",
            ],
            ["Seed config stays a const-object enum; wire format unchanged."],
            ["Added coverage for the clamp and the empty-org case."],
          ],
        },
        {
          type: "p",
          spans: [
            "Committed the initial implementation and pushed ",
            { code: "agent/synthetic-seed-generator" },
            " to GitHub.",
          ],
        },
      ],
    },
    {
      id: "t3",
      userId: "u-sam",
      side: "human",
      timeLabel: "9:36am",
      blocks: [
        {
          type: "p",
          spans: ["Good. Open the PR and request review from the stage bot."],
        },
      ],
    },
    {
      id: "t4",
      userId: "u-sam",
      side: "agent",
      timeLabel: "9:37am",
      durationLabel: "11m 04s",
      costLabel: "$3.62",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            "Opened ",
            { pr: 1284 },
            " and requested review. The first CI run failed two database tests because the empty-org fixture did not provide a default batch size.",
          ],
        },
        {
          type: "tools",
          summary: "Ran 3 tools · 3 tools",
          rows: [
            { label: "Bash", detail: "gh pr create --fill" },
            { label: "Bash", detail: "gh pr checks 1284 --watch" },
            {
              label: "Bash",
              detail: "pnpm --filter database test — 2 failed",
            },
          ],
        },
      ],
    },
    {
      id: "t5",
      userId: "u-sam",
      side: "agent",
      timeLabel: "9:53am",
      durationLabel: "8m 41s",
      costLabel: "$2.94",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            "The previous session reached its context limit while tracing the CI failure. I resumed from its handoff, reproduced both failures locally, and isolated the missing default in ",
            { code: "seed-config.ts" },
            ".",
          ],
        },
        {
          type: "tools",
          summary: "Ran 2 tools · 2 tools",
          rows: [
            {
              label: "Read",
              detail: "handoff from session s2",
            },
            {
              label: "Bash",
              detail: "pnpm --filter database test -- seed-generator",
            },
          ],
        },
      ],
    },
    {
      id: "t6",
      userId: "u-sam",
      side: "human",
      timeLabel: "10:02am",
      blocks: [
        {
          type: "p",
          spans: [
            "Use the same clamped default for empty orgs, add the regression test, and push the fix to the PR.",
          ],
        },
      ],
    },
    {
      id: "t7",
      userId: "u-sam",
      side: "agent",
      timeLabel: "10:03am",
      durationLabel: "23m 08s",
      costLabel: "$7.31",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            "Applied the default before clamping, added the empty-org regression test, and pushed the review fix to GitHub. All required checks now pass on ",
            { pr: 1284 },
            ".",
          ],
        },
        {
          type: "tools",
          summary: "Ran 4 tools · 4 tools",
          rows: [
            { label: "Edit", detail: "apps/api/lib/fixtures/seed-config.ts" },
            {
              label: "Edit",
              detail: "apps/api/__tests__/seed-generator.test.ts",
            },
            {
              label: "Bash",
              detail: "git push origin agent/synthetic-seed-generator",
            },
            { label: "Bash", detail: "gh pr checks 1284 — all passing" },
          ],
        },
      ],
    },
  ],
  timelineColumns: [
    timelineColumn({ input: 1200, output: 7200, cacheRead: 125_800 }, [
      { color: ACTOR_COLORS[0], pct: 100 },
    ]),
    timelineColumn({ input: 2100, output: 11_400, cacheRead: 206_100 }, [
      { color: ACTOR_COLORS[0], pct: 62 },
      { color: ACTOR_COLORS[1], pct: 38 },
    ]),
    timelineColumn({ input: 900, output: 6800, cacheRead: 108_200 }, [
      { color: ACTOR_COLORS[0], pct: 100 },
    ]),
    timelineColumn({ input: 2800, output: 15_600, cacheRead: 256_100 }, [
      { color: ACTOR_COLORS[1], pct: 70 },
      { color: ACTOR_COLORS[0], pct: 30 },
    ]),
    timelineColumn({ input: 1700, output: 9400, cacheRead: 165_800 }, [
      { color: ACTOR_COLORS[1], pct: 55 },
      { color: ACTOR_COLORS[2], pct: 45 },
    ]),
    timelineColumn({ input: 1300, output: 7500, cacheRead: 131_500 }, [
      { color: ACTOR_COLORS[1], pct: 58 },
      { color: ACTOR_COLORS[0], pct: 42 },
    ]),
    idleTimelineColumn(),
    timelineColumn({ input: 800, output: 5100, cacheRead: 97_800 }, [
      { color: ACTOR_COLORS[3], pct: 100 },
    ]),
  ],
  startLabel: "09:02",
  endLabel: "10:41",
  eventDots: [
    {
      leftPct: 12,
      kind: "blue",
      label: "Build the synthetic seed generator",
      at: "09:14",
      targetTurnId: "t1",
    },
    {
      leftPct: 30,
      kind: "green",
      label: "Initial commit pushed to GitHub",
      at: "09:31",
      targetTurnId: "t2",
    },
    {
      leftPct: 41,
      kind: "red",
      label: "CI failed — 2 tests",
      at: "09:48",
      targetTurnId: "t4",
    },
    {
      leftPct: 34,
      kind: "blue",
      label: "Open the PR and request review",
      at: "09:36",
      targetTurnId: "t3",
    },
    {
      leftPct: 52,
      kind: "red",
      label: "Session context limit reached",
      at: "09:52",
      targetTurnId: "t5",
    },
    {
      leftPct: 60,
      kind: "blue",
      label: "Fix the empty-org default and push",
      at: "10:02",
      targetTurnId: "t6",
    },
    {
      leftPct: 68,
      kind: "green",
      label: "Review fix pushed to GitHub",
      at: "10:09",
      targetTurnId: "t7",
    },
    {
      leftPct: 72,
      kind: "green",
      label: "CI passing",
      at: "10:26",
      targetTurnId: "t7",
    },
  ],
};

const SAML_SCENARIO: BranchScenario = {
  prBody: `Implements SAML SSO end to end: metadata exchange, assertion validation, and JIT provisioning.

- Adds the SAML strategy behind the existing auth port
- Validates signed assertions with a timing-safe comparison
- Provisions users on first login and maps IdP groups to org roles

Testing: pnpm --filter api test, pnpm --filter auth test`,
  selectedPrBody: STRUCTURED_PR_DESCRIPTION,
  costTotal: "$1,286",
  valuePerDollar: "4.11",
  leadTimeMergedLabel: "6h 22m",
  activeLabel: "4h 40m",
  idleLabel: "1h 42m",
  idlePct: 27,
  waterfall: [
    { type: "build", pct: 26 },
    { type: "idle", pct: 16 },
    { type: "build", pct: 18 },
    { type: "review", pct: 10 },
    { type: "idle", pct: 11 },
    { type: "rework", pct: 12 },
    { type: "review", pct: 7 },
  ],
  costSegments: [
    {
      key: "build",
      label: "Build",
      duration: "2h 42m",
      cost: "$748",
      pct: 58,
      color: "#4f7df0",
    },
    {
      key: "review",
      label: "Review",
      duration: "1h 12m",
      cost: "$332",
      pct: 26,
      color: "#8b5cf6",
    },
    {
      key: "rework",
      label: "Rework",
      duration: "46m",
      cost: "$206",
      pct: 16,
      color: "#c2412d",
    },
  ],
  deliveredArtifacts: [{ slug: "FEA-3701" }, { slug: "PLN-1290" }],
  files: [
    {
      path: "packages/auth/src/strategies/saml.ts",
      additions: 268,
      deletions: 6,
    },
    {
      path: "apps/api/app/auth/saml/callback/route.ts",
      additions: 142,
      deletions: 12,
    },
    {
      path: "packages/auth/src/provisioning/jit.ts",
      additions: 96,
      deletions: 18,
    },
    {
      path: "apps/api/__tests__/saml-callback.test.ts",
      additions: 74,
      deletions: 0,
    },
  ],
  comments: [
    {
      id: "c1",
      author: "parker-byrd",
      at: "6h ago",
      path: "packages/auth/src/strategies/saml.ts",
      line: 130,
      anchorPreview: "if (signature === expected) {",
      body: "Use the timing-safe compare for the signature check, not ===.",
    },
    {
      id: "c2",
      author: "sam-chen",
      at: "5h ago",
      body: "Pushed the timing-safe compare and a test for a tampered assertion.",
    },
  ],
  sessions: [
    {
      id: "s1",
      actorId: "u-sam",
      actor: "Sam Chen",
      sub: "saml-sso-implementation",
      color: ACTOR_COLORS[0],
      activeLabel: "3h 12m",
      startPct: 0,
      endPct: 70,
      bursts: [
        { leftPct: 0, widthPct: 20 },
        { leftPct: 28, widthPct: 24 },
        { leftPct: 60, widthPct: 10 },
      ],
    },
    {
      id: "s2",
      actorId: "u-parker",
      actor: "Parker Byrd",
      sub: "strategy + provisioning review",
      color: ACTOR_COLORS[1],
      activeLabel: "1h 08m",
      startPct: 24,
      endPct: 82,
      bursts: [
        { leftPct: 24, widthPct: 22 },
        { leftPct: 64, widthPct: 12 },
      ],
    },
    {
      id: "s3",
      actorId: "u-parker",
      actor: "Parker Byrd",
      sub: "assertion review follow-up",
      color: ACTOR_COLORS[2],
      activeLabel: "34m",
      startPct: 66,
      endPct: 88,
      bursts: [{ leftPct: 66, widthPct: 22 }],
    },
  ],
  trace: [
    {
      id: "t1",
      userId: "u-sam",
      side: "human",
      timeLabel: "8:10am",
      blocks: [
        {
          type: "p",
          spans: [
            "Implement SAML SSO end to end: metadata exchange, assertion validation, and JIT provisioning.",
          ],
        },
      ],
    },
    {
      id: "t2",
      userId: "u-sam",
      side: "agent",
      timeLabel: "8:11am",
      durationLabel: "1h 13m",
      costLabel: "$3.40",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            "Added the SAML strategy behind the existing auth port and wired the callback route. First pass compared the assertion signature with ",
            { code: "===" },
            ".",
          ],
        },
        {
          type: "tools",
          summary: "Ran 4 tools · 4 tool",
          rows: [
            { label: "Edit", detail: "packages/auth/src/strategies/saml.ts" },
            {
              label: "Edit",
              detail: "apps/api/app/auth/saml/callback/route.ts",
            },
            { label: "Edit", detail: "packages/auth/src/provisioning/jit.ts" },
            { label: "Bash", detail: "pnpm --filter auth test — 1 failed" },
          ],
        },
      ],
    },
    {
      id: "t-ci",
      userId: "u-sam",
      side: "agent",
      timeLabel: "11:10am",
      durationLabel: "7m 14s",
      costLabel: "$0.92",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            "The auth test failed because the first pass compared the decoded signature directly. I left the failing run attached for security review before changing the validation path.",
          ],
        },
      ],
    },
    {
      id: "t3",
      userId: "u-parker",
      side: "human",
      timeLabel: "12:02pm",
      blocks: [
        {
          type: "p",
          spans: [
            "Security review flagged the signature check. Use a timing-safe compare, not ",
            { code: "===" },
            ", and add a test for a tampered assertion.",
          ],
        },
      ],
    },
    {
      id: "t4",
      userId: "u-parker",
      side: "agent",
      timeLabel: "12:03pm",
      durationLabel: "38m 41s",
      costLabel: "$2.06",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            "Switched to ",
            { code: "crypto.timingSafeEqual" },
            " and added a tampered-assertion test. ",
            { pr: 1290 },
            " is green now.",
          ],
        },
        {
          type: "tools",
          summary: "Ran 3 tools · 3 tool",
          rows: [
            { label: "Edit", detail: "packages/auth/src/strategies/saml.ts" },
            {
              label: "Edit",
              detail: "apps/api/__tests__/saml-callback.test.ts",
            },
            { label: "Bash", detail: "pnpm --filter auth test — all passing" },
          ],
        },
      ],
    },
    {
      id: "t5",
      userId: "u-parker",
      side: "agent",
      timeLabel: "1:40pm",
      durationLabel: "4m 12s",
      costLabel: "$0.48",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            "The timing-safe assertion test and the full authentication suite are passing on ",
            { pr: 1290 },
            ".",
          ],
        },
      ],
    },
  ],
  timelineColumns: [
    timelineColumn({ input: 1400, output: 8400, cacheRead: 136_600 }, [
      { color: ACTOR_COLORS[0], pct: 100, sessionId: "s1" },
    ]),
    timelineColumn({ input: 2300, output: 12_900, cacheRead: 228_800 }, [
      { color: ACTOR_COLORS[0], pct: 50, sessionId: "s1" },
      { color: ACTOR_COLORS[1], pct: 50, sessionId: "s2" },
    ]),
    idleTimelineColumn(),
    timelineColumn({ input: 1900, output: 10_600, cacheRead: 182_700 }, [
      { color: ACTOR_COLORS[1], pct: 70, sessionId: "s2" },
      { color: ACTOR_COLORS[0], pct: 30, sessionId: "s1" },
    ]),
    timelineColumn({ input: 2100, output: 11_800, cacheRead: 205_700 }, [
      { color: ACTOR_COLORS[2], pct: 60, sessionId: "s3" },
      { color: ACTOR_COLORS[1], pct: 40, sessionId: "s2" },
    ]),
    timelineColumn({ input: 1000, output: 6200, cacheRead: 102_600 }, [
      { color: ACTOR_COLORS[0], pct: 100, sessionId: "s1" },
    ]),
  ],
  startLabel: "08:10",
  endLabel: "14:32",
  eventDots: [
    {
      leftPct: 7,
      kind: "blue",
      label: "Implement SAML SSO end to end",
      at: "08:10",
      targetTurnId: "t1",
    },
    {
      leftPct: 30,
      kind: "green",
      label: "First commit",
      at: "09:24",
      targetTurnId: "t2",
    },
    {
      leftPct: 55,
      kind: "red",
      label: "CI failed — auth test",
      at: "11:10",
      targetTurnId: "t-ci",
    },
    {
      leftPct: 68,
      kind: "blue",
      label: "Review assertion validation",
      at: "12:02",
      targetTurnId: "t3",
    },
    {
      leftPct: 90,
      kind: "green",
      label: "CI passing",
      at: "13:40",
      targetTurnId: "t5",
    },
  ],
};

const SCENARIOS: Record<string, BranchScenario> = {
  br_1281: INBOX_SCENARIO,
  br_files_zero: { ...SEED_SCENARIO, files: [] },
  br_saml: SAML_SCENARIO,
  ...buildVariantScenarios(SEED_SCENARIO),
};

/**
 * Build a populated detail fixture for a given list row. The header identity
 * (name, repo, status, PR) is seeded from the row; the deep data comes from a
 * branch-specific scenario (with a default), reconciled so the session count,
 * trace, swimlane, and timeline agree.
 */
export function buildBranchDetail(
  row: BranchRow,
  options: { useFileCoverageFixtures?: boolean } = {}
): BranchDetail {
  const merged = row.status === BranchStatus.Merged;
  const scenario = SCENARIOS[row.id] ?? SEED_SCENARIO;
  const count = SCENARIOS[row.id] ? scenario.sessions.length : row.sessionCount;
  const { sessions, trace, legend, columns, eventDots } =
    reconcileBranchScenario(scenario, count);
  const costSegments = alignPhaseDurations(
    scenario.costSegments,
    scenario.waterfall,
    scenario.leadTimeMergedLabel
  );
  const fileEvidence = options.useFileCoverageFixtures
    ? applyFileCoverageFixture(row.id, scenario.files)
    : completeFileEvidence(scenario.files);

  const detail: BranchDetail = {
    id: row.id,
    branchName: row.branchName,
    repoFullName: row.repo,
    status: row.status,
    provenance: row.provenance,
    prNumber: row.prNumber,
    prTitle: row.prTitle,
    prUrl: row.prUrl,
    prState: row.prState,
    prBody: row.prNumber ? scenario.prBody : null,
    selectedPullRequest: buildSelectedPullRequest(row, scenario.selectedPrBody),
    additions: row.additions,
    deletions: row.deletions,
    costLabel: scenario.costTotal,
    rawCostUsd: null,
    attributedCostUsd: null,
    costAvailability: BranchCostAvailability.Unavailable,
    costDisclosure: null,
    valuePerDollar: scenario.valuePerDollar,
    leadTimeLabel: merged ? scenario.leadTimeMergedLabel : "in progress",
    wallClockLabel: scenario.leadTimeMergedLabel,
    activeLabel: scenario.activeLabel,
    idleLabel: scenario.idleLabel,
    idlePct: scenario.idlePct,
    merged,
    waterfall: scenario.waterfall,
    costTotal: scenario.costTotal,
    costSegments,
    deliveredArtifacts: scenario.deliveredArtifacts,
    reviewLabel:
      row.status === BranchStatus.Blocked ? "1 change requested" : "1 approval",
    checks:
      row.checksTotal == null
        ? null
        : { passed: row.checksPassed ?? 0, total: row.checksTotal },
    files: fileEvidence.files,
    fileCoverage: fileEvidence.coverage,
    filesSource: row.prNumber ? "github" : "local",
    comments: getPrComments(
      row.id,
      scenario.comments,
      Boolean(row.commentCount)
    ),
    commentsAvailability:
      row.prNumber && row.commentCount
        ? scenario.commentsAvailability
        : undefined,
    sessionComments: buildSessionComments(row.id, sessions),
    sessions,
    timeline: {
      legend,
      columns,
      startLabel: scenario.startLabel,
      endLabel: scenario.endLabel,
    },
    eventDots,
    githubConnected: row.prNumber != null,
    trace,
    multiPrWarning: false,
    linkedPrNumbers: row.prNumber ? [row.prNumber] : [],
  };
  return applyCanonicalBranchCosts(detail, row);
}
