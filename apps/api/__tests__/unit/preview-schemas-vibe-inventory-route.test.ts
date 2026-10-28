/**
 * ISS-12216: the read-only `/preview-schemas/vibe-inventory` route that
 * `prototype-pin-alias.yml` reads to decide whether a deleted vibe branch was
 * discarded, and to list live vibe environments weekly.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockValidateGitHubOidcToken, mockReadSchemaPresence, mockList } =
  vi.hoisted(() => ({
    mockValidateGitHubOidcToken: vi.fn(),
    mockReadSchemaPresence: vi.fn(),
    mockList: vi.fn(),
  }));

vi.mock("@/lib/auth/github-oidc-auth", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/github-oidc-auth")
  >("@/lib/auth/github-oidc-auth");
  return { ...actual, validateGitHubOidcToken: mockValidateGitHubOidcToken };
});

vi.mock("@/app/preview-schemas/vibe-inventory/service", () => ({
  vibeInventoryService: {
    readSchemaPresence: mockReadSchemaPresence,
    listEnvironments: mockList,
  },
}));

import { GET } from "@/app/preview-schemas/vibe-inventory/route";
import { GitHubOidcCaller } from "@/lib/auth/github-oidc-auth";

const PRESENCE = {
  branch: "vibe/bulk-tags",
  schemaName: "preview_vibe_bulk_tags_0000",
  exists: false,
};
const ENVIRONMENTS = [
  {
    branch: "vibe/bulk-tags",
    schemaName: "preview_vibe_bulk_tags_0000",
    createdAt: "2026-10-02T07:17:00.000Z",
    schemaExists: true,
    sizeBytes: 1024,
  },
];

function inventoryRequest(query = "") {
  return new NextRequest(
    `https://api.stage.example/preview-schemas/vibe-inventory${query}`
  );
}

describe("GET /preview-schemas/vibe-inventory", () => {
  beforeEach(() => {
    mockValidateGitHubOidcToken.mockResolvedValue(null);
    mockReadSchemaPresence.mockResolvedValue(PRESENCE);
    mockList.mockResolvedValue(ENVIRONMENTS);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("authenticates through the vibe inventory caller and answers nothing on a refused token", async () => {
    mockValidateGitHubOidcToken.mockResolvedValue(
      new Response("Forbidden", { status: 403 })
    );
    const request = inventoryRequest("?branch=vibe%2Fbulk-tags");

    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(mockValidateGitHubOidcToken).toHaveBeenCalledWith(request, {
      caller: GitHubOidcCaller.PreviewSchemaVibeInventory,
    });
    expect(mockReadSchemaPresence).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it("answers whether one vibe branch's schema exists", async () => {
    const response = await GET(inventoryRequest("?branch=vibe%2Fbulk-tags"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: PRESENCE });
    expect(mockReadSchemaPresence).toHaveBeenCalledWith("vibe/bulk-tags");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("lists every vibe environment without a branch", async () => {
    const response = await GET(inventoryRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { environments: ENVIRONMENTS },
    });
    expect(mockReadSchemaPresence).not.toHaveBeenCalled();
  });

  it.each([
    ["a branch outside vibe/", "?branch=functional-prototype%2Finbox"],
    [
      "a prefix that only matches case-insensitively",
      "?branch=VIBE%2Fbulk-tags",
    ],
    ["a branch outside the shared character class", "?branch=vibe%2F%40%40"],
    ["a filter the route does not implement", "?project=app-stage"],
  ])("rejects %s with 400 and reads nothing", async (_label, query) => {
    const response = await GET(inventoryRequest(query));

    expect(response.status).toBe(400);
    expect(mockReadSchemaPresence).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it("answers a fixed 500 when the read throws", async () => {
    mockList.mockRejectedValue(new Error("raw driver text"));

    const response = await GET(inventoryRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("raw driver text");
  });
});
