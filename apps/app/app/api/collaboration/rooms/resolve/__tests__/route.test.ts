import { DocumentType } from "@repo/api/src/types/document";
import type { User } from "@repo/api/src/types/user";
import { ApproverRole } from "@repo/api/src/types/user";
import type { ResolvedRoom } from "@repo/collaboration/server/room-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before any imports of the module under test

const mockAuth = vi.fn();

vi.mock("@repo/auth/server", () => ({
  auth: () => mockAuth(),
}));

const mockResolveRoomMetadata = vi.fn();

vi.mock("@repo/collaboration/server/room-metadata", () => ({
  resolveRoomMetadata: (...args: unknown[]) => mockResolveRoomMetadata(...args),
}));

const mockParseDocumentRoomId = vi.fn();

vi.mock("@repo/collaboration/shared/room-utils", () => ({
  parseDocumentRoomId: (...args: unknown[]) => mockParseDocumentRoomId(...args),
}));

const mockFetchBatchMeta = vi.fn();

vi.mock("../../../fetch-batch-meta", () => ({
  fetchBatchMeta: (...args: unknown[]) => mockFetchBatchMeta(...args),
}));

const mockFetchUser = vi.fn();

vi.mock("../../../fetch-user", () => ({
  fetchUser: (...args: unknown[]) => mockFetchUser(...args),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (e: unknown) => String(e),
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_API_URL: "http://localhost:3002",
  },
}));

