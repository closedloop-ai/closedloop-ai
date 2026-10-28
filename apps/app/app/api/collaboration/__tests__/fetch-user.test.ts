import { ApproverRole, type User } from "@repo/api/src/types/user";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUser } from "../fetch-user";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn() },
}));

vi.mock("@/lib/api-origin", () => ({
  resolveApiOrigin: () => "http://localhost:3002",
}));

const mockFetch = vi.fn();

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    clerkId: "clerk-1",
    organizationId: "org-1",
    email: "person@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    avatarUrl: null,
    phoneNumber: null,
    role: ApproverRole.Engineer,
    linearId: null,
    slackId: null,
    githubUsername: null,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("fetchUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the user on a successful response", async () => {
    const user = makeUser();
    const getToken = vi.fn().mockResolvedValue("token-123");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce({ success: true, data: user }),
    });

    const result = await fetchUser(getToken);

    expect(result).toEqual(user);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3002/me",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer token-123",
        }),
      })
    );
  });

  it("returns null and logs when getToken resolves no token", async () => {
    const getToken = vi.fn().mockResolvedValue(null);

    const result = await fetchUser(getToken);

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith("Unable to fetch auth token");
  });

  it("returns null when the fetch call rejects", async () => {
    const getToken = vi.fn().mockResolvedValue("token-123");
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const result = await fetchUser(getToken);

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith("Error fetching user", {
      error: "network down",
    });
  });

  it("returns null when the response is not ok", async () => {
    const getToken = vi.fn().mockResolvedValue("token-123");
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await fetchUser(getToken);

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith("Unable to fetch user", {
      status: 503,
    });
  });

  it("returns null when the response envelope reports failure", async () => {
    const getToken = vi.fn().mockResolvedValue("token-123");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValueOnce({ success: false, error: "org mismatch" }),
    });

    const result = await fetchUser(getToken);

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith("Unable to fetch user", {
      error: "org mismatch",
    });
  });

  it("returns null when getToken throws", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("clerk unavailable"));

    const result = await fetchUser(getToken);

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith("Error fetching user", {
      error: "clerk unavailable",
    });
  });
});
