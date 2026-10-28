import { Priority } from "@repo/api/src/types/common.js";
import { ProjectStatus } from "@repo/api/src/types/project.js";
import { describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import type { ApiClient } from "../api-client.js";
import { registerCreateProject } from "../tools/create-project.js";
import { registerGetProject } from "../tools/get-project.js";
import { registerUpdateProject } from "../tools/update-project.js";
import {
  callToolThroughServer,
  createToolHarness,
  createToolHarnessWithMock,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

/** One named field of the schema a register function hands `registerTool`. */
function inputFieldSchema(
  register: Parameters<typeof createToolHarnessWithMock>[0],
  field: string
): ZodType {
  const { registerTool } = createToolHarnessWithMock(register, {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  } as unknown as ApiClient);
  const config = registerTool.mock.calls[0]![1] as {
    inputSchema: Record<string, ZodType>;
  };
  return config.inputSchema[field] as ZodType;
}

const TEAM_A = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const TEAM_B = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const TEAM_C = "16fd2706-8baf-433b-82eb-8c7fada847da";

describe("create-project MCP tool", () => {
  it("posts only name when no optional fields are supplied", async () => {
    const post = vi.fn().mockResolvedValue({ id: "p1", name: "My Project" });
    const handler = createToolHarness(registerCreateProject, {
      post,
    } as unknown as ApiClient);

    await handler({ name: "My Project" });

    expect(post).toHaveBeenCalledWith("/projects", { name: "My Project" });
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["name"]);
  });

  it("includes description in POST body when provided", async () => {
    const post = vi.fn().mockResolvedValue({ id: "p1", name: "My Project" });
    const handler = createToolHarness(registerCreateProject, {
      post,
    } as unknown as ApiClient);

    await handler({ name: "My Project", description: "A great project" });

    expect(post).toHaveBeenCalledWith("/projects", {
      name: "My Project",
      description: "A great project",
    });
  });

  it("includes priority in POST body when provided", async () => {
    const post = vi.fn().mockResolvedValue({ id: "p1", name: "My Project" });
    const handler = createToolHarness(registerCreateProject, {
      post,
    } as unknown as ApiClient);

    await handler({ name: "My Project", priority: Priority.High });

    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.priority).toBe(Priority.High);
    expect(body).not.toHaveProperty("description");
    expect(body).not.toHaveProperty("status");
  });

  it("includes status in POST body when provided", async () => {
    const post = vi.fn().mockResolvedValue({ id: "p1", name: "My Project" });
    const handler = createToolHarness(registerCreateProject, {
      post,
    } as unknown as ApiClient);

    await handler({ name: "My Project", status: ProjectStatus.InProgress });

    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.status).toBe(ProjectStatus.InProgress);
    expect(body).not.toHaveProperty("description");
    expect(body).not.toHaveProperty("priority");
  });

  it("returns the API response as the tool payload", async () => {
    const project = { id: "p1", name: "My Project", slug: "PRO-1" };
    const post = vi.fn().mockResolvedValue(project);
    const handler = createToolHarness(registerCreateProject, {
      post,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({ name: "My Project" }));

    expect(payload).toEqual(project);
  });

  it("forwards teamId as teamIds array in the POST body when supplied", async () => {
    const post = vi.fn().mockResolvedValue({ id: "p1", name: "My Project" });
    const handler = createToolHarness(registerCreateProject, {
      post,
    } as unknown as ApiClient);
    const teamId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    await handler({ name: "My Project", teamId });

    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.teamIds).toEqual([teamId]);
  });

  it("omits teamIds from the POST body when teamId is not supplied", async () => {
    const post = vi.fn().mockResolvedValue({ id: "p1", name: "My Project" });
    const handler = createToolHarness(registerCreateProject, {
      post,
    } as unknown as ApiClient);

    await handler({ name: "My Project" });

    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("teamIds");
  });

  it("includes teamIds alongside description, priority, and status when all are supplied", async () => {
    const post = vi.fn().mockResolvedValue({ id: "p1", name: "My Project" });
    const handler = createToolHarness(registerCreateProject, {
      post,
    } as unknown as ApiClient);
    const teamId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    await handler({
      name: "My Project",
      teamId,
      description: "A great project",
      priority: Priority.High,
      status: ProjectStatus.InProgress,
    });

    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.teamIds).toEqual([teamId]);
    expect(body.description).toBe("A great project");
    expect(body.priority).toBe(Priority.High);
    expect(body.status).toBe(ProjectStatus.InProgress);
  });
});

