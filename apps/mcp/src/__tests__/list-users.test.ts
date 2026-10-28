import { ApproverRole } from "@repo/api/src/types/user.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerListUsers } from "../tools/list-users.js";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../tools/tool-utils.js";
import {
  createToolHarnessWithMock,
  firstIssue,
  type PaginatedPayload,
  parseToolPayload,
  registeredInputSchema,
  registeredToolConfig,
  registeredToolName,
} from "./fixtures/tool-harness.js";

const USER_ID = "019c2991-0bce-76bc-bc7e-a4750929f668";
const OTHER_USER_ID = "019c2991-0bce-76bc-bc7e-000000000002";

const apiClient = { get: vi.fn() };

const { handler, registerTool } = createToolHarnessWithMock(
  registerListUsers,
  apiClient as unknown as ApiClient
);

const registeredName = registeredToolName(registerTool);
const registeredConfig = registeredToolConfig(registerTool);
const registeredSchema = registeredInputSchema(registerTool);

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    firstName: "Tamsin",
    lastName: "Bramley",
    email: "tamsin@example.com",
    role: ApproverRole.Engineer,
    updatedAt: "2026-01-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("list-users tool registration", () => {
  it("registers the tool as list-users", () => {
    expect(registeredName).toBe("list-users");
  });

  // Users have no slug form, so a caller told otherwise would keep passing
  // slugs to assigneeId and getting opaque server errors.
  it("says users are addressable by UUID only", () => {
    expect(registeredConfig.description).toContain("UUID only");
  });

  it("bounds limit to the shared page ceiling at both ends", () => {
    expect(
      registeredConfig.inputSchema.limit.safeParse(MAX_PAGE_LIMIT).success
    ).toBe(true);
    expect(
      firstIssue(registeredConfig.inputSchema.limit, MAX_PAGE_LIMIT + 1)?.code
    ).toBe("too_big");
    expect(firstIssue(registeredConfig.inputSchema.limit, 0)?.code).toBe(
      "too_small"
    );
  });

  it("rejects a fractional limit", () => {
    expect(firstIssue(registeredConfig.inputSchema.limit, 1.5)?.code).toBe(
      "invalid_type"
    );
  });

  it("floors offset at zero", () => {
    expect(registeredConfig.inputSchema.offset.safeParse(0).success).toBe(true);
    expect(firstIssue(registeredConfig.inputSchema.offset, -1)?.code).toBe(
      "too_small"
    );
  });

  it("rejects a fractional offset", () => {
    // A fractional offset would slice the array at a non-integer index and
    // report fractional pagination metadata back to the caller.
    expect(firstIssue(registeredConfig.inputSchema.offset, 0.5)?.code).toBe(
      "invalid_type"
    );
  });

  // Asserted against the whole registered object, not the handler: the handler
  // never applies inputSchema, so a default-paging test alone stays green with
  // `.optional()` deleted while every real no-argument call fails validation.
  it("accepts a call that supplies neither limit nor offset", () => {
    expect(registeredSchema.safeParse({}).success).toBe(true);
  });
});

describe("list-users MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads GET /users with no query params even when paging is requested", async () => {
    // The endpoint takes no paging params; buildPaginatedPayload slices
    // client-side. Asserting a request shape here would pin one that the
    // production call never sends.
    apiClient.get.mockResolvedValue([userRow()]);

    await handler({ limit: 5, offset: 2 });

    expect(apiClient.get).toHaveBeenCalledWith("/users");
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it("shapes each user down to the fields a caller assigns by", async () => {
    // Fed fields the tool omits on purpose: against a bare row this assertion
    // stays green with the shaper replaced by a raw passthrough.
    apiClient.get.mockResolvedValue([
      userRow({
        avatarUrl: "https://img.example/avatar.png",
        clerkId: "user_2abcDEF",
        organizationId: "org-1",
        phoneNumber: "+15555550123",
      }),
    ]);

    const payload = parseToolPayload(await handler({})) as PaginatedPayload;

    expect(payload.items).toEqual([
      {
        id: USER_ID,
        firstName: "Tamsin",
        lastName: "Bramley",
        email: "tamsin@example.com",
        role: ApproverRole.Engineer,
        updatedAt: "2026-01-15T10:00:00.000Z",
      },
    ]);
  });

  it("returns null for a field the API omitted rather than inventing one", async () => {
    apiClient.get.mockResolvedValue([
      userRow({ lastName: undefined, role: null, email: 42 }),
    ]);

    const payload = parseToolPayload(await handler({})) as PaginatedPayload;

    expect(payload.items[0]).toEqual({
      id: USER_ID,
      firstName: "Tamsin",
      lastName: null,
      email: null,
      role: null,
      updatedAt: "2026-01-15T10:00:00.000Z",
    });
  });

  it("defaults to the shared page limit when the caller omits one", async () => {
    apiClient.get.mockResolvedValue([userRow()]);

    const payload = parseToolPayload(await handler({})) as PaginatedPayload;

    expect(payload.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(payload.offset).toBe(0);
  });

  it("slices the full list with the caller's limit and offset", async () => {
    apiClient.get.mockResolvedValue([
      userRow(),
      userRow({ id: OTHER_USER_ID, firstName: "Cosimo" }),
    ]);

    const payload = parseToolPayload(
      await handler({ limit: 1, offset: 1 })
    ) as PaginatedPayload;

    expect(payload.total).toBe(2);
    expect(payload.returned).toBe(1);
    expect(payload.hasMore).toBe(false);
    expect(payload.nextOffset).toBeNull();
    expect(payload.items.map((item) => item.id)).toEqual([OTHER_USER_ID]);
  });

  it("advances nextOffset when the page stops short of the end", async () => {
    apiClient.get.mockResolvedValue([
      userRow(),
      userRow({ id: OTHER_USER_ID }),
    ]);

    const payload = parseToolPayload(
      await handler({ limit: 1 })
    ) as PaginatedPayload;

    expect(payload.hasMore).toBe(true);
    expect(payload.nextOffset).toBe(1);
  });

  it("returns an empty page for an org with no users", async () => {
    apiClient.get.mockResolvedValue([]);

    const payload = parseToolPayload(await handler({})) as PaginatedPayload;

    expect(payload.total).toBe(0);
    expect(payload.returned).toBe(0);
    expect(payload.hasMore).toBe(false);
    expect(payload.items).toEqual([]);
  });

  it("accepts a { data: [] } envelope from a version-skewed server", async () => {
    apiClient.get.mockResolvedValue({ data: [userRow()] });

    const payload = parseToolPayload(await handler({})) as PaginatedPayload;

    expect(payload.total).toBe(1);
    expect(payload.items[0]?.id).toBe(USER_ID);
  });

  it("errors instead of reporting an empty org when the payload is not a list", async () => {
    apiClient.get.mockResolvedValue({ users: [userRow()] });

    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Expected array response");
  });

  it("surfaces an API failure as an error result instead of a false success", async () => {
    apiClient.get.mockRejectedValue(new Error("boom"));

    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("boom");
  });
});
