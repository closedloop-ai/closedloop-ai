import { Priority } from "@repo/api/src/types/common.js";
import { ProjectStatus } from "@repo/api/src/types/project.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerCreateProject } from "../tools/create-project.js";
import { registerUpdateProject } from "../tools/update-project.js";
import {
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

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
      description: "New desc",
      priority: Priority.Low,
      status: ProjectStatus.Archived,
    });

    expect(put).toHaveBeenCalledWith("/projects/PRO-1", {
      name: "Full Update",
      description: "New desc",
      priority: Priority.Low,
      status: ProjectStatus.Archived,
    });
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