describe("update-project MCP tool", () => {
  it("sends an empty body when no optional fields are supplied", async () => {
    const put = vi.fn().mockResolvedValue({ id: "p1" });
    const handler = createToolHarness(registerUpdateProject, {
      put,
    } as unknown as ApiClient);

    await handler({ projectId: "PRO-1" });

    expect(put).toHaveBeenCalledWith("/projects/PRO-1", {});
  });

  it("includes name in PUT body when provided", async () => {
    const put = vi.fn().mockResolvedValue({ id: "p1" });
    const handler = createToolHarness(registerUpdateProject, {
      put,
    } as unknown as ApiClient);

    await handler({ projectId: "PRO-1", name: "Renamed Project" });

    const body = put.mock.calls[0][1] as Record<string, unknown>;
    expect(body.name).toBe("Renamed Project");
    expect(body).not.toHaveProperty("description");
    expect(body).not.toHaveProperty("priority");
    expect(body).not.toHaveProperty("status");
  });

  it("includes description in PUT body when provided", async () => {
    const put = vi.fn().mockResolvedValue({ id: "p1" });
    const handler = createToolHarness(registerUpdateProject, {
      put,
    } as unknown as ApiClient);

    await handler({ projectId: "PRO-1", description: "Updated desc" });

    const body = put.mock.calls[0][1] as Record<string, unknown>;
    expect(body.description).toBe("Updated desc");
    expect(body).not.toHaveProperty("name");
  });

  it("includes priority in PUT body when provided", async () => {
    const put = vi.fn().mockResolvedValue({ id: "p1" });
    const handler = createToolHarness(registerUpdateProject, {
      put,
    } as unknown as ApiClient);

    await handler({ projectId: "PRO-1", priority: Priority.Urgent });

    const body = put.mock.calls[0][1] as Record<string, unknown>;
    expect(body.priority).toBe(Priority.Urgent);
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("description");
    expect(body).not.toHaveProperty("status");
  });

  it("includes status in PUT body when provided", async () => {
    const put = vi.fn().mockResolvedValue({ id: "p1" });
    const handler = createToolHarness(registerUpdateProject, {
      put,
    } as unknown as ApiClient);

    await handler({ projectId: "PRO-1", status: ProjectStatus.Completed });

    const body = put.mock.calls[0][1] as Record<string, unknown>;
    expect(body.status).toBe(ProjectStatus.Completed);
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("description");
    expect(body).not.toHaveProperty("priority");
  });

  it("sends all optional fields when all are provided", async () => {
    const put = vi.fn().mockResolvedValue({ id: "p1" });
    const handler = createToolHarness(registerUpdateProject, {
      put,
    } as unknown as ApiClient);

    await handler({
      projectId: "PRO-1",
      name: "Full Update",
      teamIds: [TEAM_A, TEAM_B],
      description: "New desc",
      priority: Priority.Low,
      status: ProjectStatus.Archived,
    });

    expect(put).toHaveBeenCalledWith("/projects/PRO-1", {
      name: "Full Update",
      teamIds: [TEAM_A, TEAM_B],
      description: "New desc",
      priority: Priority.Low,
      status: ProjectStatus.Archived,
    });
  });

  // `projectsService.update` deletes every ProjectTeam row and recreates only
  // what it is handed, so the tool must be able to express the project's WHOLE
  // team set. A singular `teamId` input cannot: attaching a third team to a
  // two-team project would send one id and silently drop the other two. This is
  // the case that fails against that shape — it can only ever emit one id.
  it("forwards every teamId in the PUT body so attaching a third team keeps the first two", async () => {
    const put = vi.fn().mockResolvedValue({ id: "p1", name: "My Project" });
    const handler = createToolHarness(registerUpdateProject, {
      put,
    } as unknown as ApiClient);

    await handler({ projectId: "PRO-58", teamIds: [TEAM_A, TEAM_B, TEAM_C] });

    expect(put).toHaveBeenCalledWith("/projects/PRO-58", {
      teamIds: [TEAM_A, TEAM_B, TEAM_C],
    });
  });

  it("forwards a single teamId unwrapped rather than as a nested array", async () => {
    const put = vi.fn().mockResolvedValue({ id: "p1", name: "My Project" });
    const handler = createToolHarness(registerUpdateProject, {
      put,
    } as unknown as ApiClient);

    await handler({ projectId: "PRO-58", teamIds: [TEAM_A] });

    expect(put).toHaveBeenCalledWith("/projects/PRO-58", { teamIds: [TEAM_A] });
  });

  // The sibling of the cases above, and the half that matters on the wire: the
  // API distinguishes an ABSENT teamIds ("leave the teams alone") from a present
  // one ("replace them"), so a tool that always sent the key would re-team every
  // project on any unrelated edit.
  it("omits teamIds from the PUT body when none are supplied", async () => {
    const put = vi.fn().mockResolvedValue({ id: "p1", name: "Renamed" });
    const handler = createToolHarness(registerUpdateProject, {
      put,
    } as unknown as ApiClient);

    await handler({ projectId: "PRO-58", name: "Renamed" });

    const body = put.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("teamIds");
    expect(body.name).toBe("Renamed");
  });

  it("returns the API response as the tool payload", async () => {
    const project = { id: "p1", name: "Updated", slug: "PRO-1" };
    const put = vi.fn().mockResolvedValue(project);
    const handler = createToolHarness(registerUpdateProject, {
      put,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ projectId: "PRO-1", name: "Updated" })
    );

    expect(payload).toEqual(project);
  });
});

