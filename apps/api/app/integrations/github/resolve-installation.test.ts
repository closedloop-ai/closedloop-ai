import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks
const { resolveInstallation } = await import("./service");

const INSTALLATION_A = {
  id: 100,
  account: { id: 1, login: "org-a", type: "Organization" },
  permissions: {},
  events: [],
  repository_selection: "all",
};

const INSTALLATION_B = {
  id: 200,
  account: { id: 2, login: "org-b", type: "Organization" },
  permissions: {},
  events: [],
  repository_selection: "selected",
};

function mockInstallationsResponse(installations: (typeof INSTALLATION_A)[]) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ installations }),
  });
}

describe("resolveInstallation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves when exactly one installation exists (no installationId provided)", async () => {
    mockInstallationsResponse([INSTALLATION_A]);

    const result = await resolveInstallation("token", undefined, "user-1");

    expect(result).toEqual({
      success: true,
      id: 100,
      info: INSTALLATION_A,
    });
  });

  it("fails when zero installations exist", async () => {
    mockInstallationsResponse([]);

    const result = await resolveInstallation("token", undefined, "user-1");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("No GitHub App installation found");
    }
  });

  it("picks first installation when multiple exist (no installationId provided)", async () => {
    mockInstallationsResponse([INSTALLATION_A, INSTALLATION_B]);

    const result = await resolveInstallation("token", undefined, "user-1");

    expect(result).toEqual({
      success: true,
      id: INSTALLATION_A.id,
      info: INSTALLATION_A,
    });
  });

  it("succeeds when installationId is provided and matches", async () => {
    mockInstallationsResponse([INSTALLATION_A, INSTALLATION_B]);

    const result = await resolveInstallation("token", "200", "user-1");

    expect(result).toEqual({
      success: true,
      id: 200,
      info: INSTALLATION_B,
    });
  });

  it("fails when installationId is provided but not accessible", async () => {
    mockInstallationsResponse([INSTALLATION_A]);

    const result = await resolveInstallation("token", "999", "user-1");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("do not have access");
    }
  });

  it("fails when GitHub API returns non-OK response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    const result = await resolveInstallation("token", undefined, "user-1");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to verify installation access");
    }
  });
});
