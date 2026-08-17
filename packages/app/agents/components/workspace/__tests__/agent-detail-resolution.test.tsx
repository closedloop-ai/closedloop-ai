/**
 * ISS-4495: Regression coverage for the resolution badge AS THE PRODUCT WIRES
 * IT — through the real `AgentDetail` call path, not a synthetic prop bundle.
 *
 * `AgentDetail` is the ONLY production caller of `ResolutionBadge`, and it wires
 * exactly two inputs into the badge:
 *   - `resolvedState={data.resolvedState}` (the org-folded honest state), and
 *   - `normalizerContractVersion={currentVersion?.normalizerContractVersion}`
 *     (the contract the CURRENT revision's fingerprint was produced under).
 * It never passes `observedDefinitionHash` / `currentDefinitionHash`, so the
 * two fingerprint-diff states (`stale-definition`) are unreachable from this
 * surface by design — a component's current revision IS the current definition,
 * so there is no second hash to diff at the header. That pure-fingerprint
 * derivation is covered where it actually lives, in the model-owned
 * `packages/api/src/types/component-resolution.test.ts`.
 *
 * These tests therefore assert the states the product genuinely constructs:
 *  - resolved / unresolved / unavailable derive from `resolvedState` through the
 *    real detail render, and
 *  - `contract-mismatch` IS reachable via the real wiring when the current
 *    revision carries an unknown `normalizerContractVersion`.
 */

import { NORMALIZER_CONTRACT_VERSION } from "@repo/api/src/definition-fingerprint";
import {
  type AgentComponentDetail,
  AgentComponentKind,
  ComponentResolvedState,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import {
  COMPONENT_RESOLUTION_LABELS,
  ComponentResolutionDisplayState,
} from "@repo/api/src/types/component-resolution";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentDetail } from "../agent-detail";

const RESOLVED =
  COMPONENT_RESOLUTION_LABELS[ComponentResolutionDisplayState.Resolved];
const UNRESOLVED =
  COMPONENT_RESOLUTION_LABELS[ComponentResolutionDisplayState.Unresolved];
const UNAVAILABLE =
  COMPONENT_RESOLUTION_LABELS[ComponentResolutionDisplayState.Unavailable];
const CONTRACT_MISMATCH =
  COMPONENT_RESOLUTION_LABELS[ComponentResolutionDisplayState.ContractMismatch];
const STALE =
  COMPONENT_RESOLUTION_LABELS[ComponentResolutionDisplayState.StaleDefinition];

function makeDetail(
  overrides: Partial<AgentComponentDetail> = {}
): AgentComponentDetail {
  return {
    id: "uuid-detail-res",
    slug: "subagent::resolution-fixture",
    name: "Resolution Fixture",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 1,
    sessions: 1,
    locPerDollar: 1,
    trend: [1],
    collaborators: ["bob"],
    computeTargetIds: ["target-1"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    properties: { path: "/agents/fixture.md", format: "md" },
    prompt: "Fixture prompt.",
    versions: [],
    resolvedState: ComponentResolvedState.Unresolved,
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

function testDetailSource(
  detail: AgentComponentDetail
): AgentComponentsDataSource {
  return {
    scope: "test-detail-resolution",
    list: () => Promise.reject(new Error("list unused in resolution tests")),
    detail: () => Promise.resolve(detail),
  };
}

function Wrapper({
  children,
  dataSource,
}: {
  children: ReactNode;
  dataSource: AgentComponentsDataSource;
}) {
  return (
    <AppCoreStoryProviders>
      <AgentComponentsDataSourceProvider dataSource={dataSource}>
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

function renderDetail(detail: AgentComponentDetail) {
  render(
    <Wrapper dataSource={testDetailSource(detail)}>
      <AgentDetail backHref="/acme/agents" slug={detail.id} />
    </Wrapper>
  );
}

// A current revision carrying a fingerprint under the KNOWN contract, so the
// badge's `normalizerContractVersion` input is well-formed.
function currentRevision(normalizerContractVersion: number) {
  return {
    hash: "aaaaaaa0000",
    definitionHash: "def-hash-current",
    normalizerContractVersion,
    source: "",
    format: "md",
    createdAt: "2026-06-01T00:00:00.000Z",
    isCurrent: true,
    content: "Fixture prompt.",
  };
}

describe("AgentDetail — resolution badge derives from the real production wiring", () => {
  it("renders 'Resolved' when data.resolvedState is resolved (current contract)", async () => {
    renderDetail(
      makeDetail({
        resolvedState: ComponentResolvedState.Resolved,
        versions: [currentRevision(NORMALIZER_CONTRACT_VERSION)],
      })
    );
    expect(await screen.findByText(RESOLVED.label)).toBeInTheDocument();
  });

  it("renders 'Unresolved' for a legacy / name-only row", async () => {
    renderDetail(
      makeDetail({ resolvedState: ComponentResolvedState.Unresolved })
    );
    expect(await screen.findByText(UNRESOLVED.label)).toBeInTheDocument();
  });

  it("renders 'Unavailable' (never a lying 'Resolved') for a missing definition", async () => {
    renderDetail(makeDetail({ resolvedState: ComponentResolvedState.Missing }));
    expect(await screen.findByText(UNAVAILABLE.label)).toBeInTheDocument();
    expect(screen.queryByText(RESOLVED.label)).not.toBeInTheDocument();
  });

  it("renders 'Unavailable' for an inaccessible (permission-denied) definition", async () => {
    renderDetail(
      makeDetail({ resolvedState: ComponentResolvedState.Inaccessible })
    );
    expect(await screen.findByText(UNAVAILABLE.label)).toBeInTheDocument();
  });

  it("renders 'Contract mismatch' via the real wiring when the CURRENT revision's normalizer contract is unknown", async () => {
    // This is the fingerprint-refined state the product genuinely reaches: the
    // detail passes `currentVersion.normalizerContractVersion` into the badge,
    // so a current revision produced under a FUTURE contract the client can't
    // interpret surfaces as contract-mismatch through the real call path — not a
    // synthetic prop combination.
    renderDetail(
      makeDetail({
        resolvedState: ComponentResolvedState.Resolved,
        versions: [currentRevision(NORMALIZER_CONTRACT_VERSION + 1)],
      })
    );
    expect(
      await screen.findByText(CONTRACT_MISMATCH.label)
    ).toBeInTheDocument();
    // Not silently downgraded to a plain 'Resolved'.
    expect(screen.queryByText(RESOLVED.label)).not.toBeInTheDocument();
    // The fingerprint-diff state is NOT reachable from this surface (no observed
    // hash is wired), so it must never appear here.
    expect(screen.queryByText(STALE.label)).not.toBeInTheDocument();
  });

  it("stays 'Resolved' (older-client compat) when the current revision carries no normalizer contract", async () => {
    // A version-skewed detail omits `normalizerContractVersion`; the badge must
    // degrade to the honest base state, not invent a mismatch.
    renderDetail(
      makeDetail({
        resolvedState: ComponentResolvedState.Resolved,
        versions: [
          {
            hash: "aaaaaaa0000",
            source: "",
            format: "md",
            createdAt: "2026-06-01T00:00:00.000Z",
            isCurrent: true,
            content: "Fixture prompt.",
          },
        ],
      })
    );
    expect(await screen.findByText(RESOLVED.label)).toBeInTheDocument();
    expect(screen.queryByText(CONTRACT_MISMATCH.label)).not.toBeInTheDocument();
  });
});
