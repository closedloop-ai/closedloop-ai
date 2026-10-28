/**
 * ISS-7536 — proves the POST route actually routes a `createLink` failure
 * through `createArtifactLinkFailureResponse`. Without this the mapper could be
 * correct and unreachable: before ISS-7536 a duplicate link answered 500 from
 * the generic catch, which is exactly the shape a mapper-only unit test cannot
 * see.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { ProjectArtifactPlacementErrorReason } from "@repo/api/src/types/project-artifact-placement";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import {
  PLACEMENT_CYCLE_MESSAGE,
  PLACEMENT_MAX_DEPTH_MESSAGE,
} from "@/app/documents/project-artifact-placement-messages";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  DUPLICATE_ARTIFACT_LINK_MESSAGE,
  SELF_ARTIFACT_LINK_MESSAGE,
} from "../link-messages";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({
  createLink: vi.fn(),
  resolveArtifactIdentifier: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { DbNull: Symbol("DbNull") },
  ArtifactType: { DOCUMENT: "DOCUMENT" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (auth: AuthContext, request: unknown) => unknown) =>
    (request: unknown) =>
      handler(mockAuthContext, request),
}));

// Partial mock: `uuidOrSlug` from this module backs the real request validator,
// so replacing the whole module would swap the parser under test for a stub.
vi.mock("@/lib/identifier-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/identifier-utils")>()),
  resolveArtifactIdentifier: mocks.resolveArtifactIdentifier,
}));

vi.mock("../link-implementation-evidence", () => ({
  readLinkWriteAttributionEvidence: vi.fn(),
}));
vi.mock("../service", () => ({
  artifactLinksService: { createLink: mocks.createLink },
}));

import { POST } from "../route";

const SOURCE_UUID = "6f1c0c2e-0000-7000-8000-000000000001";
const TARGET_UUID = "6f1c0c2e-0000-7000-8000-000000000002";

function postLink(body: Record<string, unknown>) {
  return POST(
    createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifact-links",
      body,
    }) as never,
    undefined as never
  );
}

describe("POST /artifact-links — ISS-7536 failure mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mocks.resolveArtifactIdentifier.mockImplementation(
      async (id: string) => id
    );
  });

  it("answers 409 when the service reports a duplicate row", async () => {
    mocks.createLink.mockResolvedValue({
      ok: false,
      error: Status.Conflict,
    });

    const response = await postLink({
      sourceId: SOURCE_UUID,
      targetId: TARGET_UUID,
      linkType: LinkType.Produces,
    });

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toBe(DUPLICATE_ARTIFACT_LINK_MESSAGE);
    expect(mocks.createLink).toHaveBeenCalledTimes(1);
  });

  it("answers 400 when the service reports a self-link", async () => {
    mocks.createLink.mockResolvedValue({
      ok: false,
      error: Status.BadRequest,
    });

    const response = await postLink({
      sourceId: SOURCE_UUID,
      targetId: TARGET_UUID,
      linkType: LinkType.Produces,
    });

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe(SELF_ARTIFACT_LINK_MESSAGE);
  });

  it("answers 400 with the cycle code when the service refuses a PRODUCES cycle", async () => {
    mocks.createLink.mockResolvedValue({
      ok: false,
      error: ProjectArtifactPlacementErrorReason.Cycle,
    });

    const response = await postLink({
      sourceId: SOURCE_UUID,
      targetId: TARGET_UUID,
      linkType: LinkType.Produces,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: ProjectArtifactPlacementErrorReason.Cycle,
      error: PLACEMENT_CYCLE_MESSAGE,
    });
  });

  it("answers 400 with the depth code when the service refuses a fifth level", async () => {
    mocks.createLink.mockResolvedValue({
      ok: false,
      error: ProjectArtifactPlacementErrorReason.MaxDepth,
    });

    const response = await postLink({
      sourceId: SOURCE_UUID,
      targetId: TARGET_UUID,
      linkType: LinkType.Produces,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: ProjectArtifactPlacementErrorReason.MaxDepth,
      error: PLACEMENT_MAX_DEPTH_MESSAGE,
    });
  });

  it("rejects a slug aliased onto its own UUID, which Zod passes through", async () => {
    // Distinct strings on the wire, one artifact after resolution — the case
    // the request validator structurally cannot catch.
    mocks.resolveArtifactIdentifier.mockResolvedValue(SOURCE_UUID);
    mocks.createLink.mockResolvedValue({
      ok: false,
      error: Status.BadRequest,
    });

    const response = await postLink({
      sourceId: "PRD-42",
      targetId: SOURCE_UUID,
      linkType: LinkType.Produces,
    });

    expect(response.status).toBe(400);
    expect(mocks.createLink).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      expect.objectContaining({
        sourceId: SOURCE_UUID,
        targetId: SOURCE_UUID,
      }),
      undefined
    );
  });

  it("answers 400 from the validator before the service is reached", async () => {
    const response = await postLink({
      sourceId: SOURCE_UUID,
      targetId: SOURCE_UUID,
      linkType: LinkType.Produces,
    });

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain(SELF_ARTIFACT_LINK_MESSAGE);
    expect(json.error).toContain("targetId");
    expect(mocks.createLink).not.toHaveBeenCalled();
  });

  it("returns the created link untouched on success", async () => {
    mocks.createLink.mockResolvedValue({
      ok: true,
      value: {
        id: "link-1",
        organizationId: mockAuthContext.user.organizationId,
        sourceId: SOURCE_UUID,
        targetId: TARGET_UUID,
        linkType: LinkType.Produces,
        metadata: null,
        createdAt: new Date("2026-08-22T00:00:00.000Z"),
      },
    });

    const response = await postLink({
      sourceId: SOURCE_UUID,
      targetId: TARGET_UUID,
      linkType: LinkType.Produces,
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.id).toBe("link-1");
  });
});

describe("POST /artifact-links — DOC-* slugs (ISS-10984)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("resolves a DOC-* source slug instead of rejecting it in the validator", async () => {
    mocks.resolveArtifactIdentifier.mockImplementation(async (id: string) =>
      id === "DOC-39" ? SOURCE_UUID : id
    );
    mocks.createLink.mockResolvedValue({
      ok: true,
      value: {
        id: "link-doc",
        organizationId: mockAuthContext.user.organizationId,
        sourceId: SOURCE_UUID,
        targetId: TARGET_UUID,
        linkType: LinkType.RelatesTo,
        metadata: null,
        createdAt: new Date("2026-09-23T00:00:00.000Z"),
      },
    });

    const response = await postLink({
      sourceId: "DOC-39",
      targetId: TARGET_UUID,
      linkType: LinkType.RelatesTo,
    });

    expect(response.status).toBe(200);
    expect(mocks.resolveArtifactIdentifier).toHaveBeenCalledWith(
      "DOC-39",
      mockAuthContext.user.organizationId
    );
    expect(mocks.createLink).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      expect.objectContaining({ sourceId: SOURCE_UUID, targetId: TARGET_UUID }),
      undefined
    );
  });
});
