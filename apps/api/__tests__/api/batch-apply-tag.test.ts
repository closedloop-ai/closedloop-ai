import { randomUUID } from "node:crypto";
import { TagEntityType } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EntityNotFoundError, tagService } from "@/app/tags/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/app/tags/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/tags/service")>();
  return {
    ...original,
    tagService: {
      batchApplyTag: vi.fn(),
    },
  };
});

import { POST } from "@/app/entity-tags/batch/route";

describe("POST /entity-tags/batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  describe("validation", () => {
    it("returns 400 when tagId is missing", async () => {
      const request = createMockRequest({
        url: "http://localhost:3002/api/entity-tags/batch",
        method: "POST",
        body: {
          entityType: TagEntityType.Artifact,
          entityIds: [randomUUID()],
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it("returns 400 when entityIds is empty", async () => {
      const request = createMockRequest({
        url: "http://localhost:3002/api/entity-tags/batch",
        method: "POST",
        body: {
          tagId: randomUUID(),
          entityType: TagEntityType.Artifact,
          entityIds: [],
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it("returns 400 when entityType is invalid", async () => {
      const request = createMockRequest({
        url: "http://localhost:3002/api/entity-tags/batch",
        method: "POST",
        body: {
          tagId: randomUUID(),
          entityType: "INVALID_TYPE",
          entityIds: [randomUUID()],
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it.each([
      TagEntityType.Project,
      TagEntityType.Loop,
    ])("returns 400 for non-artifact entityType %s (batch is artifact-only)", async (entityType) => {
      const request = createMockRequest({
        url: "http://localhost:3002/api/entity-tags/batch",
        method: "POST",
        body: {
          tagId: randomUUID(),
          entityType,
          entityIds: [randomUUID()],
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(tagService.batchApplyTag).not.toHaveBeenCalled();
    });
  });

  describe("success", () => {
    it("returns 200 with appliedCount on valid request", async () => {
      vi.mocked(tagService.batchApplyTag).mockResolvedValue({
        appliedCount: 3,
      });

      const tagId = randomUUID();
      const entityIds = [randomUUID(), randomUUID(), randomUUID()];

      const request = createMockRequest({
        url: "http://localhost:3002/api/entity-tags/batch",
        method: "POST",
        body: {
          tagId,
          entityType: TagEntityType.Artifact,
          entityIds,
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data.appliedCount).toBe(3);
    });

    it("passes all arguments from body and auth context to service", async () => {
      vi.mocked(tagService.batchApplyTag).mockResolvedValue({
        appliedCount: 1,
      });

      const tagId = randomUUID();
      const entityIds = [randomUUID()];

      const request = createMockRequest({
        url: "http://localhost:3002/api/entity-tags/batch",
        method: "POST",
        body: {
          tagId,
          entityType: TagEntityType.Artifact,
          entityIds,
        },
      });

      await POST(request, createMockRouteContext({}));

      expect(tagService.batchApplyTag).toHaveBeenCalledWith(
        tagId,
        TagEntityType.Artifact,
        entityIds,
        mockAuthContext.user.organizationId
      );
    });
  });

  describe("error handling", () => {
    it("returns 404 when service throws EntityNotFoundError", async () => {
      const tagId = randomUUID();
      vi.mocked(tagService.batchApplyTag).mockRejectedValue(
        new EntityNotFoundError("Tag", tagId)
      );

      const request = createMockRequest({
        url: "http://localhost:3002/api/entity-tags/batch",
        method: "POST",
        body: {
          tagId,
          entityType: TagEntityType.Artifact,
          entityIds: [randomUUID()],
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(404);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it("returns 500 when service throws a generic error", async () => {
      vi.mocked(tagService.batchApplyTag).mockRejectedValue(
        new Error("Database connection failed")
      );

      const tagId = randomUUID();
      const request = createMockRequest({
        url: "http://localhost:3002/api/entity-tags/batch",
        method: "POST",
        body: {
          tagId,
          entityType: TagEntityType.Artifact,
          entityIds: [randomUUID()],
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(500);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe("Failed to apply tags");
    });
  });
});
