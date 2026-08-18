/**
 * Presentational fixtures for the Packs UX — used by Storybook stories and
 * component tests. Not shipped to any real surface; the data adapters produce
 * `PackView`s from live IPC / cloud data at runtime.
 */

import {
  DistributionMode,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import {
  type PackActivityEvent,
  PackContentKind,
  type PackUser,
  type PackView,
} from "./pack-view";

const user = (id: string, name: string, color: string): PackUser => ({
  id,
  name,
  initials: name
    .split(" ")
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase(),
  color,
});

export const mockPackUsers: PackUser[] = [
  user("u-maya", "Maya Chen", "#e11d48"),
  user("u-devon", "Devon Park", "#6366f1"),
  user("u-sasha", "Sasha Ortiz", "#10b981"),
  user("u-imani", "Imani Reid", "#f59e0b"),
  user("u-kenji", "Kenji Tan", "#8b5cf6"),
  user("u-ada", "Ada Nunez", "#0891b2"),
  user("u-parker", "Parker Byrd", "#db2777"),
  user("u-tomas", "Tomas Vidal", "#2563eb"),
];

export const mockPackViews: PackView[] = [
  {
    id: "code",
    name: "code",
    publisher: "closedloop-ai",
    category: "Coding",
    description:
      "Plan, code, and execute — the core ClosedLoop coding plugin bundling planning agents, review, and slash commands.",
    githubUrl: "https://github.com/closedloop-ai/claude-plugins",
    stars: 2140,
    starHistory: [1800, 1900, 1980, 2010, 2075, 2100, 2120, 2140],
    verified: true,
    harnesses: ["claude", "codex"],
    installedHarnesses: ["claude"],
    installedByMe: true,
    usageCount: 1284,
    contents: [
      {
        name: "plan-agent",
        kind: PackContentKind.Agent,
        description: "Designs implementation plans",
        content:
          "# Plan agent\n\nDesign implementation plans from ticket scope.",
      },
      {
        name: "code-reviewer",
        kind: PackContentKind.Agent,
        description: "Reviews diffs for bugs",
      },
      {
        name: "build-validator",
        kind: PackContentKind.Agent,
        description: "Runs project checks",
      },
      {
        name: "/code",
        kind: PackContentKind.Command,
        description: "Begin a coding session",
      },
      {
        name: "/create-plan",
        kind: PackContentKind.Command,
        description: "Create an implementation plan",
      },
      {
        name: "extract-plan-md",
        kind: PackContentKind.Skill,
        description: "Sync plan.md with plan.json",
      },
      {
        name: "pre-commit",
        kind: PackContentKind.Hook,
        description: "Runs before each commit",
      },
    ],
    teamUsage: {
      installers: mockPackUsers,
      installedCount: mockPackUsers.length,
      teamSize: mockPackUsers.length,
      deviceCount: 12,
      installTrend: [3, 4, 4, 5, 6, 6, 7, 8],
    },
    performance: {
      locPerDollar: 3.2,
      locDelta: 18,
      successRate: 74,
      successDelta: 9,
      tokenEfficiencyDelta: 12,
      efficiencyTrend: [4, 5, 5, 6, 6, 7, 7, 8],
      invocations: 1284,
      sessions: 412,
      mergedPrs: 96,
      qualityScore: null,
      qualityDelta: null,
      usageTrend: [8, 10, 12, 11, 14, 15, 17, 18],
    },
    distribution: {
      id: "dist-code",
      mode: DistributionMode.AutoInstall,
      targetingType: DistributionTargetingType.All,
      desiredEnabled: true,
      targetCount: 8,
      installedCount: 8,
      pendingCount: 0,
      failedCount: 0,
      targetingEntries: [],
      adoptionLoaded: true,
      targets: mockPackUsers.map((u, i) => ({
        id: `t-${i}`,
        user: u,
        status: DistributionTargetStatusValue.Installed,
      })),
    },
  },
  {
    id: "posthog",
    name: "posthog",
    publisher: "posthog",
    category: "Analytics",
    description:
      "Product analytics for agents — query PostHog, build insights, and wire event capture from a session.",
    githubUrl: "https://github.com/posthog/posthog",
    stars: 3420,
    starHistory: [3000, 3100, 3180, 3250, 3300, 3360, 3400, 3420],
    verified: true,
    harnesses: ["claude"],
    installedHarnesses: [],
    installedByMe: false,
    usageCount: 210,
    contents: [
      {
        name: "analytics-expert",
        kind: PackContentKind.Agent,
        description: "Answers analytics questions",
      },
      {
        name: "query-insights",
        kind: PackContentKind.Skill,
        description: "Builds PostHog insights",
      },
      {
        name: "posthog-mcp",
        kind: PackContentKind.Mcp,
        description: "PostHog MCP server",
      },
    ],
    teamUsage: {
      installers: mockPackUsers.slice(0, 4),
      notInstalled: mockPackUsers.slice(4),
      installedCount: 4,
      teamSize: mockPackUsers.length,
      deviceCount: 5,
      installTrend: [0, 1, 1, 2, 2, 3, 3, 4],
    },
    performance: {
      locPerDollar: 1.4,
      locDelta: -6,
      successRate: 58,
      successDelta: -3,
      tokenEfficiencyDelta: 5,
      efficiencyTrend: [2, 2, 3, 3, 3, 4, 4, 4],
      invocations: 210,
      sessions: 63,
      mergedPrs: 14,
      qualityScore: null,
      qualityDelta: null,
      usageTrend: [2, 3, 3, 4, 5, 5, 6, 6],
    },
    distribution: null,
  },
  {
    id: "self-learning",
    name: "self-learning",
    publisher: "closedloop-ai",
    category: "Automation",
    description: "Capture and reuse org patterns across sessions.",
    githubUrl: "https://github.com/closedloop-ai/claude-plugins",
    stars: 540,
    starHistory: [400, 430, 460, 480, 500, 515, 530, 540],
    verified: false,
    harnesses: ["claude"],
    installedHarnesses: [],
    installedByMe: false,
    usageCount: 63,
    contents: [
      {
        name: "process-learnings",
        kind: PackContentKind.Skill,
        description: "Process pending learnings",
      },
      {
        name: "toon-format",
        kind: PackContentKind.Skill,
        description: "Parse/emit TOON",
      },
      {
        name: "post-run",
        kind: PackContentKind.Hook,
        description: "Captures learnings after a run",
      },
    ],
    teamUsage: {
      installers: mockPackUsers.slice(2, 5),
      notInstalled: [...mockPackUsers.slice(0, 2), ...mockPackUsers.slice(5)],
      installedCount: 3,
      teamSize: mockPackUsers.length,
      installTrend: [0, 0, 1, 1, 2, 2, 3, 3],
    },
    performance: null,
    distribution: null,
  },
];

export const mockPackActivity: PackActivityEvent[] = [
  {
    id: "a1",
    user: mockPackUsers[5],
    action: "installed",
    packId: "posthog",
    packName: "posthog",
    agoLabel: "12 minutes ago",
  },
  {
    id: "a2",
    user: mockPackUsers[4],
    action: "installed",
    packId: "self-learning",
    packName: "self-learning",
    agoLabel: "1 hour ago",
  },
  {
    id: "a3",
    user: mockPackUsers[0],
    action: "updated to a new version of",
    packId: "code",
    packName: "code",
    agoLabel: "2 hours ago",
  },
];

// A minimal same-named `PackView` for the collision-state fixture below.
function collidingPack(
  overrides: Partial<PackView> & { id: string; name: string }
): PackView {
  return {
    publisher: "closedloop-ai",
    verified: false,
    harnesses: ["claude"],
    installedHarnesses: [],
    installedByMe: false,
    stars: 40,
    contents: [],
    teamUsage: {
      installers: mockPackUsers.slice(0, 4),
      installedCount: 4,
      teamSize: mockPackUsers.length,
      installTrend: [1, 2, 2, 3, 3, 4, 4, 4],
    },
    ...overrides,
  };
}

/**
 * Two same-named packs on every disambiguation axis, so the collision-state
 * story renders how each qualifier reads (FEA-3972): a category split, a version
 * split, and the person-actionable last resort (distinct publishers).
 */
export const mockCollidingPackViews: PackView[] = [
  collidingPack({
    id: "0192f000-a1b2-7c00-8000-000000000001",
    name: "test-strategist",
    category: PackContentKind.Agent,
    description: "Same name, different kind — disambiguated by category.",
  }),
  collidingPack({
    id: "0192f000-a1b2-7c00-8000-000000000002",
    name: "test-strategist",
    category: PackContentKind.Skill,
    description: "Same name, different kind — disambiguated by category.",
  }),
  collidingPack({
    id: "0192f000-a1b2-7c00-8000-000000000003",
    name: "release-captain",
    category: PackContentKind.Agent,
    version: "1.4.0",
    description: "Same name and kind — disambiguated by version.",
  }),
  collidingPack({
    id: "0192f000-a1b2-7c00-8000-000000000004",
    name: "release-captain",
    category: PackContentKind.Agent,
    version: "2.0.0",
    description: "Same name and kind — disambiguated by version.",
  }),
  collidingPack({
    id: "0192f000-a1b2-7c00-8000-000000000005",
    name: "audit-ledger",
    category: PackContentKind.Agent,
    version: "1.0.0",
    publisher: "acme-labs",
    description: "Name, kind, and version all match — last resort: publisher.",
  }),
  collidingPack({
    id: "0192f000-a1b2-7c00-8000-000000000006",
    name: "audit-ledger",
    category: PackContentKind.Agent,
    version: "1.0.0",
    publisher: "globex",
    description: "Name, kind, and version all match — last resort: publisher.",
  }),
];
