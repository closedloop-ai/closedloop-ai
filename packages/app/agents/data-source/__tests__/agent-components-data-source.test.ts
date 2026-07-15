import {
  type AgentComponent,
  type AgentComponentDetail,
  AgentComponentKind,
  type AgentComponentListResponse,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import {
  adaptAgentComponentToResponse,
  createHttpAgentComponentsDataSource,
} from "../agent-components-data-source";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeComponent(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  return {
    id: "uuid-1234-5678-abcd-efgh",
    name: "Test Subagent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 42,
    sessions: 7,
    klocPerDollar: 3.14,
    trend: [1, 2, 3],
    owner: "alice",
    collaborators: ["bob", "carol"],
    computeTargetIds: ["target-1"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeListResponse(
  items: AgentComponent[] = []
): AgentComponentListResponse {
  return { items, total: items.length, hasMore: false };
}

// ---------------------------------------------------------------------------
// Recording HTTP client
// ---------------------------------------------------------------------------

function createRecordingGet(
  requestedPaths: string[],
  respond: (path: string) => unknown = () => makeListResponse()
) {
  return function get<T>(path: string): Promise<T> {
    requestedPaths.push(path);
    return Promise.resolve(respond(path) as T);
  };
}

// ---------------------------------------------------------------------------
// T-10.4: Real HTTP data source tests
// ---------------------------------------------------------------------------

describe("createHttpAgentComponentsDataSource", () => {
  it("calls GET /agent-components (not /agents) for list with no filters", async () => {
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths),
    });

    await source.list({});

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("/agent-components");
    expect(paths[0]).not.toContain("/agents");
  });

  it("serialises kinds as repeated query params in the list URL", async () => {
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths),
    });

    await source.list({
      kinds: [AgentComponentKind.Skill, AgentComponentKind.Command],
    });

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("kinds=skill");
    expect(paths[0]).toContain("kinds=command");
  });

  it("omits the query string when no filters are provided", async () => {
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths),
    });

    await source.list({});

    // No '?' in the URL when filters are empty
    expect(paths[0]).not.toContain("?");
  });

  it("calls GET /agent-components/:slug for detail with a UUID slug", async () => {
    const slug = "550e8400-e29b-41d4-a716-446655440000";
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () => ({
        ...makeComponent({ id: slug }),
        properties: {
          path: "/path/to/agent.md",
          format: "md",
        },
        prompt: "You are an expert…",
        sessionsTab: [],
        branchesTab: [],
        provenance: [],
        usageSessions: [],
      })),
    });

    await source.detail(slug);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(`/agent-components/${slug}`);
  });

  it("scope is 'agent-components:http'", () => {
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet([]),
    });
    expect(source.scope).toBe("agent-components:http");
  });

  it("has no subscribe method (HTTP is poll-only)", () => {
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet([]),
    });
    expect(source.subscribe).toBeUndefined();
  });
});

describe("adaptAgentComponentToResponse", () => {
  it("produces an AgentComponent with all required fields (no undefined)", () => {
    const raw = makeComponent();
    const adapted = adaptAgentComponentToResponse(raw);

    // All fields present and not undefined
    expect(adapted.id).toBe(raw.id);
    expect(adapted.name).toBe(raw.name);
    expect(adapted.kind).toBe(raw.kind);
    expect(adapted.sourceType).toBe(raw.sourceType);
    expect(adapted.source).toBe(raw.source);
    expect(adapted.harness).toBe(raw.harness);
    expect(adapted.invocations).toBe(raw.invocations);
    expect(adapted.sessions).toBe(raw.sessions);
    expect(adapted.klocPerDollar).toBe(raw.klocPerDollar);
    expect(adapted.trend).toEqual(raw.trend);
    expect(adapted.owner).toBe(raw.owner);
    expect(adapted.collaborators).toEqual(raw.collaborators);
    expect(adapted.computeTargetIds).toEqual(raw.computeTargetIds);
    expect(adapted.firstSeenAt).toBe(raw.firstSeenAt);
    expect(adapted.lastSeenAt).toBe(raw.lastSeenAt);
  });

  it("id is the DB UUID (not a colon-slug)", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const raw = makeComponent({ id: uuid });
    const adapted = adaptAgentComponentToResponse(raw);
    expect(adapted.id).toBe(uuid);
    expect(adapted.id).not.toContain(":");
  });

  it("preserves null owner", () => {
    const raw = makeComponent({ owner: null });
    const adapted = adaptAgentComponentToResponse(raw);
    expect(adapted.owner).toBeNull();
  });

  it("preserves null invocations and sessions for configured-only kinds", () => {
    const raw = makeComponent({
      kind: AgentComponentKind.Hook,
      invocations: null,
      sessions: null,
      klocPerDollar: null,
    });
    const adapted = adaptAgentComponentToResponse(raw);
    expect(adapted.invocations).toBeNull();
    expect(adapted.sessions).toBeNull();
    expect(adapted.klocPerDollar).toBeNull();
  });

  it("list() maps all items through adaptAgentComponentToResponse", async () => {
    const component1 = makeComponent({ id: "uuid-001", name: "Agent One" });
    const component2 = makeComponent({
      id: "uuid-002",
      name: "Agent Two",
      kind: AgentComponentKind.Command,
    });
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () =>
        makeListResponse([component1, component2])
      ),
    });

    const result = await source.list({});

    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe("uuid-001");
    expect(result.items[1].id).toBe("uuid-002");
    expect(result.total).toBe(2);
  });
});

describe("createHttpAgentComponentsDataSource detail call", () => {
  it("calls GET /agent-components/:slug with a UUID slug", async () => {
    const slug = "550e8400-e29b-41d4-a716-446655440000";
    const paths: string[] = [];
    const detail: AgentComponentDetail = {
      ...makeComponent({ id: slug }),
      properties: { path: "/agents/my-agent.md", format: "md" },
      prompt: "You are a helpful agent.",
      sessionsTab: [],
      branchesTab: [],
      provenance: [],
      usageSessions: [],
    };
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () => detail),
    });

    const result = await source.detail(slug);

    expect(paths[0]).toBe(`/agent-components/${slug}`);
    expect(result.id).toBe(slug);
  });
});
