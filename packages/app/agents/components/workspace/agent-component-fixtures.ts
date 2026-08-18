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
  ComponentResolvedState,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { EMPTY_COHORT_DELIVERY_METRICS } from "@repo/api/src/types/analytics";

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
