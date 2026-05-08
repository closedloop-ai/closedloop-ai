import type {
  AgentDetail,
  AgentListResponse,
  BulkIngestAgentResponse,
} from "@repo/api/src/types/agent";
import { vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

vi.mock("@/lib/auth/with-any-auth", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock requires generic function type
  withAnyAuth: (handler: Function) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));

vi.mock("@/lib/auth/org-admin", () => ({
  isOrgAdmin: vi.fn().mockResolvedValue(true),
}));

vi.mock("./service");
vi.mock("@/lib/identifier-utils", () => ({
  isUuid: vi.fn((v: string) => UUID_REGEX.test(v)),
}));

import { isOrgAdmin } from "@/lib/auth/org-admin";
import { GET, POST } from "./route";
import { agentsService } from "./service";

const NOW = new Date("2026-04-24T12:00:00Z");

const MOCK_AGENT_DETAIL: AgentDetail = {
  id: "agent-1",
  name: "Frontend Architect",
  slug: "frontend-architect",
  role: "frontend-architect",
  description: "Specializes in React",
  enabled: true,
  sourceRepo: "closedloop-ai/symphony-alpha",
  currentVersion: 1,
  createdAt: NOW,
  updatedAt: NOW,
  prompt: "---\nname: frontend-architect\n---\nYou are...",
  bootstrapRunId: "run-1",
  createdBy: { id: "user-1", firstName: "Test", lastName: "User" },
};

describe("GET /agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns agent list", async () => {
    const mockResult: AgentListResponse = {
      agents: [
        {
          id: "agent-1",
          name: "Frontend Architect",
          slug: "frontend-architect",
          role: "frontend-architect",
          description: "Specializes in React",
          enabled: true,
          sourceRepo: "",
          currentVersion: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      total: 1,
    };

    vi.mocked(agentsService.findAll).mockResolvedValue(mockResult);

    const request = createMockRequest({
      url: "http://localhost:3002/agents",
    });
    const response = await GET(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.total).toBe(1);
    expect(json.data.agents).toHaveLength(1);
    expect(agentsService.findAll).toHaveBeenCalledWith("test-org-id", {});
  });

  it("passes query params to service", async () => {
    vi.mocked(agentsService.findAll).mockResolvedValue({
      agents: [],
      total: 0,
    });

    const request = createMockRequest({
      url: "http://localhost:3002/agents?enabled=true&search=frontend",
    });
    const response = await GET(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
    expect(agentsService.findAll).toHaveBeenCalledWith("test-org-id", {
      enabled: true,
      search: "frontend",
    });
  });
});

describe("POST /agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("creates an agent", async () => {
    vi.mocked(agentsService.create).mockResolvedValue(MOCK_AGENT_DETAIL);

    const request = createMockRequest({
      url: "http://localhost:3002/agents",
      method: "POST",
      body: {
        name: "Frontend Architect",
        role: "frontend-architect",
        prompt: "You are a frontend expert",
      },
    });
    const response = await POST(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.slug).toBe("frontend-architect");
    expect(agentsService.create).toHaveBeenCalledWith(
      "test-org-id",
      "test-user-id",
      {
        name: "Frontend Architect",
        role: "frontend-architect",
        prompt: "You are a frontend expert",
      }
    );
  });

  it("returns 403 for non-admin", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValueOnce(false);

    const request = createMockRequest({
      url: "http://localhost:3002/agents",
      method: "POST",
      body: {
        name: "Test",
        role: "test",
        prompt: "test",
      },
    });
    const response = await POST(request, createMockRouteContext({}));

    expect(response.status).toBe(403);
    expect(agentsService.create).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body", async () => {
    const request = createMockRequest({
      url: "http://localhost:3002/agents",
      method: "POST",
      body: { name: "" },
    });
    const response = await POST(request, createMockRouteContext({}));

    expect(response.status).toBe(400);
  });
});

