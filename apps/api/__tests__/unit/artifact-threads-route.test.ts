import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { JsonNull: "DbNull" },
}));

vi.mock("@repo/collaboration/room-management", () => ({
  createArtifactThread: vi.fn(),
}));

vi.mock("@repo/collaboration/room-utils", () => ({
  generateArtifactRoomId: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => (request: any, context: any) =>
    handler(
      { user: { id: "user-1", organizationId: "org-1" } },
      request,
      context.params
    ),
}));

vi.mock("@/lib/identifier-utils", () => ({
  resolveArtifactId: vi.fn(),
}));

vi.mock("@/app/artifacts/service", () => ({
  artifactsService: {
    findById: vi.fn(),
  },
}));

vi.mock("@/app/comments/service", () => ({
  commentsService: {
    upsertThreadFromLiveblocks: vi.fn(),
    upsertCommentFromLiveblocks: vi.fn(),
  },
}));

// --- Imports (after mocks) ---

import { createArtifactThread } from "@repo/collaboration/room-management";
import { generateArtifactRoomId } from "@repo/collaboration/room-utils";
import type { ThreadData } from "@repo/collaboration/webhook";
import { POST } from "@/app/artifacts/[id]/threads/route";
import { artifactsService } from "@/app/artifacts/service";
import { commentsService } from "@/app/comments/service";
import { resolveArtifactId } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
} from "../utils/auth-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown) {
  return createMockRequest({
    url: "http://localhost:3002/artifacts/PRD-7/threads",
    method: "POST",
    body,
  });
}

function makeParams(id = "PRD-7") {
  return createMockRouteContext({ id });
}

function makeFakeThreadData(overrides?: Partial<ThreadData>): ThreadData {
  return {
    type: "thread",
    id: "th_123",
    roomId: "org-1:artifact:PRD-7",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    resolved: false,
    metadata: {},
    comments: [
      {
        type: "comment",
        id: "cm_456",
        threadId: "th_123",
        roomId: "org-1:artifact:PRD-7",
        userId: "user-1",
        createdAt: new Date("2025-01-01"),
        body: {
          version: 1,
          content: [{ type: "paragraph", children: [{ text: "Hello" }] }],
        },
        reactions: [],
        attachments: [],
        metadata: {},
      } as ThreadData["comments"][0],
    ],
    ...overrides,
  } as ThreadData;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /artifacts/:id/threads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates thread and returns threadId/commentId on valid request", async () => {
    vi.mocked(resolveArtifactId).mockResolvedValue("artifact-uuid");
    vi.mocked(artifactsService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    vi.mocked(generateArtifactRoomId).mockReturnValue("org-1:artifact:PRD-7");
    vi.mocked(createArtifactThread).mockResolvedValue(makeFakeThreadData());
    vi.mocked(commentsService.upsertThreadFromLiveblocks).mockResolvedValue(
      undefined as never
    );
    vi.mocked(commentsService.upsertCommentFromLiveblocks).mockResolvedValue(
      undefined as never
    );

    const response = await POST(makeRequest({ body: "Hello" }), makeParams());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: { commentId: "cm_456", threadId: "th_123" },
    });

    expect(createArtifactThread).toHaveBeenCalledWith({
      roomId: "org-1:artifact:PRD-7",
      userId: "user-1",
      bodyText: "Hello",
    });

    expect(commentsService.upsertThreadFromLiveblocks).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ id: "th_123" })
    );
    expect(commentsService.upsertCommentFromLiveblocks).toHaveBeenCalledWith(
      "org-1",
      "th_123",
      expect.objectContaining({ id: "cm_456" })
    );
  });

  it("returns 404 when resolveArtifactId returns null", async () => {
    vi.mocked(resolveArtifactId).mockResolvedValue(null);

    const response = await POST(makeRequest({ body: "Hello" }), makeParams());
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.success).toBe(false);
  });

  it("forwards Liveblocks error status code (e.g. 404 for missing room)", async () => {
    vi.mocked(resolveArtifactId).mockResolvedValue("artifact-uuid");
    vi.mocked(artifactsService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    vi.mocked(generateArtifactRoomId).mockReturnValue("org-1:artifact:PRD-7");
    const lbError = Object.assign(new Error("Room not found"), { status: 404 });
    vi.mocked(createArtifactThread).mockRejectedValue(lbError);

    const response = await POST(makeRequest({ body: "Hello" }), makeParams());
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.success).toBe(false);
  });

  it("defaults to 503 when Liveblocks error has no status code", async () => {
    vi.mocked(resolveArtifactId).mockResolvedValue("artifact-uuid");
    vi.mocked(artifactsService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    vi.mocked(generateArtifactRoomId).mockReturnValue("org-1:artifact:PRD-7");
    vi.mocked(createArtifactThread).mockRejectedValue(
      new Error("Unknown SDK error")
    );

    const response = await POST(makeRequest({ body: "Hello" }), makeParams());

    expect(response.status).toBe(503);
  });

  it("ignores userId in request body and always uses authenticated user.id", async () => {
    vi.mocked(resolveArtifactId).mockResolvedValue("artifact-uuid");
    vi.mocked(artifactsService.findById).mockResolvedValue({
      slug: "PRD-7",
    } as never);
    vi.mocked(generateArtifactRoomId).mockReturnValue("org-1:artifact:PRD-7");
    vi.mocked(createArtifactThread).mockResolvedValue(makeFakeThreadData());
    vi.mocked(commentsService.upsertThreadFromLiveblocks).mockResolvedValue(
      undefined as never
    );
    vi.mocked(commentsService.upsertCommentFromLiveblocks).mockResolvedValue(
      undefined as never
    );

    await POST(
      makeRequest({ body: "Hello", userId: "attacker-id" }),
      makeParams()
    );

    expect(createArtifactThread).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" })
    );
    expect(createArtifactThread).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: "attacker-id" })
    );
  });
});
