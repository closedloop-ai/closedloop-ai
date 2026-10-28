import { ArtifactType } from "@repo/api/src/types/artifact";
import { ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE } from "@repo/api/src/types/artifact-collaborators";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  organizationId: "11111111-1111-4111-8111-111111111111",
  readBatch: vi.fn(),
  authOptions: [] as unknown[],
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>, options: unknown) =>
    (request: NextRequest) => {
      mocks.authOptions.push(options);
      return handler(
        { user: { organizationId: mocks.organizationId } },
        request
      );
    },
}));
vi.mock("./service", () => ({
  artifactCollaboratorsService: { readBoundedBatch: mocks.readBatch },
}));

import { GET } from "./route";

const SESSION_ID = "55555555-5555-4555-8555-555555555551";
const OTHER_SESSION_ID = "55555555-5555-4555-8555-555555555552";

describe("GET /artifacts/collaborators", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authOptions.length = 0;
    mocks.readBatch.mockResolvedValue({ ok: true, value: { results: [] } });
  });

  it("passes repeated IDs and the authenticated organization to one batch read", async () => {
    const url = new URL("https://api.example.test/artifacts/collaborators");
    url.searchParams.set("artifactType", ArtifactType.Session);
    url.searchParams.append("artifactIds", SESSION_ID);
    url.searchParams.append("artifactIds", OTHER_SESSION_ID);

    const response = await GET(new NextRequest(url), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { results: [] },
    });
    expect(mocks.readBatch).toHaveBeenCalledWith(mocks.organizationId, {
      artifactType: ArtifactType.Session,
      artifactIds: [SESSION_ID, OTHER_SESSION_ID],
    });
    expect(mocks.authOptions).toEqual([{ requiredScopes: ["read"] }]);
  });

  it("accepts one ID without requiring an array-shaped query encoder", async () => {
    const url = new URL("https://api.example.test/artifacts/collaborators");
    url.searchParams.set("artifactType", ArtifactType.Branch);
    url.searchParams.set("artifactIds", SESSION_ID);

    const response = await GET(new NextRequest(url), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(200);
    expect(mocks.readBatch).toHaveBeenCalledWith(mocks.organizationId, {
      artifactType: ArtifactType.Branch,
      artifactIds: [SESSION_ID],
    });
  });

  it("rejects client-supplied organization scope before the service runs", async () => {
    const url = new URL("https://api.example.test/artifacts/collaborators");
    url.searchParams.set("artifactType", ArtifactType.Session);
    url.searchParams.set("artifactIds", SESSION_ID);
    url.searchParams.set("organizationId", "foreign-org");

    const response = await GET(new NextRequest(url), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(400);
    expect(mocks.readBatch).not.toHaveBeenCalled();
  });

  it("returns a typed non-2xx error when the read fails", async () => {
    mocks.readBatch.mockRejectedValue(new Error("database unavailable"));
    const url = new URL("https://api.example.test/artifacts/collaborators");
    url.searchParams.set("artifactType", ArtifactType.Session);
    url.searchParams.set("artifactIds", SESSION_ID);

    const response = await GET(new NextRequest(url), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBeGreaterThanOrEqual(500);
    await expect(response.json()).resolves.toMatchObject({ success: false });
  });
  it("returns the retryable budget code without a partial result", async () => {
    mocks.readBatch.mockResolvedValue({
      ok: false,
      error: ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE,
    });
    const url = new URL("https://api.example.test/artifacts/collaborators");
    url.searchParams.set("artifactType", ArtifactType.Branch);
    url.searchParams.set("artifactIds", SESSION_ID);

    const response = await GET(new NextRequest(url), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE,
    });
  });
});
