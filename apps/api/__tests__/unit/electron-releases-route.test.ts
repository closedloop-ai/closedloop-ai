import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/github", () => ({
  getLatestElectronRelease: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (ctx: unknown) => unknown) =>
    async (_request: NextRequest, _context: unknown) =>
      handler({ user: { id: "user-1", organizationId: "org-1" } }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// --- Imports (after mocks) ---

import { getLatestElectronRelease } from "@repo/github";
import { GET } from "@/app/electron-releases/route";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const mockRequest = new Request(
  "http://localhost/electron-releases"
) as NextRequest;
const mockContext = { params: Promise.resolve({}) };

describe("GET /electron-releases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with release info when getLatestElectronRelease returns a release", async () => {
    vi.mocked(getLatestElectronRelease).mockResolvedValue({
      downloadUrl: "https://example.com/app.dmg",
      version: "v1.2.3",
      releaseNotes: "Bug fixes and improvements",
    });

    const response = await GET(mockRequest, mockContext);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: {
        downloadUrl: "https://example.com/app.dmg",
        version: "v1.2.3",
        releaseNotes: "Bug fixes and improvements",
      },
    });
  });

  it("returns 404 when getLatestElectronRelease returns null", async () => {
    vi.mocked(getLatestElectronRelease).mockResolvedValue(null);

    const response = await GET(mockRequest, mockContext);
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.error).toContain("not found");
  });

  it("returns 500 when getLatestElectronRelease throws", async () => {
    vi.mocked(getLatestElectronRelease).mockRejectedValue(
      new Error("GitHub API unavailable")
    );

    const response = await GET(mockRequest, mockContext);
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.success).toBe(false);
  });
});