describe("GET /agents/[idOrSlug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns agent by slug", async () => {
    vi.mocked(agentsService.findByIdOrSlug).mockResolvedValue(
      MOCK_AGENT_DETAIL
    );

    const { GET: GET_DETAIL } = await import("./[idOrSlug]/route");
    const request = createMockRequest({
      url: "http://localhost:3002/agents/frontend-architect",
    });
    const response = await GET_DETAIL(
      request,
      createMockRouteContext({ idOrSlug: "frontend-architect" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.slug).toBe("frontend-architect");
  });

  it("returns 404 for unknown agent", async () => {
    vi.mocked(agentsService.findByIdOrSlug).mockResolvedValue(null);

    const { GET: GET_DETAIL } = await import("./[idOrSlug]/route");
    const request = createMockRequest({
      url: "http://localhost:3002/agents/nonexistent",
    });
    const response = await GET_DETAIL(
      request,
      createMockRouteContext({ idOrSlug: "nonexistent" })
    );

    expect(response.status).toBe(404);
  });
});

describe("PATCH /agents/[idOrSlug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("updates an agent", async () => {
    const updated = { ...MOCK_AGENT_DETAIL, currentVersion: 2 };
    vi.mocked(agentsService.update).mockResolvedValue(updated);

    const { PATCH } = await import("./[idOrSlug]/route");
    const request = createMockRequest({
      url: "http://localhost:3002/agents/frontend-architect",
      method: "PATCH",
      body: {
        prompt: "Updated prompt",
        changeNote: "Improved instructions",
      },
    });
    const response = await PATCH(
      request,
      createMockRouteContext({ idOrSlug: "frontend-architect" })
    );

    expect(response.status).toBe(200);
    expect(agentsService.update).toHaveBeenCalledWith(
      "frontend-architect",
      "test-org-id",
      "test-user-id",
      { prompt: "Updated prompt", changeNote: "Improved instructions" }
    );
  });

  it("rejects update without changeNote when prompt changes", async () => {
    const { PATCH } = await import("./[idOrSlug]/route");
    const request = createMockRequest({
      url: "http://localhost:3002/agents/frontend-architect",
      method: "PATCH",
      body: { prompt: "Updated prompt" },
    });
    const response = await PATCH(
      request,
      createMockRouteContext({ idOrSlug: "frontend-architect" })
    );

    expect(response.status).toBe(400);
  });

  it("allows enable/disable without changeNote", async () => {
    vi.mocked(agentsService.update).mockResolvedValue({
      ...MOCK_AGENT_DETAIL,
      enabled: false,
    });

    const { PATCH } = await import("./[idOrSlug]/route");
    const request = createMockRequest({
      url: "http://localhost:3002/agents/frontend-architect",
      method: "PATCH",
      body: { enabled: false },
    });
    const response = await PATCH(
      request,
      createMockRouteContext({ idOrSlug: "frontend-architect" })
    );

    expect(response.status).toBe(200);
  });
});

describe("DELETE /agents/[idOrSlug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("deletes an agent", async () => {
    vi.mocked(agentsService.delete).mockResolvedValue(true);

    const { DELETE } = await import("./[idOrSlug]/route");
    const request = createMockRequest({
      url: "http://localhost:3002/agents/frontend-architect",
      method: "DELETE",
    });
    const response = await DELETE(
      request,
      createMockRouteContext({ idOrSlug: "frontend-architect" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.deleted).toBe(true);
  });

  it("returns 404 for unknown agent", async () => {
    vi.mocked(agentsService.delete).mockResolvedValue(false);

    const { DELETE } = await import("./[idOrSlug]/route");
    const request = createMockRequest({
      url: "http://localhost:3002/agents/nonexistent",
      method: "DELETE",
    });
    const response = await DELETE(
      request,
      createMockRouteContext({ idOrSlug: "nonexistent" })
    );

    expect(response.status).toBe(404);
  });
});

describe("GET /agents/[idOrSlug]/versions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns version list", async () => {
    vi.mocked(agentsService.findVersions).mockResolvedValue([
      {
        id: "v-1",
        version: 2,
        name: "Frontend Architect",
        changeNote: "Updated prompt",
        changedBy: { id: "user-1", firstName: "Test", lastName: "User" },
        createdAt: NOW,
      },
      {
        id: "v-0",
        version: 1,
        name: "Frontend Architect",
        changeNote: "Initial version",
        changedBy: { id: "user-1", firstName: "Test", lastName: "User" },
        createdAt: NOW,
      },
    ]);

    const { GET: GET_VERSIONS } = await import("./[idOrSlug]/versions/route");
    const request = createMockRequest({
      url: "http://localhost:3002/agents/frontend-architect/versions",
    });
    const response = await GET_VERSIONS(
      request,
      createMockRouteContext({ idOrSlug: "frontend-architect" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.versions).toHaveLength(2);
  });

  it("returns 404 for unknown agent", async () => {
    vi.mocked(agentsService.findVersions).mockResolvedValue(null);

    const { GET: GET_VERSIONS } = await import("./[idOrSlug]/versions/route");
    const request = createMockRequest({
      url: "http://localhost:3002/agents/nonexistent/versions",
    });
    const response = await GET_VERSIONS(
      request,
      createMockRouteContext({ idOrSlug: "nonexistent" })
    );

    expect(response.status).toBe(404);
  });
});

