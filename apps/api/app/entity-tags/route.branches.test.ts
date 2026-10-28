/**
 * ISS-11280 branch coverage for POST/DELETE /entity-tags.
 *
 * Covers: POST's body-validation-vs-success fork and the EntityNotFoundError
 * mapping; DELETE's required-query-param guard (missing tagId, missing
 * entityId — both reach the same combined `!(tagId && entityType &&
 * entityId)` check), its second Zod-shape validation, and its own
 * EntityNotFoundError mapping.
 */
import { randomUUID } from "node:crypto";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { TagEntityType } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params),
}));

vi.mock("../tags/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tags/service")>();
  return {
    ...actual,
    tagService: {
      applyTag: vi.fn(),
      removeTag: vi.fn(),
    },
  };
});

import { EntityNotFoundError, tagService } from "../tags/service";
import { DELETE, POST } from "./route";

const TAG_ID = randomUUID();
const ENTITY_ID = randomUUID();
const ORG_ID = "test-org-id";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
});

function deleteUrl(params: Record<string, string | undefined>): string {
  const url = new URL("http://localhost:3002/api/entity-tags");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

describe("POST /entity-tags", () => {
  it("returns the parse error for an invalid body", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/api/entity-tags",
        method: "POST",
        body: { tagId: "not-a-uuid" },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(tagService.applyTag).not.toHaveBeenCalled();
  });

  it("rejects a LOOP entity type with 400 now that Loops are retired (ISS-12435)", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/api/entity-tags",
        method: "POST",
        body: {
          tagId: TAG_ID,
          entityType: TagEntityType.Loop,
          entityId: ENTITY_ID,
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(tagService.applyTag).not.toHaveBeenCalled();
  });

  it("applies the tag and returns success on a valid body", async () => {
    vi.mocked(tagService.applyTag).mockResolvedValue(true);

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/api/entity-tags",
        method: "POST",
        body: {
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual({ applied: true });
    expect(tagService.applyTag).toHaveBeenCalledWith(
      TAG_ID,
      TagEntityType.Artifact,
      ENTITY_ID,
      ORG_ID,
      { userId: "test-user-id", authMethod: "session" },
      undefined,
      undefined
    );
  });

  it("drops a claimed UI surface from an API-key write", async () => {
    mockAuthContext = createTestAuthContext({ authMethod: "api_key" });
    vi.mocked(tagService.applyTag).mockResolvedValue(true);

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/api/entity-tags",
        method: "POST",
        body: {
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
          surface: ArtifactStatusEditSurface.Detail,
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(tagService.applyTag).toHaveBeenCalledWith(
      TAG_ID,
      TagEntityType.Artifact,
      ENTITY_ID,
      ORG_ID,
      { userId: "test-user-id", authMethod: "api_key" },
      undefined,
      undefined
    );
  });

  it("rejects known bulk provenance on a single-resource apply", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/api/entity-tags",
        method: "POST",
        body: {
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
          surface: ArtifactStatusEditSurface.Bulk,
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(tagService.applyTag).not.toHaveBeenCalled();
  });

  it("omits unknown future surface provenance on apply", async () => {
    vi.mocked(tagService.applyTag).mockResolvedValue(true);

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/api/entity-tags",
        method: "POST",
        body: {
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
          surface: "future_surface",
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(tagService.applyTag).toHaveBeenCalledWith(
      TAG_ID,
      TagEntityType.Artifact,
      ENTITY_ID,
      ORG_ID,
      { userId: "test-user-id", authMethod: "session" },
      undefined,
      undefined
    );
  });

  it("maps EntityNotFoundError to a 404", async () => {
    vi.mocked(tagService.applyTag).mockRejectedValue(
      new EntityNotFoundError(TagEntityType.Artifact, ENTITY_ID)
    );

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/api/entity-tags",
        method: "POST",
        body: {
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
  });

  it("maps an unrelated error to a 500", async () => {
    vi.mocked(tagService.applyTag).mockRejectedValue(new Error("db down"));

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/api/entity-tags",
        method: "POST",
        body: {
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to apply tag");
  });
});

describe("DELETE /entity-tags", () => {
  it("returns 400 when tagId is missing", async () => {
    const response = await DELETE(
      createMockRequest({
        url: deleteUrl({
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
        }),
        method: "DELETE",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("tagId, entityType, and entityId are required");
    expect(tagService.removeTag).not.toHaveBeenCalled();
  });

  it("returns 400 when entityId is missing", async () => {
    const response = await DELETE(
      createMockRequest({
        url: deleteUrl({ tagId: TAG_ID, entityType: TagEntityType.Artifact }),
        method: "DELETE",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("tagId, entityType, and entityId are required");
    expect(tagService.removeTag).not.toHaveBeenCalled();
  });

  it("returns 400 with a distinct message when the present params fail shape validation", async () => {
    const response = await DELETE(
      createMockRequest({
        url: deleteUrl({
          tagId: "not-a-uuid",
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
        }),
        method: "DELETE",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("Invalid parameters");
    expect(tagService.removeTag).not.toHaveBeenCalled();
  });

  it("removes the tag and returns a delete response when all params are present and valid", async () => {
    vi.mocked(tagService.removeTag).mockResolvedValue(true);

    const response = await DELETE(
      createMockRequest({
        url: deleteUrl({
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
        }),
        method: "DELETE",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual({ deleted: true });
    expect(tagService.removeTag).toHaveBeenCalledWith(
      TAG_ID,
      TagEntityType.Artifact,
      ENTITY_ID,
      ORG_ID,
      { userId: "test-user-id", authMethod: "session" },
      undefined,
      undefined
    );
  });

  it("rejects known bulk provenance on a single-resource removal", async () => {
    const response = await DELETE(
      createMockRequest({
        url: deleteUrl({
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
          surface: ArtifactStatusEditSurface.Bulk,
        }),
        method: "DELETE",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(tagService.removeTag).not.toHaveBeenCalled();
  });

  it("omits unknown future and API-key surface provenance on removal", async () => {
    mockAuthContext = createTestAuthContext({ authMethod: "api_key" });
    vi.mocked(tagService.removeTag).mockResolvedValue(true);

    const response = await DELETE(
      createMockRequest({
        url: deleteUrl({
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
          surface: "future_surface",
        }),
        method: "DELETE",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(tagService.removeTag).toHaveBeenCalledWith(
      TAG_ID,
      TagEntityType.Artifact,
      ENTITY_ID,
      ORG_ID,
      { userId: "test-user-id", authMethod: "api_key" },
      undefined,
      undefined
    );
  });

  it("maps EntityNotFoundError to a 404", async () => {
    vi.mocked(tagService.removeTag).mockRejectedValue(
      new EntityNotFoundError(TagEntityType.Artifact, ENTITY_ID)
    );

    const response = await DELETE(
      createMockRequest({
        url: deleteUrl({
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
        }),
        method: "DELETE",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
  });

  it("maps an unrelated error to a 500", async () => {
    vi.mocked(tagService.removeTag).mockRejectedValue(new Error("db down"));

    const response = await DELETE(
      createMockRequest({
        url: deleteUrl({
          tagId: TAG_ID,
          entityType: TagEntityType.Artifact,
          entityId: ENTITY_ID,
        }),
        method: "DELETE",
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to remove tag");
  });
});
