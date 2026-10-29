import {
  type AgentComponent,
  type AgentComponentDetail,
  AgentComponentKind,
  type AgentComponentListResponse,
  ComponentResolvedState,
  type ComponentVersion,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import type {
  TokenTrendPoint,
  TokenTrendResponse,
} from "@repo/api/src/types/agent-component-analytics";
import {
  mixedAgentSessionListFixtures,
  populatedAgentSessionListFixtures,
} from "@repo/app/agents/components/sessions/session-list-fixtures";
import {
  makeComponent,
  makeDetail,
} from "@repo/app/agents/components/workspace/agent-component-fixtures";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import {
  liveAppShellRoutes,
  organizationUsersFixture,
} from "./live-app-fixtures";

// The live Agents list (`apps/app/.../agents/components/agents-list-host.tsx`)
// reads the workspace's agent-component inventory from `GET /agent-components`
// twice: the current window, and the preceding window (the read that sends
// `endDate`) its period-over-period deltas compare against.

function component(
  overrides: Partial<AgentComponent> & {
    kind: AgentComponent["kind"];
    name: string;
    slug: string;
  }
): AgentComponent {
  return makeComponent({
    collaborators: ["dana-reyes", "emma-chen"],
    firstSeenAt: "2026-07-02T09:00:00.000Z",
    harness: Harness.Claude,
    id: `uuid-${overrides.slug.replace("::", "-")}`,
    lastSeenAt: "2026-10-06T14:20:00.000Z",
    source: "closedloop-ai/closedloop-ai",
    sourceType: SourceType.Repo,
    ...overrides,
  });
}

export const agentComponentsFixture: AgentComponent[] = [
  component({
    collaborators: ["dana-reyes", "emma-chen", "marcus-webb"],
    invocations: 1284,
    kind: AgentComponentKind.Subagent,
    locPerDollar: 412,
    name: "code-reviewer",
    sessions: 318,
    slug: "subagent::code-reviewer",
    trend: [38, 41, 52, 47, 60, 58, 66],
  }),
  component({
    invocations: 862,
    kind: AgentComponentKind.Subagent,
    locPerDollar: 288,
    name: "test-writer",
    sessions: 204,
    slug: "subagent::test-writer",
    trend: [22, 25, 31, 29, 34, 40, 37],
  }),
  component({
    collaborators: ["priya-nair"],
    invocations: 341,
    kind: AgentComponentKind.Subagent,
    locPerDollar: 190,
    name: "design-critic",
    sessions: 97,
    slug: "subagent::design-critic",
    trend: [8, 11, 9, 14, 12, 15, 18],
  }),
  component({
    invocations: 2140,
    kind: AgentComponentKind.Command,
    locPerDollar: 355,
    name: "/ship",
    sessions: 512,
    slug: "command::ship",
    trend: [70, 74, 81, 77, 90, 95, 102],
  }),
  component({
    invocations: 615,
    kind: AgentComponentKind.Command,
    locPerDollar: 240,
    name: "/triage",
    sessions: 176,
    slug: "command::triage",
    trend: [19, 17, 22, 26, 24, 28, 25],
  }),
  component({
    invocations: 1702,
    kind: AgentComponentKind.Skill,
    locPerDollar: 301,
    name: "storybook-curate",
    sessions: 389,
    slug: "skill::storybook-curate",
    sourceType: SourceType.Pack,
    source: "closedloop/design-pack",
    trend: [44, 52, 49, 61, 58, 70, 73],
  }),
  component({
    harness: Harness.Both,
    invocations: 988,
    kind: AgentComponentKind.Skill,
    locPerDollar: 276,
    name: "local-ci",
    sessions: 241,
    slug: "skill::local-ci",
    trend: [30, 28, 35, 33, 39, 36, 42],
  }),
  component({
    invocations: 4310,
    kind: AgentComponentKind.Mcp,
    locPerDollar: null,
    name: "closedloop",
    sessions: 903,
    slug: "mcp::closedloop",
    sourceType: SourceType.Server,
    source: "mcp.closedloop.ai",
    trend: [120, 131, 128, 140, 152, 149, 160],
  }),
  component({
    invocations: 527,
    kind: AgentComponentKind.Hook,
    locPerDollar: null,
    name: "pre-push-gate",
    sessions: 488,
    slug: "hook::pre-push-gate",
    trend: [15, 18, 16, 20, 19, 22, 21],
  }),
  component({
    invocations: 214,
    kind: AgentComponentKind.Plugin,
    locPerDollar: 160,
    name: "acme/release-notes",
    sessions: 61,
    slug: "plugin::acme-release-notes",
    sourceType: SourceType.Pack,
    source: "acme/release-notes",
    trend: [4, 6, 5, 8, 9, 7, 10],
  }),
];

/** The preceding window: the same inventory at about four fifths of the use. */
const precedingComponentsFixture: AgentComponent[] = agentComponentsFixture.map(
  (item) => ({
    ...item,
    invocations:
      item.invocations === null ? null : Math.round(item.invocations * 0.8),
    sessions: item.sessions === null ? null : Math.round(item.sessions * 0.82),
  })
);

export function agentComponentList(
  items: readonly AgentComponent[]
): AgentComponentListResponse {
  return { items: [...items], total: items.length };
}

export const agentsListRoute = (
  current: readonly AgentComponent[],
  preceding: readonly AgentComponent[] = current
): FixtureRoute => ({
  method: "GET",
  path: "/agent-components",
  respond: ({ searchParams }) =>
    agentComponentList(searchParams.has("endDate") ? preceding : current),
});

export const agentsApiRoutes: FixtureRoute[] = [
  ...liveAppShellRoutes,
  { method: "GET", path: "/users", respond: () => organizationUsersFixture },
  agentsListRoute(agentComponentsFixture, precedingComponentsFixture),
];

const CODE_REVIEWER_PROMPT = `---
name: code-reviewer
description: Reviews a diff for correctness bugs before it is pushed.
model: sonnet
---

You are a senior reviewer. Read the staged diff and the files it touches.
Report only findings you can point at: a line, the input that breaks it, and
the fix. Skip style nits the linter already catches.`;

function revision(
  hash: string,
  createdAt: string,
  isCurrent: boolean,
  content: string
): ComponentVersion {
  return {
    content,
    createdAt,
    format: "md",
    hash,
    isCurrent,
    source: ".claude/agents/code-reviewer.md",
  };
}

const AGENT_SESSIONS = [
  ...populatedAgentSessionListFixtures,
  ...mixedAgentSessionListFixtures,
];

/** The detail read for the first inventory row, `subagent::code-reviewer`. */
export const agentDetailFixture: AgentComponentDetail = makeDetail({
  ...agentComponentsFixture[0],
  baselineSampleSize: 412,
  locDelta: 18.4,
  mergedPrs: 96,
  prompt: CODE_REVIEWER_PROMPT,
  properties: {
    format: "md",
    path: ".claude/agents/code-reviewer.md",
  },
  resolvedState: ComponentResolvedState.Resolved,
  sessionsTab: AGENT_SESSIONS,
  usageSessions: AGENT_SESSIONS.map((session, index) => ({
    branchName: null,
    invocationCount: 6 + index * 3,
    sessionId: session.id,
    versionHash: index < 3 ? "9f3c2a1" : "41be07d",
  })),
  successDelta: 4.2,
  successRate: 0.87,
  versions: [
    revision("9f3c2a1", "2026-09-28T11:00:00.000Z", true, CODE_REVIEWER_PROMPT),
    revision(
      "41be07d",
      "2026-08-14T16:30:00.000Z",
      false,
      CODE_REVIEWER_PROMPT.replace(
        " Skip style nits the linter already catches.",
        ""
      )
    ),
  ],
});

const TREND_FIRST_DAY = Date.parse("2026-09-08T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function trendPoint(
  day: number,
  model: string,
  scale: number
): TokenTrendPoint {
  const wave = 1 + 0.35 * Math.sin(day / 2);
  return {
    cacheReadTokens: Math.round(52_000 * scale * wave),
    cacheWriteTokens: Math.round(9000 * scale),
    componentErrorCount: day % 9 === 0 ? 1 : 0,
    componentInvocations: Math.round(40 * scale * wave),
    estimatedCostUsd: Number((3.8 * scale * wave + day * 0.04).toFixed(2)),
    inputTokens: Math.round(118_000 * scale * wave + day * 1500),
    model,
    outputTokens: Math.round(31_000 * scale * wave + day * 400),
    runtimeMs: Math.round(420_000 * wave),
    sessionId: `ses_trend_${model}_${day}`,
    sessionStartedAt: new Date(TREND_FIRST_DAY + day * DAY_MS).toISOString(),
  };
}

/** Four weeks of the component's per-model usage (`GET …/token-trend`). */
export const agentTokenTrendFixture: TokenTrendResponse = {
  models: ["claude-sonnet-4-5", "claude-opus-4-5"],
  points: Array.from({ length: 28 }, (_unused, day) => day).flatMap((day) => [
    trendPoint(day, "claude-sonnet-4-5", 1),
    trendPoint(day, "claude-opus-4-5", 0.35),
  ]),
  slug: "subagent::code-reviewer",
};

/** The detail page's two reads: the detail itself and its usage trend. */
export function agentDetailRoutes(
  detail: AgentComponentDetail,
  trend: TokenTrendResponse = agentTokenTrendFixture
): FixtureRoute[] {
  return [
    {
      method: "GET",
      path: "/agent-components/*",
      respond: ({ pathname }) =>
        pathname.endsWith("/token-trend") ? trend : detail,
    },
  ];
}
