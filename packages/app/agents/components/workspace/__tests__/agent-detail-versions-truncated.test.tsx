/**
 * ISS-5029: the Definition panel must say when its revision history is PARTIAL,
 * instead of presenting a capped set exactly like a complete one.
 *
 * Driven through the real `AgentDetail` render path (the only production caller
 * of `PromptPanel`), so the assertions cover the actual wiring — the server's
 * `versionsTruncated` claim reaching the caption — not a synthetic prop bundle.
 *
 * ISS-5366 retired the `component-versions-truncated` gate to its enabled state,
 * so the caption is unconditional and the flag axis is gone. The PAYLOAD axis is
 * what still has to discriminate, and it is what these cases pin: truncated
 * (shown), NOT truncated (hidden), and the field ABSENT (hidden). That last one
 * is the version-skew path — an older cloud, or the desktop's own uncapped local
 * read, sends nothing and the panel must not claim truncation. With no gate left
 * it is also the only thing keeping the caption a signal rather than decoration.
 *
 * A further case pins the single-revision shape, where the version selector does
 * not render at all: the caption has to stand on its own there, so it is
 * phrased as a claim about the history rather than about the dropdown (#4391
 * review).
 */

import {
  type AgentComponentDetail,
  AgentComponentKind,
  ComponentResolvedState,
  type ComponentVersion,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentDetail } from "../agent-detail";

const TRUNCATION_CAPTION = /revision history is partial/i;

function revision(index: number, isCurrent: boolean): ComponentVersion {
  return {
    hash: `hash000${index}`,
    source: "",
    format: "md",
    createdAt: "2026-06-01T00:00:00.000Z",
    isCurrent,
    content: `Revision ${index} body.`,
  };
}

function makeDetail(
  overrides: Partial<AgentComponentDetail> = {}
): AgentComponentDetail {
  return {
    id: "uuid-detail-trunc",
    slug: "subagent::truncation-fixture",
    name: "Truncation Fixture",
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
    prompt: "Revision 0 body.",
    // Two revisions so the version selector renders — the caption sits under it.
    versions: [revision(0, true), revision(1, false)],
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

function testDetailSource(
  detail: AgentComponentDetail
): AgentComponentsDataSource {
  return {
    scope: "test-detail-versions-truncated",
    list: () => Promise.reject(new Error("list unused in these tests")),
    detail: () => Promise.resolve(detail),
  };
}

function renderDetail(detail: AgentComponentDetail) {
  render(
    <AppCoreStoryProviders enabledFlags={[]}>
      <AgentComponentsDataSourceProvider dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

describe("AgentDetail Definition panel — ISS-5029 truncation marker", () => {
  it("truncated: says the history is incomplete", async () => {
    renderDetail(makeDetail({ versionsTruncated: true }));

    expect(await screen.findByText(TRUNCATION_CAPTION)).toBeInTheDocument();
  });

  it("truncated + a SINGLE retained revision: the caption stands alone, with no version selector on screen", async () => {
    // #4391 review: the version selector only draws at `versions.length > 1`,
    // but the truncation grounds can hold for a family with one retained
    // revision — so the caption must read as a claim about the history rather
    // than about a dropdown that is not rendered. The other fixtures
    // deliberately use two revisions, which hid this shape.
    renderDetail(
      makeDetail({ versions: [revision(0, true)], versionsTruncated: true })
    );

    expect(await screen.findByText(TRUNCATION_CAPTION)).toBeInTheDocument();
    // No selector: nothing for the copy to point at.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("NOT truncated: stays silent", async () => {
    renderDetail(makeDetail({ versionsTruncated: false }));

    // A marker that is always on is as useless as one that is never on — this is
    // the half that proves the caption reads the data. With the gate retired it
    // is the ONLY thing that does.
    await screen.findByText("Definition");
    expect(screen.queryByText(TRUNCATION_CAPTION)).not.toBeInTheDocument();
  });

  it("field ABSENT (an older cloud / the desktop local read): stays silent", async () => {
    const detail = makeDetail();
    expect(Object.hasOwn(detail, "versionsTruncated")).toBe(false);

    renderDetail(detail);

    await screen.findByText("Definition");
    expect(screen.queryByText(TRUNCATION_CAPTION)).not.toBeInTheDocument();
  });
});