// Import after mocks are set up
const { GET } = await import("../route");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const createMockUser = (overrides?: Partial<User>): User => ({
  id: "user-123",
  clerkId: "clerk_123",
  organizationId: "org-123",
  email: "test@example.com",
  firstName: "John",
  lastName: "Doe",
  avatarUrl: "https://example.com/avatar.jpg",
  phoneNumber: null,
  role: ApproverRole.Engineer,
  linearId: null,
  slackId: null,
  githubUsername: null,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createRequest = (roomIds?: string): Request =>
  new Request(
    `http://localhost:3000/api/collaboration/rooms/resolve${roomIds === undefined ? "" : `?roomIds=${roomIds}`}`,
    { method: "GET" }
  );

/**
 * Sets up the common happy-path mocks: authenticated user with the given org.
 */
const setupAuthAndUser = (organizationId = "org-123", orgSlug = "test-org") => {
  const getToken = vi.fn().mockResolvedValue("clerk-token");
  mockAuth.mockResolvedValue({ userId: "user-123", getToken, orgSlug });
  mockFetchUser.mockResolvedValue(createMockUser({ organizationId }));
  return { getToken };
};

/**
 * Configures `parseDocumentRoomId` to return a predictable slug for room IDs
 * formatted as `<orgId>:artifact:<slug>`.
 */
const setupParseRoomId = () => {
  mockParseDocumentRoomId.mockImplementation((roomId: string) => {
    const parts = roomId.split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid room ID format");
    }
    return { organizationId: parts[0], slug: parts[2] };
  });
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/collaboration/rooms/resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Authentication & authorization ──────────────────────────────────────────

  describe("authentication", () => {
    it("returns 401 when user is not authenticated", async () => {
      mockAuth.mockResolvedValue({ userId: null, getToken: vi.fn() });

      const response = await GET(createRequest("org-123:artifact:prd-abc"));

      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
    });

    it("returns 500 when fetchUser returns null", async () => {
      mockAuth.mockResolvedValue({
        userId: "user-123",
        getToken: vi.fn().mockResolvedValue("clerk-token"),
      });
      mockFetchUser.mockResolvedValue(null);

      const response = await GET(createRequest("org-123:artifact:prd-abc"));

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Unable to fetch user");
    });
  });

  // ── Input edge cases ─────────────────────────────────────────────────────────

  describe("input validation", () => {
    it("returns empty array when roomIds param is absent", async () => {
      setupAuthAndUser();

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    });

    it("returns empty array when roomIds param is empty string", async () => {
      setupAuthAndUser();

      const response = await GET(createRequest(""));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    });

    it("filters out room IDs that do not belong to the user's organization", async () => {
      setupAuthAndUser("org-123");
      setupParseRoomId();

      const foreignRoomId = "org-999:artifact:foreign-doc";
      const ownRoomId = "org-123:artifact:prd-abc";

      mockResolveRoomMetadata.mockResolvedValue([
        { roomId: ownRoomId, name: "prd-abc", url: null },
      ]);
      mockFetchBatchMeta.mockResolvedValue({});

      const response = await GET(
        createRequest(`${foreignRoomId},${ownRoomId}`)
      );
      const body = await response.json();

      expect(mockResolveRoomMetadata).toHaveBeenCalledWith(
        [ownRoomId],
        "test-org"
      );
      expect(body).toHaveLength(1);
    });

    it("drops room IDs that parseDocumentRoomId cannot parse", async () => {
      setupAuthAndUser();
      mockParseDocumentRoomId.mockImplementation(() => {
        throw new Error("Invalid room ID format");
      });

      mockResolveRoomMetadata.mockResolvedValue([]);
      mockFetchBatchMeta.mockResolvedValue({});

      const response = await GET(createRequest("bad-room-id"));
      const body = await response.json();

      expect(body).toEqual([]);
    });
  });

  // ── URL enrichment — the core requirement ────────────────────────────────────

  describe("URL enrichment logic", () => {
    it("constructs type-specific URL for a room where resolveRoomMetadata returned url: null", async () => {
      setupAuthAndUser();
      setupParseRoomId();

      const roomId = "org-123:artifact:prd-abc";
      const resolvedRoom: ResolvedRoom = { roomId, name: "prd-abc", url: null };

      mockResolveRoomMetadata.mockResolvedValue([resolvedRoom]);
      mockFetchBatchMeta.mockResolvedValue({
        "prd-abc": { title: "My PRD", type: DocumentType.Prd },
      });

      const response = await GET(createRequest(roomId));
      const body = await response.json();

      expect(body).toHaveLength(1);
      expect(body[0].url).toBe("/test-org/prds/prd-abc");
    });

    it("constructs correct URL for IMPLEMENTATION_PLAN type", async () => {
      setupAuthAndUser();
      setupParseRoomId();

      const roomId = "org-123:artifact:plan-xyz";
      mockResolveRoomMetadata.mockResolvedValue([
        { roomId, name: "plan-xyz", url: null },
      ]);
      mockFetchBatchMeta.mockResolvedValue({
        "plan-xyz": { title: "My Plan", type: DocumentType.ImplementationPlan },
      });

      const response = await GET(createRequest(roomId));
      const body = await response.json();

      expect(body[0].url).toBe("/test-org/implementation-plans/plan-xyz");
    });

    it("constructs correct URL for FEATURE type", async () => {
      setupAuthAndUser();
      setupParseRoomId();

      const roomId = "org-123:artifact:feat-001";
      mockResolveRoomMetadata.mockResolvedValue([
        { roomId, name: "feat-001", url: null },
      ]);
      mockFetchBatchMeta.mockResolvedValue({
        "feat-001": { title: "My Feature", type: DocumentType.Feature },
      });

      const response = await GET(createRequest(roomId));
      const body = await response.json();

      expect(body[0].url).toBe("/test-org/features/feat-001");
    });

    it("leaves url null when meta.type is not a navigable type (e.g. TEMPLATE)", async () => {
      setupAuthAndUser();
      setupParseRoomId();

      const roomId = "org-123:artifact:tmpl-001";
      mockResolveRoomMetadata.mockResolvedValue([
        { roomId, name: "tmpl-001", url: null },
      ]);
      // TEMPLATE has no route prefix in TYPE_ROUTE_PREFIX
      mockFetchBatchMeta.mockResolvedValue({
        "tmpl-001": { title: "My Template", type: DocumentType.Template },
      });

      const response = await GET(createRequest(roomId));
      const body = await response.json();

      expect(body[0].url).toBeNull();
    });

    it("leaves url null when meta?.type is absent (slug not in batch-meta response)", async () => {
      setupAuthAndUser();
      setupParseRoomId();

      const roomId = "org-123:artifact:unknown-doc";
      mockResolveRoomMetadata.mockResolvedValue([
        { roomId, name: "unknown-doc", url: null },
      ]);
      // Slug is not present in titleMap
      mockFetchBatchMeta.mockResolvedValue({});

      const response = await GET(createRequest(roomId));
      const body = await response.json();

      expect(body[0].url).toBeNull();
    });

    it("does not override a non-null URL already returned by resolveRoomMetadata", async () => {
      setupAuthAndUser();
      setupParseRoomId();

      const roomId = "org-123:artifact:prd-abc";
      const existingUrl = "/prds/prd-abc";
      mockResolveRoomMetadata.mockResolvedValue([
        { roomId, name: "prd-abc", url: existingUrl },
      ]);
      // Even if batch-meta has a different type, the existing URL must be preserved
      mockFetchBatchMeta.mockResolvedValue({
        "prd-abc": { title: "My PRD", type: DocumentType.Prd },
      });

      const response = await GET(createRequest(roomId));
      const body = await response.json();

      expect(body[0].url).toBe(existingUrl);
    });

    it("enriches room name with title from batch-meta", async () => {
      setupAuthAndUser();
      setupParseRoomId();

      const roomId = "org-123:artifact:prd-abc";
      mockResolveRoomMetadata.mockResolvedValue([
        { roomId, name: "prd-abc", url: null },
      ]);
      mockFetchBatchMeta.mockResolvedValue({
        "prd-abc": { title: "Enriched PRD Title", type: DocumentType.Prd },
      });

      const response = await GET(createRequest(roomId));
      const body = await response.json();

      expect(body[0].name).toBe("Enriched PRD Title");
    });

    it("falls back to name from resolveRoomMetadata when slug is absent from batch-meta", async () => {
      setupAuthAndUser();
      setupParseRoomId();

      const roomId = "org-123:artifact:prd-abc";
      mockResolveRoomMetadata.mockResolvedValue([
        { roomId, name: "original-name", url: null },
      ]);
      mockFetchBatchMeta.mockResolvedValue({});

      const response = await GET(createRequest(roomId));
      const body = await response.json();

      expect(body[0].name).toBe("original-name");
    });

    it("handles multiple rooms in a single request, enriching each independently", async () => {
      setupAuthAndUser();
      setupParseRoomId();

      const prdRoomId = "org-123:artifact:prd-abc";
      const planRoomId = "org-123:artifact:plan-xyz";

      mockResolveRoomMetadata.mockResolvedValue([
        { roomId: prdRoomId, name: "prd-abc", url: null },
        {
          roomId: planRoomId,
          name: "plan-xyz",
          url: "/implementation-plans/plan-xyz",
        },
      ]);
      mockFetchBatchMeta.mockResolvedValue({
        "prd-abc": { title: "My PRD", type: DocumentType.Prd },
        "plan-xyz": { title: "My Plan", type: DocumentType.ImplementationPlan },
      });

      const response = await GET(createRequest(`${prdRoomId},${planRoomId}`));
      const body = await response.json();

      expect(body).toHaveLength(2);
      // prd room had url: null → gets enriched
      expect(body[0].url).toBe("/test-org/prds/prd-abc");
      expect(body[0].name).toBe("My PRD");
      // plan room had non-null url → not overridden
      expect(body[1].url).toBe("/implementation-plans/plan-xyz");
      expect(body[1].name).toBe("My Plan");
    });
  });

  // ── Fallback when enrichment fails ──────────────────────────────────────────

  describe("enrichment failure fallback", () => {
    it("returns unmodified resolveRoomMetadata results when the enrichment map throws during mapping", async () => {
      setupAuthAndUser();
      setupParseRoomId();

      const roomId = "org-123:artifact:prd-abc";
      const resolvedRoom: ResolvedRoom = { roomId, name: "prd-abc", url: null };

      mockResolveRoomMetadata.mockResolvedValue([resolvedRoom]);
      mockFetchBatchMeta.mockResolvedValue({
        "prd-abc": { title: "My PRD", type: DocumentType.Prd },
      });

      // Let parseDocumentRoomId succeed for the org-filter and slug-extraction
      // phases (calls 1 and 2), then throw on the enrichment phase (call 3)
      // so the per-room catch triggers and returns the original room object.
      let callCount = 0;
      mockParseDocumentRoomId.mockImplementation((id: string) => {
        callCount++;
        if (callCount > 2) {
          throw new Error("parse failed");
        }
        const parts = id.split(":");
        return { organizationId: parts[0], slug: parts[2] };
      });

      const response = await GET(createRequest(roomId));
      const body = await response.json();

      // The per-room catch returns the original room unchanged
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual(resolvedRoom);
      // Verify parseDocumentRoomId was called exactly 3 times
      // (org-filter, slug-extraction, enrichment)
      expect(mockParseDocumentRoomId).toHaveBeenCalledTimes(3);
    });

    it("returns unmodified results from resolveRoomMetadata when fetchBatchMeta returns empty map", async () => {
      setupAuthAndUser();
      setupParseRoomId();

      const roomId = "org-123:artifact:prd-abc";
      const resolvedRoom: ResolvedRoom = {
        roomId,
        name: "prd-abc",
        url: "/prds/prd-abc",
      };

      mockResolveRoomMetadata.mockResolvedValue([resolvedRoom]);
      mockFetchBatchMeta.mockResolvedValue({});

      const response = await GET(createRequest(roomId));
      const body = await response.json();

      expect(body[0].url).toBe("/prds/prd-abc");
      expect(body[0].name).toBe("prd-abc");
    });
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns 500 when auth() throws", async () => {
      mockAuth.mockRejectedValue(new Error("Auth service error"));

      const response = await GET(createRequest("org-123:artifact:prd-abc"));

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal server error");
    });

    it("returns 500 when resolveRoomMetadata throws", async () => {
      setupAuthAndUser();
      setupParseRoomId();

      mockResolveRoomMetadata.mockRejectedValue(
        new Error("Liveblocks unavailable")
      );
      mockFetchBatchMeta.mockResolvedValue({});

      const response = await GET(createRequest("org-123:artifact:prd-abc"));

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal server error");
    });
  });
});