describe("get-project MCP tool", () => {
  it("requests the project by the given slug", async () => {
    const project = { id: "p1", slug: "PRO-1" };
    const get = vi.fn().mockResolvedValue(project);
    const handler = createToolHarness(registerGetProject, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({ projectId: "PRO-1" }));

    expect(get).toHaveBeenCalledWith("/projects/PRO-1");
    expect(payload).toEqual(project);
  });

  it("surfaces the actionable missing-projectId error through the MCP SDK", async () => {
    const result = await callToolThroughServer(
      registerGetProject,
      { get: vi.fn() } as unknown as ApiClient,
      { name: "get-project", arguments: {} }
    );

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(ACTIONABLE_PROJECT_ID_ERROR_REGEX);
    expect(result.text).toContain('"projectId"');
  });
});

// ISS-7080: a missing/blank projectId must be rejected at the schema boundary
// with an actionable message, not the SDK's opaque "-32602 … expected string,
// received undefined" that an agent cannot recover from.
describe.each([
  ["get-project", registerGetProject],
  ["update-project", registerUpdateProject],
])("%s projectId argument", (_name, register) => {
  const schema = inputFieldSchema(register, "projectId");

  it("rejects an omitted projectId with an actionable message", () => {
    const result = schema.safeParse(undefined);

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0].message.toLowerCase();
      // Substance check: names the entity as required and the discovery tool,
      // so the message survives copy edits but fails if it reverts to the raw
      // "expected string, received undefined".
      expect(message).toContain("required");
      expect(message).toContain("list-projects");
    }
  });

  it("rejects values that could retarget the request path", () => {
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse("   ").success).toBe(false);
    expect(schema.safeParse(".").success).toBe(false);
    expect(schema.safeParse("..").success).toBe(false);
  });

  it("accepts a valid slug and trims surrounding whitespace", () => {
    const result = schema.safeParse("  PRO-7  ");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("PRO-7");
    }
  });
});

const ACTIONABLE_PROJECT_ID_ERROR_REGEX =
  /Project UUID or user-facing slug is required.*list-projects/s;

// ---------------------------------------------------------------------------
// ISS-9441 — clearing a project's priority over MCP
// ---------------------------------------------------------------------------

describe("update-project priority clear", () => {
  it("sends priority: null in the PUT body for an explicit null", async () => {
    const put = vi.fn().mockResolvedValue({ id: "p1" });
    const handler = createToolHarness(registerUpdateProject, {
      put,
    } as unknown as ApiClient);

    await handler({ projectId: "PRO-1", priority: null });

    const body = put.mock.calls[0][1] as Record<string, unknown>;
    // Both halves matter: a truthiness guard on the forward would drop the key
    // entirely, which the API reads as "leave the priority alone" rather than
    // as the clear the caller asked for.
    expect(body).toHaveProperty("priority");
    expect(body.priority).toBeNull();
  });

  it("accepts null at the schema boundary and still refuses a non-member", () => {
    const schema = inputFieldSchema(registerUpdateProject, "priority");

    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse("NONE").success).toBe(false);
  });

  it("refuses null on create, where omission already means no priority", () => {
    // The asymmetry is deliberate and mirrors `createProjectValidator`: on
    // create there is no existing value to clear, so `null` would be a second
    // spelling of omission.
    const schema = inputFieldSchema(registerCreateProject, "priority");

    expect(schema.safeParse(null).success).toBe(false);
  });
});
