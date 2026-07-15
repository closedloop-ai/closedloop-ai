import {
  type AgentComponentDetail,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentDetail } from "../agent-detail";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeDetail(
  overrides: Partial<AgentComponentDetail> = {}
): AgentComponentDetail {
  return {
    id: "uuid-detail-1",
    name: "My Orchestrator Agent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 42,
    sessions: 7,
    klocPerDollar: 3.14,
    trend: [1, 2, 3],
    owner: "alice",
    collaborators: ["bob"],
    computeTargetIds: ["target-1"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    properties: {
      path: "/agents/orchestrator.md",
      format: "md",
    },
    prompt:
      "You are an expert orchestrator agent. Coordinate work efficiently.",
    sessionsTab: [],
    branchesTab: [],
    provenance: [],
    usageSessions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test data source factory
// ---------------------------------------------------------------------------

function testDetailSource(
  detail: AgentComponentDetail
): AgentComponentsDataSource {
  return {
    scope: "test-detail",
    list: () => Promise.reject(new Error("list unused in detail tests")),
    detail: () => Promise.resolve(detail),
  };
}

function notFoundSource(): AgentComponentsDataSource {
  return {
    scope: "test-not-found",
    list: () => Promise.reject(new Error("list unused")),
    detail: () =>
      Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })),
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

// ---------------------------------------------------------------------------
// Top-level regex constants (biome/performance/useTopLevelRegex)
// ---------------------------------------------------------------------------

const RE_SESSIONS_TAB = /sessions/i;
const RE_BRANCHES_TAB = /branches/i;
const RE_PROMPT_TEXT = /You are an expert orchestrator agent/;
const RE_NOT_FOUND = /component not found/i;

// ---------------------------------------------------------------------------
// T-10.7: AgentDetail component tests
// ---------------------------------------------------------------------------

describe("AgentDetail", () => {
  it("renders the Properties panel with key fields", async () => {
    const detail = makeDetail();

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail slug={detail.id} />
      </Wrapper>
    );

    // Properties panel header
    expect(await screen.findByText("Properties")).toBeInTheDocument();

    // Kind label rendered in the Properties panel (there may be multiple, use getAllBy)
    const agentLabels = screen.getAllByText("Agent");
    expect(agentLabels.length).toBeGreaterThan(0);

    // Source and harness values
    expect(screen.getByText("acme/repo")).toBeInTheDocument();
    // Harness label appears in Properties panel
    const claudeLabels = screen.getAllByText("Claude");
    expect(claudeLabels.length).toBeGreaterThan(0);
  });

  it("renders the Sessions and Branches tabs", async () => {
    const detail = makeDetail();

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail slug={detail.id} />
      </Wrapper>
    );

    await screen.findByText("Properties");

    // Sessions and Branches tabs
    expect(
      screen.getByRole("tab", { name: RE_SESSIONS_TAB })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: RE_BRANCHES_TAB })
    ).toBeInTheDocument();
  });

  it("renders the Prompt panel for Subagent kind (has invocation signal)", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Subagent,
      prompt:
        "You are an expert orchestrator agent. Coordinate work efficiently.",
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail slug={detail.id} />
      </Wrapper>
    );

    // Prompt panel header and content
    expect(await screen.findByText("Prompt")).toBeInTheDocument();
    expect(screen.getByText(RE_PROMPT_TEXT)).toBeInTheDocument();
  });

  it("does NOT render the Prompt panel for Config kind", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Config,
      prompt: null,
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail slug={detail.id} />
      </Wrapper>
    );

    await screen.findByText("Properties");

    // No Prompt section for Config kind
    expect(screen.queryByText("Prompt")).not.toBeInTheDocument();
  });

  it("does NOT render the Prompt panel for Hook kind", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Hook,
      prompt: null,
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail slug={detail.id} />
      </Wrapper>
    );

    await screen.findByText("Properties");
    expect(screen.queryByText("Prompt")).not.toBeInTheDocument();
  });

  it("renders metric cards grid", async () => {
    const detail = makeDetail();

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail slug={detail.id} />
      </Wrapper>
    );

    await screen.findByText("Properties");

    // Should render metric card labels (from componentMetrics).
    // There may be multiple elements (metric card + tab trigger both say "Sessions")
    // so use getAllByText to handle multiple matches.
    const sessionsElements = screen.getAllByText("Sessions");
    expect(sessionsElements.length).toBeGreaterThan(0);

    const invocationsElements = screen.getAllByText("Invocations");
    expect(invocationsElements.length).toBeGreaterThan(0);
  });

  it("shows 'Component not found' when the source rejects with 404", async () => {
    render(
      <Wrapper dataSource={notFoundSource()}>
        <AgentDetail slug="missing-uuid" />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText(RE_NOT_FOUND)).toBeInTheDocument();
    });
  });

  it("renders the component name in the header", async () => {
    const detail = makeDetail({ name: "Expert Python Reviewer" });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail slug={detail.id} />
      </Wrapper>
    );

    expect(
      await screen.findByText("Expert Python Reviewer")
    ).toBeInTheDocument();
  });
});
