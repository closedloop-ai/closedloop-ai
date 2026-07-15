import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RepoComponentsTruncatedError,
  RepoTreeTruncatedError,
} from "../../pack-repo-import";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  isOrgAdmin: vi.fn(),
  importPackRepoComponents: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(
        {
          user: mocks.user,
          clerkOrgId: "clerk-org-1",
          clerkUserId: "clerk-user-1",
        },
        request,
        context.params
      ),
}));

vi.mock("@/lib/auth/org-admin", () => ({
  isOrgAdmin: mocks.isOrgAdmin,
}));

vi.mock("../../service", () => ({
  importPackRepoComponents: mocks.importPackRepoComponents,
}));

import { POST } from "./route";

const PACK_ID = "pack-uuid-1";

function request(body: unknown) {
  return new NextRequest(
    "https://api.example.test/catalog/pack-uuid-1/import-repo",
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
}

function routeContext() {
  return { params: Promise.resolve({ id: PACK_ID }) };
}

function invoke(body: unknown) {
  return POST(request(body), routeContext());
}

const validBody = { repoFullName: "acme/shared-assets" };

describe("POST /catalog/[id]/import-repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isOrgAdmin.mockResolvedValue(true);
  });

  it("returns 200 with the import result on success", async () => {
    mocks.importPackRepoComponents.mockResolvedValue({
      ok: true,
      value: { created: 3, skipped: 1, invalid: 0 },
    });

    const response = await invoke(validBody);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual({ created: 3, skipped: 1, invalid: 0 });
  });

  it("surfaces RepoTreeTruncatedError as a 422 with its actionable message", async () => {
    // The service delegates to fetchRepoComponents, which throws when GitHub
    // truncates the recursive tree. That guidance ("narrow the import with a
    // subPath") must reach the admin instead of collapsing into a generic 500.
    const error = new RepoTreeTruncatedError("acme", "shared-assets");
    mocks.importPackRepoComponents.mockRejectedValue(error);

    const response = await invoke(validBody);

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.success).toBe(false);
    // The response carries the error's actionable guidance verbatim, not the
    // opaque "Failed to import from repo" fallback.
    expect(json.error).toBe(error.message);
    expect(json.error).toContain("subPath");
  });

  it("surfaces RepoComponentsTruncatedError as a 422 with its actionable message", async () => {
    // fetchRepoComponents throws this when the candidate set exceeds the import
    // cap; slicing to the cap would silently drop components. The "narrow the
    // import with a subPath" guidance must reach the admin as a 422, not a 500.
    const error = new RepoComponentsTruncatedError(
      "acme",
      "shared-assets",
      512,
      300
    );
    mocks.importPackRepoComponents.mockRejectedValue(error);

    const response = await invoke(validBody);

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.success).toBe(false);
    // The response carries the error's actionable guidance verbatim, including
    // the candidate count, not the opaque "Failed to import from repo" fallback.
    expect(json.error).toBe(error.message);
    expect(json.error).toContain("subPath");
    expect(json.error).toContain("512");
  });

  it("collapses any other thrown error into a generic 500", async () => {
    mocks.importPackRepoComponents.mockRejectedValue(
      new Error("boom: octokit exploded")
    );

    const response = await invoke(validBody);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to import from repo");
  });

  it("returns 403 when the caller is not an org admin", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);

    const response = await invoke(validBody);

    expect(response.status).toBe(403);
    expect(mocks.importPackRepoComponents).not.toHaveBeenCalled();
  });

  it("maps a service 403 (curated / not a Pack) Result to a 403", async () => {
    mocks.importPackRepoComponents.mockResolvedValue({ ok: false, error: 403 });

    const response = await invoke(validBody);

    expect(response.status).toBe(403);
  });
});
