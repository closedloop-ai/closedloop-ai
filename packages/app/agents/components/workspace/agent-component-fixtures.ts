// gardener-support: test and story data, not shipped
/**
 * ISS-4496: shared cross-surface fixture factory + inventory for the agents
 * workspace tests.
 *
 * The web workspace suites (`agents-grouped-list.test.tsx`, …) and the desktop
 * renderer parity suite (`agents-view-parity.test.tsx`) drive the SAME shared
 * `AgentsGroupedList` / `AgentDetail` components, one through each surface's
 * adapter. Their fixtures MUST stay identical or the two "renders consistently
 * on both surfaces" parity claims silently diverge and keep passing against
 * different component shapes. Sourcing the component factory + inventory here —
 * next to the shared components both surfaces mount — is what keeps them honest.
 *
 * Each surface still owns its OWN data-source adapter (`agent-components:local`
 * vs the web scope); only the fixture DATA is shared.
 */

import {
  type AgentComponent,
  type AgentComponentDetail,
  AgentComponentKind,
  type AgentComponentListResponse,
  ComponentResolvedState,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { EMPTY_COHORT_DELIVERY_METRICS } from "@repo/api/src/types/analytics";
import type { AgentComponentsDataSource } from "../../data-source/agent-components-data-source";

export function makeComponent(
  overrides: Partial<AgentComponent>
): AgentComponent {
  return {
    id: overrides.id ?? "uuid-default",
    slug: overrides.slug ?? overrides.id ?? "subagent::uuid-default",
    name: overrides.name ?? "Default Component",
    kind: overrides.kind ?? AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 10,
    sessions: 3,
    locPerDollar: 2.5,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

export const FIXTURE_COMPONENTS: AgentComponent[] = [
  makeComponent({
    id: "uuid-sub-1",
    slug: "subagent::orchestrator",
    name: "My Orchestrator Agent",
    kind: AgentComponentKind.Subagent,
  }),
  makeComponent({
    id: "uuid-cmd-1",
    slug: "command::code-review",
    name: "Code Review Command",
    kind: AgentComponentKind.Command,
  }),
  makeComponent({
    id: "uuid-skill-1",
    slug: "skill::python",
    name: "Python Expert Skill",
    kind: AgentComponentKind.Skill,
  }),
];

export function makeDetail(
  overrides: Partial<AgentComponentDetail> = {}
): AgentComponentDetail {
  return {
    ...EMPTY_COHORT_DELIVERY_METRICS,
    id: "uuid-detail-1",
    slug: "subagent::orchestrator",
    name: "My Orchestrator Agent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 42,
    sessions: 7,
    locPerDollar: 3.14,
    trend: [1, 2, 3],
    collaborators: ["bob"],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    properties: { path: ".claude/agents/orchestrator.md", format: "md" },
    prompt:
      "You are an expert orchestrator agent. Coordinate work efficiently.",
    versions: [],
    resolvedState: ComponentResolvedState.Unresolved,
    sessionsTab: [],
    sessionsTabTruncated: false,
    branchesTab: [],
    branchesTabTruncated: false,
    provenance: [],
    usageSessions: [],
    ...overrides,
  };
}

/**
 * The web/HTTP data-source scope — the React Query cache identity, and nothing
 * more.
 *
 * ISS-6888: it deliberately no longer implies window capability. This was
 * `AGENT_COMPONENTS_WINDOWED_SCOPE`, named after the era when the shared list
 * inferred "honors the date window" from `scope === "agent-components:http"`;
 * that inference went stale the moment the desktop local source learned to apply
 * the bounds (FEA-3196) and silently kept desktop's delta suppressed. The
 * capability is now `AgentComponentsDataSource.honorsDateWindow`, so a fixture
 * that wants a windowed source sets THAT and this constant answers only "which
 * cache is this".
 */
export const AGENT_COMPONENTS_HTTP_SCOPE = "agent-components:http";

/**
 * A data source that serves the CURRENT window (startDate only, or all-time)
 * and the PRECEDING window (startDate + endDate) from two DISTINCT populations,
 * so a delta computes off a real prior baseline. The preceding query is the only
 * one that sends `endDate` (see `AgentsGroupedList`'s second `useAgentComponents`).
 *
 * Shared rather than re-declared per suite: the delta tests and the ISS-6205
 * exactness tests both need a genuine two-window source, and two copies would
 * drift into asserting against different window semantics.
 *
 * ISS-6888: `honorsDateWindow` is what decides whether the list ASKS for the
 * preceding window at all, so a suite proving the suppression passes `false`
 * here — on the same two populations — rather than reaching for a scope string.
 */
export function periodOverPeriodDataSource(
  current: AgentComponent[],
  previous: AgentComponent[],
  options: { scope?: string; honorsDateWindow?: boolean } = {}
): AgentComponentsDataSource {
  return {
    scope: options.scope ?? AGENT_COMPONENTS_HTTP_SCOPE,
    honorsDateWindow: options.honorsDateWindow ?? true,
    list: (filters) => {
      const isPreceding = typeof filters.endDate === "string";
      const items = isPreceding ? previous : current;
      return Promise.resolve({
        items,
        total: items.length,
      } satisfies AgentComponentListResponse);
    },
    detail: () => Promise.reject(new Error("detail unused in list tests")),
  };
}

/**
 * A data source that resolves the detail read and refuses the list read — the
 * mirror of `periodOverPeriodDataSource` for the `AgentDetail` suites.
 *
 * Lives here, beside `makeDetail`, so the detail suites take their baseline and
 * their source from the one module the stories and cross-surface parity suites
 * already read (`packages/app/agents/AGENTS.md`).
 */
export function agentDetailSource(
  detail: AgentComponentDetail
): AgentComponentsDataSource {
  return {
    scope: "test-detail",
    honorsDateWindow: false,
    list: () => Promise.reject(new Error("list unused in detail tests")),
    detail: () => Promise.resolve(detail),
  };
}

/**
 * ISS-9625: the ONE usage population both surface parity suites seed their
 * count assertions from (`agents-list-host.parity.test.tsx` on web,
 * `agents-view-parity.test.tsx` on desktop).
 *
 * It lives here rather than beside either suite because a per-surface copy is
 * exactly the drift a parity pair exists to prevent: two byte-identical
 * inventories can be edited one at a time, after which both halves stay green
 * while each asserts against a DIFFERENT record — a "both surfaces agree" claim
 * that has stopped comparing anything. One seed means moving a count reddens
 * both halves or neither.
 *
 * The two rows carry DISTINCT `invocations` and DISTINCT `sessions` on purpose:
 * a value shared between rows would let a transposed render satisfy per-row
 * assertions. Each suite still spells its EXPECTED numbers as independent
 * literals (per `agent-breadcrumb-honesty-parity.ts`) — shared seed, unshared
 * expectation — so no assertion is re-derived from the data it polices.
 */
export const USAGE_FIXTURE_COMPONENTS: AgentComponent[] = [
  makeComponent({
    id: "uuid-sub-usage",
    slug: "subagent::usage",
    name: "Usage Orchestrator",
    kind: AgentComponentKind.Subagent,
    invocations: 731,
    sessions: 17,
  }),
  makeComponent({
    id: "uuid-cmd-usage",
    slug: "command::usage",
    name: "Usage Command",
    kind: AgentComponentKind.Command,
    invocations: 482,
    sessions: 9,
  }),
];
