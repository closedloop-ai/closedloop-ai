/**
 * Shared fixtures for the agent-component per-version usage suites.
 *
 * Extracted when ISS-10468's side-by-side compare became the SECOND consumer of
 * this detail payload, its data source and its render tree. A second copy would
 * have been ~130 lines of `AgentComponentDetail` restated, and the two would
 * drift the moment a required field was added — which is exactly the duplicated
 * nontrivial fixture the repo guidelines send to a shared module.
 *
 * Everything here builds the REAL render path (`AgentDetail`, the one production
 * caller of `VersionUsagePanel`) behind the real flag provider, so a suite that
 * uses it is covering production wiring rather than a synthetic prop bundle.
 */

import {
  type AgentComponentDetail,
  AgentComponentKind,
  ComponentResolvedState,
  type ComponentVersion,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import type {
  AgentComponentVersionUsage,
  AgentComponentVersionUsageResponse,
} from "@repo/api/src/types/agent-component-version-usage";
import { EMPTY_COHORT_DELIVERY_METRICS } from "@repo/api/src/types/analytics";
import { EMPTY_VERSION_SPEND } from "@repo/api/src/utils/version-spend";
import { AGENTS_VERSION_USAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render } from "@testing-library/react";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentDetail } from "../agent-detail";

/** The panel's accessible region name, shared by every case that scopes to it. */
export const PANEL_HEADING = "Version usage";

export const CURRENT_HASH = "aaaaaaaa1111";
export const OLDER_HASH = "bbbbbbbb2222";

export function revision(hash: string, isCurrent: boolean): ComponentVersion {
  return {
    hash,
    source: "",
    format: "md",
    createdAt: "2026-06-01T00:00:00.000Z",
    isCurrent,
    content: `Body of ${hash}.`,
  };
}

export function makeDetail(
  overrides: Partial<AgentComponentDetail> = {}
): AgentComponentDetail {
  return {
    id: "uuid-version-usage",
    slug: "skill::version-usage-fixture",
    name: "Version Usage Fixture",
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    // The FAMILY headline the panel restates and must never replace.
    invocations: 76,
    sessions: 5,
    locPerDollar: 12,
    trend: [1],
    collaborators: ["bob"],
    computeTargetIds: ["target-1"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    properties: { path: "/skills/fixture.md", format: "md" },
    prompt: "Body.",
    versions: [revision(CURRENT_HASH, true), revision(OLDER_HASH, false)],
    resolvedState: ComponentResolvedState.Resolved,
    sessionsTab: [],
    sessionsTabTruncated: false,
    branchesTab: [],
    branchesTabTruncated: false,
    provenance: [],
    usageSessions: [],
    locDelta: null,
    successRate: null,
    successDelta: null,
    tokenEfficiencyDelta: null,
    efficiencyTrend: [],
    mergedPrs: null,
    qualityScore: null,
    qualityDelta: null,
    ...overrides,
  };
}

export function versionUsage(
  invocations: number | null,
  sessions: number | null,
  attribution: AgentComponentVersionUsageResponse["attribution"],
  entryOverrides: Partial<AgentComponentVersionUsage> = {}
): AgentComponentVersionUsageResponse {
  return {
    entries: [
      {
        hash: CURRENT_HASH,
        invocations,
        sessions,
        locPerDollar: null,
        truncated: false,
        ...EMPTY_COHORT_DELIVERY_METRICS,
        ...EMPTY_VERSION_SPEND,
        ...entryOverrides,
      },
    ],
    attribution,
  };
}

export const MEASURED_ATTRIBUTION: AgentComponentVersionUsageResponse["attribution"] =
  {
    unversioned: { invocations: 69, sessions: 2 },
    versioned: { invocations: 7, sessions: 3 },
    truncated: false,
  };

export type SourceOptions = {
  detail: AgentComponentDetail;
  usage?: AgentComponentVersionUsageResponse;
  /** Omit `versionUsage` entirely — a source that cannot scope by version. */
  supportsVersionUsage?: boolean;
  /** A source that answers PER HASH, for the multi-revision attribution case. */
  source?: (
    slug: string,
    versionHashes: readonly string[]
  ) => Promise<AgentComponentVersionUsageResponse>;
};

export function testSource(options: SourceOptions): AgentComponentsDataSource {
  const base: AgentComponentsDataSource = {
    scope: "test-version-usage-panel",
    honorsDateWindow: false,
    list: () => Promise.reject(new Error("list unused in these tests")),
    detail: () => Promise.resolve(options.detail),
  };
  if (options.supportsVersionUsage === false) {
    return base;
  }
  return {
    ...base,
    versionUsage:
      options.source ??
      (() =>
        Promise.resolve(
          options.usage ?? versionUsage(6, 2, MEASURED_ATTRIBUTION)
        )),
  };
}

/**
 * `: void`, deliberately. `render`'s return type reaches into
 * `@testing-library/dom`'s own `queries` module, which `tsc` cannot name from an
 * importing file (TS2883) once this helper crossed a module boundary. No caller
 * uses the result — a suite that needs `rerender` builds the tree itself with
 * {@link detailTree} — so annotating it away is the fix rather than a loss.
 */
export function renderDetail(options: SourceOptions, flagOn = true): void {
  render(detailTree(options, flagOn));
}

/** The one render tree, so a rerender can swap the payload under the same key. */
export function detailTree(options: SourceOptions, flagOn = true) {
  return (
    <AppCoreStoryProviders
      enabledFlags={flagOn ? [AGENTS_VERSION_USAGE_FEATURE_FLAG_KEY] : []}
    >
      <AgentComponentsDataSourceProvider dataSource={testSource(options)}>
        <AgentDetail backHref="/acme/agents" slug={options.detail.slug} />
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}
