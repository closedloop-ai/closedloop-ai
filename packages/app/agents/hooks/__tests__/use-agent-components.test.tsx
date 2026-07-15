import {
  type AgentComponent,
  type AgentComponentDetail,
  AgentComponentKind,
  type AgentComponentListResponse,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../data-source/provider";
import {
  agentComponentKeys,
  useAgentComponentDetail,
  useAgentComponents,
} from "../use-agent-components";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeComponent(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  return {
    id: "uuid-0001",
    name: "Test Subagent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 10,
    sessions: 3,
    klocPerDollar: 2.5,
    trend: [1, 2, 3],
    owner: "alice",
    collaborators: [],
    computeTargetIds: ["t1"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDetail(
  overrides: Partial<AgentComponent> = {}
): AgentComponentDetail {
  return {
    ...makeComponent(overrides),
    properties: { path: "/agents/agent.md", format: "md" },
    prompt: "You are a helpful agent.",
    sessionsTab: [],
    branchesTab: [],
    provenance: [],
    usageSessions: [],
  };
}

function makeListResponse(
  items: AgentComponent[] = []
): AgentComponentListResponse {
  return { items, total: items.length };
}

// ---------------------------------------------------------------------------
// Spy source factory
// ---------------------------------------------------------------------------

type SpySource = AgentComponentsDataSource & {
  listSpy: ReturnType<typeof vi.fn>;
  detailSpy: ReturnType<typeof vi.fn>;
};

function spyingSource(scope = "test"): SpySource {
  const listSpy = vi.fn((_filters: unknown) =>
    Promise.resolve(makeListResponse([makeComponent()]))
  );
  const detailSpy = vi.fn((slug: string) =>
    Promise.resolve(makeDetail({ id: slug }))
  );
  return {
    scope,
    list: listSpy,
    detail: detailSpy,
    listSpy,
    detailSpy,
  };
}

// ---------------------------------------------------------------------------
// agentComponentKeys — query key factory
// ---------------------------------------------------------------------------

describe("agentComponentKeys", () => {
  it("root uses 'agent-components' (not 'agents') to avoid cache collisions", () => {
    expect(agentComponentKeys.all).toEqual(["agent-components"]);
  });

  it("list key embeds scope between read-type prefix and filters", () => {
    expect(agentComponentKeys.list("http", {})).toEqual([
      "agent-components",
      "list",
      "http",
      "default",
      {},
    ]);
  });

  it("list key uses caller-owned cache scope for org-isolation", () => {
    expect(
      agentComponentKeys.list("http", {}, { cacheScope: "org:acme" })
    ).toEqual(["agent-components", "list", "http", "org:acme", {}]);
  });

  it("detail key embeds scope and slug", () => {
    expect(agentComponentKeys.detail("local", "uuid-abc")).toEqual([
      "agent-components",
      "detail",
      "local",
      "default",
      "uuid-abc",
    ]);
  });

  it("detail key uses caller-owned cache scope", () => {
    expect(
      agentComponentKeys.detail("http", "uuid-abc", { cacheScope: "org:acme" })
    ).toEqual(["agent-components", "detail", "http", "org:acme", "uuid-abc"]);
  });

  it("keeps the unscoped prefixes for batch invalidation", () => {
    expect(agentComponentKeys.lists()).toEqual(["agent-components", "list"]);
    expect(agentComponentKeys.details()).toEqual([
      "agent-components",
      "detail",
    ]);
  });
});

// ---------------------------------------------------------------------------
// useAgentComponents
// ---------------------------------------------------------------------------

describe("useAgentComponents", () => {
  it("delegates list to the injected source with the given filters", async () => {
    const source = spyingSource("local");

    function Probe() {
      const { isSuccess } = useAgentComponents({
        kinds: [AgentComponentKind.Skill],
      });
      return (
        <span data-testid="list">{isSuccess ? "success" : "loading"}</span>
      );
    }

    render(
      <AppCoreStoryProviders>
        <AgentComponentsDataSourceProvider dataSource={source}>
          <Probe />
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() =>
      expect(screen.getByTestId("list")).toHaveTextContent("success")
    );

    expect(source.listSpy).toHaveBeenCalledWith({
      kinds: [AgentComponentKind.Skill],
    });
  });

  it("two sources with different scopes never cross-contaminate the cache", async () => {
    const localSource = spyingSource("local");
    const httpSource = spyingSource("http");

    localSource.listSpy.mockResolvedValue(
      makeListResponse([makeComponent({ id: "local-id" })])
    );
    httpSource.listSpy.mockResolvedValue(
      makeListResponse([makeComponent({ id: "http-id" })])
    );

    function Probe({ testId }: { testId: string }) {
      const { data } = useAgentComponents();
      return (
        <span data-testid={testId}>{data?.items[0]?.id ?? "loading"}</span>
      );
    }

    render(
      <AppCoreStoryProviders>
        <AgentComponentsDataSourceProvider dataSource={localSource}>
          <Probe testId="local" />
        </AgentComponentsDataSourceProvider>
        <AgentComponentsDataSourceProvider dataSource={httpSource}>
          <Probe testId="http" />
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() => {
      expect(screen.getByTestId("local")).toHaveTextContent("local-id");
      expect(screen.getByTestId("http")).toHaveTextContent("http-id");
    });
  });
});

// ---------------------------------------------------------------------------
// useAgentComponentDetail
// ---------------------------------------------------------------------------

describe("useAgentComponentDetail", () => {
  it("disabled when slug is empty — does not call detail", () => {
    const source = spyingSource();

    function Probe({ slug }: { slug: string }) {
      const { data } = useAgentComponentDetail(slug);
      return (
        <span data-testid="detail">{data ? `detail:${data.id}` : "none"}</span>
      );
    }

    const { rerender } = render(
      <AppCoreStoryProviders>
        <AgentComponentsDataSourceProvider dataSource={source}>
          <Probe slug="" />
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    expect(screen.getByTestId("detail")).toHaveTextContent("none");
    expect(source.detailSpy).not.toHaveBeenCalled();

    rerender(
      <AppCoreStoryProviders>
        <AgentComponentsDataSourceProvider dataSource={source}>
          <Probe slug="uuid-0001" />
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    waitFor(() => {
      expect(screen.getByTestId("detail")).toHaveTextContent(
        "detail:uuid-0001"
      );
      expect(source.detailSpy).toHaveBeenCalledWith("uuid-0001");
    });
  });

  it("surfaces isError when the source rejects with a 404", async () => {
    const source: AgentComponentsDataSource = {
      scope: "test-error",
      list: vi.fn().mockResolvedValue(makeListResponse()),
      detail: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Not Found"), { status: 404 })
        ),
    };

    function Probe() {
      const { isError } = useAgentComponentDetail("missing-uuid");
      return (
        <span data-testid="error-state">
          {isError ? "is-error" : "no-error"}
        </span>
      );
    }

    render(
      <AppCoreStoryProviders>
        <AgentComponentsDataSourceProvider dataSource={source}>
          <Probe />
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() =>
      expect(screen.getByTestId("error-state")).toHaveTextContent("is-error")
    );
  });
});
