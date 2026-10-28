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
  useCompleteAgentComponents,
} from "../use-agent-components";

// Fixtures

function makeComponent(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  return {
    id: "uuid-0001",
    slug: overrides.slug ?? "subagent::test-subagent",
    name: "Test Subagent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 10,
    sessions: 3,
    locPerDollar: 2.5,
    trend: [1, 2, 3],
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
    versions: [],
    resolvedState: "unresolved",
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
  };
}

function makeListResponse(
  items: AgentComponent[] = []
): AgentComponentListResponse {
  return { items, total: items.length };
}

// Spy source factory

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
    honorsDateWindow: false,
    list: listSpy,
    detail: detailSpy,
    listSpy,
    detailSpy,
  };
}

// agentComponentKeys — query key factory

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

// useAgentComponents

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

// useAgentComponentDetail

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
      honorsDateWindow: false,
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

// useCompleteAgentComponents (ISS-6891)

/** Page size the paging cases request, small enough to force several pages. */
const PAGE_SIZE = 10;
/**
 * A population deliberately larger than one page, so keeping the first page and
 * calling it the inventory is observably wrong. The last id is only reachable
 * once the pages are followed.
 */
const POPULATION_SIZE = 34;
const LAST_ID = `component-${POPULATION_SIZE - 1}`;

/**
 * A source that pages honestly: it slices its own population on the requested
 * `limit`/`offset` and reports the population's real `total`/`hasMore`.
 */
function pagingSource(populationSize: number, scope = "paging"): SpySource {
  const population = Array.from({ length: populationSize }, (_unused, index) =>
    makeComponent({ id: `component-${index}` })
  );
  const listSpy = vi.fn((filters: { limit?: number; offset?: number }) => {
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? population.length;
    const items = population.slice(offset, offset + limit);
    return Promise.resolve({
      items,
      total: population.length,
      hasMore: offset + items.length < population.length,
    });
  });
  const detailSpy = vi.fn((slug: string) =>
    Promise.resolve(makeDetail({ id: slug }))
  );
  return {
    scope,
    honorsDateWindow: false,
    list: listSpy,
    detail: detailSpy,
    listSpy,
    detailSpy,
  };
}

function renderPopulationProbe(source: SpySource) {
  function Probe() {
    const { data } = useCompleteAgentComponents({ limit: PAGE_SIZE });
    if (!data) {
      return <span data-testid="population">loading</span>;
    }
    return (
      <span data-testid="population">{`${data.items.length}|${data.total}|${data.hasMore}|${data.items.at(-1)?.id}`}</span>
    );
  }

  render(
    <AppCoreStoryProviders>
      <AgentComponentsDataSourceProvider dataSource={source}>
        <Probe />
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

describe("useCompleteAgentComponents", () => {
  it("follows every page instead of stopping at the first", async () => {
    const source = pagingSource(POPULATION_SIZE);

    renderPopulationProbe(source);

    // Pinned to independent literals, not re-derived from the paging helper: a
    // first-page-only read returns 10 items and never reaches `component-33`.
    await waitFor(() =>
      expect(screen.getByTestId("population")).toHaveTextContent(
        `34|34|false|${LAST_ID}`
      )
    );
    // #6483: TWO requests, and the second asks for the whole population from
    // offset 0 rather than for the next window. A page walk was four requests
    // stitched from four independent server snapshots, which is both how a
    // boundary-shifted row got counted twice and why each further page cost
    // another full population rebuild on the server.
    expect(source.listSpy).toHaveBeenCalledTimes(2);
    expect(source.listSpy).toHaveBeenNthCalledWith(1, {
      limit: PAGE_SIZE,
      offset: 0,
    });
    expect(source.listSpy).toHaveBeenLastCalledWith({
      limit: POPULATION_SIZE,
      offset: 0,
    });
  });

  it("stops at one page for a source that reports no continuation", async () => {
    const source = spyingSource("single-page");

    renderPopulationProbe(source);

    // The compatibility path: an older source omits `hasMore` and reports a
    // `total` its single page already satisfies. Degrading to one page is right;
    // spinning on a missing field is not.
    await waitFor(() =>
      expect(screen.getByTestId("population")).toHaveTextContent(
        "1|1|false|uuid-0001"
      )
    );
    expect(source.listSpy).toHaveBeenCalledTimes(1);
  });

  it("reports `hasMore` when a source stops short of its own total", async () => {
    const source = spyingSource("short-source");
    source.listSpy.mockResolvedValue({
      items: [makeComponent({ id: "only-one" })],
      total: 9,
      hasMore: false,
    });

    renderPopulationProbe(source);

    // A source that says "no more" while its own `total` says otherwise is
    // believed about stopping — but the population it returned is NOT the whole
    // one, and saying so is the honest answer.
    await waitFor(() =>
      expect(screen.getByTestId("population")).toHaveTextContent(
        "1|9|true|only-one"
      )
    );
    expect(source.listSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps its own cache branch under `lists()` so the live bridge invalidates it", () => {
    const key = agentComponentKeys.population("http", { limit: PAGE_SIZE });

    // Nested under `lists()` (prefix-matched by the bridge's invalidation) but
    // distinct from a single-page `list` entry for the same filters, so neither
    // can be served from the other's cache.
    expect(key.slice(0, 2)).toEqual([...agentComponentKeys.lists()]);
    expect(key).not.toEqual(
      agentComponentKeys.list("http", { limit: PAGE_SIZE })
    );
  });
});
