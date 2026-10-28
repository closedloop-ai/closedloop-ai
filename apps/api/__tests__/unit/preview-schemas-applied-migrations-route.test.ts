/**
 * ISS-11782/ISS-11783: the read-only `/preview-schemas/applied-migrations`
 * route that `deploy-production.yml` and `stage-migrated-ref.yml` read before
 * they let a SHA reach `production` or the `stage-migrated` ref.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockValidateGitHubOidcToken, mockList } = vi.hoisted(() => ({
  mockValidateGitHubOidcToken: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock("@/lib/auth/github-oidc-auth", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/github-oidc-auth")
  >("@/lib/auth/github-oidc-auth");
  return { ...actual, validateGitHubOidcToken: mockValidateGitHubOidcToken };
});

vi.mock("@/app/preview-schemas/applied-migrations/service", () => ({
  appliedMigrationsService: { list: mockList },
}));

import { GET } from "@/app/preview-schemas/applied-migrations/route";
import { GitHubOidcCaller } from "@/lib/auth/github-oidc-auth";

const MIGRATIONS = [
  {
    name: "20260930150000_iss11212_comment_contract_core",
    finishedAt: "2026-09-30T19:07:26.000Z",
    rolledBackAt: null,
  },
  {
    name: "20261002161500_iss11212_pr_comments_reconcile_attempted_at",
    finishedAt: null,
    rolledBackAt: null,
  },
];

function appliedRequest() {
  return new NextRequest(
    "https://api.stage.example/preview-schemas/applied-migrations"
  );
}

describe("GET /preview-schemas/applied-migrations", () => {
  beforeEach(() => {
    mockValidateGitHubOidcToken.mockResolvedValue(null);
    mockList.mockResolvedValue(MIGRATIONS);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("authenticates through the applied-migrations caller and reads nothing on a refused token", async () => {
    mockValidateGitHubOidcToken.mockResolvedValue(
      new Response("Forbidden", { status: 403 })
    );
    const request = appliedRequest();

    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(mockValidateGitHubOidcToken).toHaveBeenCalledWith(request, {
      caller: GitHubOidcCaller.PreviewSchemaAppliedMigrations,
    });
    expect(mockList).not.toHaveBeenCalled();
  });

  it("answers every recorded migration, unfinished ones included", async () => {
    const response = await GET(appliedRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { migrations: MIGRATIONS },
    });
  });

  it("answers a fixed 500 when the read throws", async () => {
    mockList.mockRejectedValue(new Error("raw driver text"));

    const response = await GET(appliedRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("raw driver text");
  });
});