describe("GET /agents/[idOrSlug]/versions/[version]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns specific version", async () => {
    vi.mocked(agentsService.findVersion).mockResolvedValue({
      id: "v-1",
      version: 1,
      name: "Frontend Architect",
      changeNote: "Initial version",
      changedBy: { id: "user-1", firstName: "Test", lastName: "User" },
      createdAt: NOW,
      prompt: "You are a frontend expert",
    });

    const { GET: GET_VERSION } = await import(
      "./[idOrSlug]/versions/[version]/route"
    );
    const request = createMockRequest({
      url: "http://localhost:3002/agents/frontend-architect/versions/1",
    });
    const response = await GET_VERSION(
      request,
      createMockRouteContext({
        idOrSlug: "frontend-architect",
        version: "1",
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.version).toBe(1);
    expect(json.data.prompt).toBe("You are a frontend expert");
  });

  it("returns 400 for invalid version", async () => {
    const { GET: GET_VERSION } = await import(
      "./[idOrSlug]/versions/[version]/route"
    );
    const request = createMockRequest({
      url: "http://localhost:3002/agents/frontend-architect/versions/abc",
    });
    const response = await GET_VERSION(
      request,
      createMockRouteContext({
        idOrSlug: "frontend-architect",
        version: "abc",
      })
    );

    expect(response.status).toBe(400);
  });
});

describe("POST /agents/bulk-ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("bulk ingests agents", async () => {
    const mockResult: BulkIngestAgentResponse = {
      created: 2,
      updated: 0,
      agents: [
        {
          id: "a-1",
          name: "Frontend",
          slug: "frontend",
          role: "frontend",
          description: null,
          enabled: true,
          sourceRepo: "org/repo",
          currentVersion: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "a-2",
          name: "Backend",
          slug: "backend",
          role: "backend",
          description: null,
          enabled: true,
          sourceRepo: "org/repo",
          currentVersion: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };

    vi.mocked(agentsService.bulkIngest).mockResolvedValue(mockResult);

    const { POST: POST_INGEST } = await import("./bulk-ingest/route");
    const request = createMockRequest({
      url: "http://localhost:3002/agents/bulk-ingest",
      method: "POST",
      body: {
        agents: [
          { name: "Frontend", role: "frontend", prompt: "You are..." },
          { name: "Backend", role: "backend", prompt: "You are..." },
        ],
        bootstrapRunId: "run-1",
        sourceRepo: "org/repo",
      },
    });
    const response = await POST_INGEST(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.created).toBe(2);
    expect(json.data.updated).toBe(0);
  });

  it("returns 403 for non-admin", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValueOnce(false);

    const { POST: POST_INGEST } = await import("./bulk-ingest/route");
    const request = createMockRequest({
      url: "http://localhost:3002/agents/bulk-ingest",
      method: "POST",
      body: {
        agents: [{ name: "Test", role: "test", prompt: "p" }],
        bootstrapRunId: "run-1",
        sourceRepo: "org/repo",
      },
    });
    const response = await POST_INGEST(request, createMockRouteContext({}));

    expect(response.status).toBe(403);
  });

  it("returns 400 for empty agents array", async () => {
    const { POST: POST_INGEST } = await import("./bulk-ingest/route");
    const request = createMockRequest({
      url: "http://localhost:3002/agents/bulk-ingest",
      method: "POST",
      body: {
        agents: [],
        bootstrapRunId: "run-1",
        sourceRepo: "org/repo",
      },
    });
    const response = await POST_INGEST(request, createMockRouteContext({}));

    expect(response.status).toBe(400);
  });
});
