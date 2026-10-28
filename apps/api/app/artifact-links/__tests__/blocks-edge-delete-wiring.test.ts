import { randomUUID } from "node:crypto";
import { failure } from "@repo/api/src/types/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";
import { artifactLinksService } from "../service";

/**
 * ISS-9632 — production wiring for the DELETE half of "a blocker is resolved"
 * (whitlockk, ISS-9632 review).
 *
 * The resolver already treats an ABSENT `BLOCKS` edge as resolved, but nothing
 * woke it when an edge was DELETED, so a dependent whose remaining blockers were
 * already terminal stayed `BLOCKED` with nothing live holding it. What is proved
 * here is that the route hands the removed edge's target to the resolver, and
 * that it names no dependent for a link that never blocked anything. Delete the
 * call site and both of these fail.
 */

let mockAuthContext: AuthContext;
const mockResolveRemovedEdges = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params?: unknown }) =>
      handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/app/artifact-links/link-implementation-evidence", () => ({
  readLinkWriteAttributionEvidence: vi.fn(),
}));
vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: { deleteLink: vi.fn() },
}));
vi.mock("@/app/documents/blocked-dependent-unblock-service", () => ({
  blockedDependentUnblockService: {
    resolveBlocksForRemovedEdges: (...args: unknown[]) =>
      mockResolveRemovedEdges(...args),
  },
}));

import { DELETE } from "@/app/artifact-links/[id]/route";

function deleteRequest(id: string) {
  return DELETE(
    createMockRequest({
      url: `http://localhost:3002/api/artifact-links/${id}`,
      method: "DELETE",
    }),
    createMockRouteContext({ id })
  );
}

describe("DELETE /artifact-links/[id] blocker-resolution wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRemovedEdges.mockResolvedValue({
      resolvedIds: [],
      unblockedIds: [],
    });
    mockAuthContext = createTestAuthContext();
  });

  it("hands the removed BLOCKS edge's target to the resolver", async () => {
    const linkId = randomUUID();
    const dependentId = randomUUID();
    vi.mocked(artifactLinksService.deleteLink).mockResolvedValue({
      unblockCandidateIds: [dependentId],
      deleted: true,
    });

    const response = await deleteRequest(linkId);

    expect(response.status).toBe(200);
    expect(artifactLinksService.deleteLink).toHaveBeenCalledWith(
      linkId,
      mockAuthContext.user.organizationId,
      undefined
    );
    expect(mockResolveRemovedEdges).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      dependentIds: [dependentId],
    });
  });

  it("names no dependent when the deleted link was not a BLOCKS edge", async () => {
    vi.mocked(artifactLinksService.deleteLink).mockResolvedValue({
      unblockCandidateIds: [],
      deleted: true,
    });

    const response = await deleteRequest(randomUUID());

    expect(response.status).toBe(200);
    expect(mockResolveRemovedEdges).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      dependentIds: [],
    });
  });

  it("answers a route params failure with main's 500 envelope", async () => {
    // ISS-12552: the params read sits inside the handler's try, as on main,
    // so it answers the route's own error envelope instead of escaping it.
    const response = await DELETE(
      createMockRequest({
        url: `http://localhost:3002/api/artifact-links/${randomUUID()}`,
        method: "DELETE",
      }),
      { params: Promise.reject(new Error("params unavailable")) }
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(
      failure("Failed to delete artifact link")
    );
    expect(artifactLinksService.deleteLink).not.toHaveBeenCalled();
  });
});
