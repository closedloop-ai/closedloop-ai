import type { User } from "@repo/api/src/types/user";
import { ApproverRole } from "@repo/api/src/types/user";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mockResolveAnyAuthContext = vi.fn();
const mockFindById = vi.fn();
const mockAuthenticate = vi.fn();

vi.mock("@/lib/auth/resolve-any-auth-context", () => ({
  resolveAnyAuthContext: (request: Request, options?: unknown) =>
    mockResolveAnyAuthContext(request, options),
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    findById: (id: string, organizationId: string) =>
      mockFindById(id, organizationId),
  },
}));

vi.mock("@repo/collaboration/server/auth", () => ({
  authenticate: (args: unknown) => mockAuthenticate(args),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn() },
}));

// Import after mocks are set up.
const { POST } = await import("../route");

const createMockUser = (overrides?: Partial<User>): User => ({
  id: "user-123",
  clerkId: "clerk_123",
  organizationId: "org-123",
  email: "test@example.com",
  firstName: "John",
  lastName: "Doe",
  avatarUrl: "https://example.com/avatar.jpg",
  phoneNumber: null,
  role: ApproverRole.Engineer,
  linearId: null,
  slackId: null,
  githubUsername: null,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createRequest = (body: unknown) =>
  new Request("http://localhost:3002/collaboration/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /collaboration/auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAnyAuthContext.mockResolvedValue({
      userId: "user-123",
      organizationId: "org-123",
    });
    mockFindById.mockResolvedValue(createMockUser());
    // `authenticate()` returns the Liveblocks `authorize().body` — a JSON string
    // (`{"token":"..."}`), not a bare token. The route forwards it verbatim and
    // the web callback parses it via `postRaw`, so the mock mirrors that shape.
    mockAuthenticate.mockResolvedValue({
      token: JSON.stringify({ token: "lb-token" }),
      status: 200,
    });
  });

  test("returns 401 when authentication fails", async () => {
    mockResolveAnyAuthContext.mockResolvedValueOnce(null);

    const response = await POST(createRequest({ room: "org-123:artifact:a1" }));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  test("requires write scope", async () => {
    await POST(createRequest({ room: "org-123:artifact:a1" }));

    expect(mockResolveAnyAuthContext).toHaveBeenCalledWith(
      expect.any(Request),
      { requiredScopes: ["write"] }
    );
  });

  test("mints a token for a valid same-org room", async () => {
    const response = await POST(createRequest({ room: "org-123:artifact:a1" }));

    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({ token: "lb-token" });
    expect(mockAuthenticate).toHaveBeenCalledWith({
      userId: "user-123",
      organizationId: "org-123",
      userInfo: {
        name: "John Doe",
        avatar: "https://example.com/avatar.jpg",
        color: expect.stringContaining("var(--color-"),
      },
    });
  });

  test("returns 400 for an empty room string", async () => {
    const response = await POST(createRequest({ room: "" }));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid request body");
  });

  test("returns 400 for a malformed room ID", async () => {
    const response = await POST(createRequest({ room: "invalid-format" }));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid room ID");
  });

  test("returns 400 for an invalid room type segment", async () => {
    const response = await POST(createRequest({ room: "org-123:invalid:a1" }));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid room ID");
  });

  test("returns 403 when the room belongs to another org", async () => {
    const response = await POST(createRequest({ room: "org-999:artifact:a1" }));

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  test("returns 500 when the user cannot be loaded", async () => {
    mockFindById.mockResolvedValueOnce(null);

    const response = await POST(createRequest({ room: "org-123:artifact:a1" }));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Unable to fetch user");
  });

  test("issues a global token when no room is provided", async () => {
    const response = await POST(createRequest({}));

    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({ token: "lb-token" });
    expect(mockAuthenticate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-123" })
    );
  });

  test("falls back through name fields and omits a null avatar", async () => {
    mockFindById.mockResolvedValueOnce(
      createMockUser({ firstName: null, lastName: null, avatarUrl: null })
    );

    await POST(createRequest({ room: "org-123:artifact:a1" }));

    expect(mockAuthenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        userInfo: expect.objectContaining({
          name: "test@example.com",
          avatar: undefined,
        }),
      })
    );
  });

  test("returns 500 when token minting throws", async () => {
    mockAuthenticate.mockRejectedValueOnce(new Error("Liveblocks error"));

    const response = await POST(createRequest({ room: "org-123:artifact:a1" }));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Unable to authenticate");
  });
});
