import { beforeEach, describe, expect, it, vi } from "vitest";
import { createResolveRoomsInfo } from "@/lib/room-resolvers";

// Mock fetch globally for the async resolver
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("createResolveRoomsInfo", () => {
  const organizationId = "org-123";

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: server returns empty array (no metadata available)
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  describe("slug fallback names", () => {
    it("returns raw slug as fallback name", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:hello`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("hello");
    });

    it("preserves hyphens in slug fallback name", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:hello-world`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("hello-world");
    });

    it("preserves multi-hyphen slug as-is", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:this-is-a-test`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("this-is-a-test");
    });

    it("preserves original casing in slug", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:api-docs`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("api-docs");
    });
  });

  describe("room ID parsing", () => {
    it("generates fallback artifact URL from document slug when server returns no metadata", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:my-document`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.url).toBe("/artifacts/my-document");
    });

    it("returns undefined for invalid room ID format (missing parts)", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: ["invalid-format"],
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toBeUndefined();
    });

    it("returns undefined for invalid room ID format (wrong separator count)", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: ["org:artifact"],
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toBeUndefined();
    });

    it("returns undefined for invalid room ID format (wrong room type)", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:invalid:doc-slug`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toBeUndefined();
    });
  });

  describe("organization validation", () => {
    it("returns undefined for room belonging to different organization", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: ["org-999:artifact:document"],
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toBeUndefined();
    });

    it("resolves room only for matching organization", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:valid-doc`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toBeDefined();
      expect(result[0]?.name).toBe("valid-doc");
    });
  });

  describe("batch processing", () => {
    it("handles empty room IDs array", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({ roomIds: [] });

      expect(result).toEqual([]);
    });

    it("processes multiple valid room IDs", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [
          `${organizationId}:artifact:doc-one`,
          `${organizationId}:artifact:doc-two`,
          `${organizationId}:artifact:doc-three`,
        ],
      });

      expect(result).toHaveLength(3);
      expect(result[0]?.name).toBe("doc-one");
      expect(result[1]?.name).toBe("doc-two");
      expect(result[2]?.name).toBe("doc-three");
    });

    it("handles mixed valid and invalid room IDs", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [
          `${organizationId}:artifact:valid-doc`,
          "invalid-format",
          "org-999:artifact:wrong-org",
          `${organizationId}:artifact:another-valid`,
        ],
      });

      expect(result).toHaveLength(4);
      expect(result[0]?.name).toBe("valid-doc");
      expect(result[1]).toBeUndefined();
      expect(result[2]).toBeUndefined();
      expect(result[3]?.name).toBe("another-valid");
    });
  });

  describe("server-side resolution", () => {
    it("returns type-specific URLs from server response", async () => {
      const roomId = `${organizationId}:artifact:my-prd`;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([{ roomId, name: "My Prd", url: "/prds/my-prd" }]),
      });

      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({ roomIds: [roomId] });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "My Prd",
        url: "/prds/my-prd",
      });
    });

    it("falls back to slug-based URL when server returns error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:my-document`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.url).toBe("/artifacts/my-document");
      expect(result[0]?.name).toBe("my-document");
    });

    it("falls back to slug-based URL when fetch throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:my-document`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.url).toBe("/artifacts/my-document");
      expect(result[0]?.name).toBe("my-document");
    });

    it("falls back to slug when server returns name matching slug (null auth token scenario)", async () => {
      const roomId = `${organizationId}:artifact:my-document`;
      // When the server cannot enrich names (e.g., null auth token causes fetchBatchMeta to
      // return {}, so no title is available), the server returns the room with name equal to
      // the slug. The client should surface this slug-based name as-is.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { roomId, name: "my-document", url: "/artifacts/my-document" },
          ]),
      });

      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({ roomIds: [roomId] });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("my-document");
      expect(result[0]?.url).toBe("/artifacts/my-document");
    });

    it("converts null url from server response to undefined in RoomInfo (Q-002)", async () => {
      const roomId = `${organizationId}:artifact:my-doc`;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ roomId, name: "My Doc", url: null }]),
      });

      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({ roomIds: [roomId] });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("My Doc");
      // null from server must be coerced to undefined, not kept as null
      expect(result[0]?.url).toBeUndefined();
    });

    it("deduplicates room IDs in server request", async () => {
      const roomId = `${organizationId}:artifact:same-doc`;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { roomId, name: "Same Doc", url: "/prds/same-doc" },
          ]),
      });

      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({ roomIds: [roomId, roomId] });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: "Same Doc", url: "/prds/same-doc" });
      expect(result[1]).toEqual({ name: "Same Doc", url: "/prds/same-doc" });

      // Verify only one unique room ID was sent
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      const roomIdsParam = new URL(
        fetchUrl,
        "http://localhost"
      ).searchParams.get("roomIds");
      expect(roomIdsParam).toBe(roomId);
    });
  });

  describe("room info structure", () => {
    it("returns correct RoomInfo structure with fallback URL", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:test-document`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "test-document",
        url: "/artifacts/test-document",
      });
    });

    it("preserves document slug in URL exactly as provided", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:my-special-doc-123`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.url).toBe("/artifacts/my-special-doc-123");
    });
  });

  describe("edge cases", () => {
    it("handles slug with leading hyphen", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:-leading`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("-leading");
    });

    it("handles slug with trailing hyphen", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:trailing-`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("trailing-");
    });

    it("handles slug with consecutive hyphens", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:double--hyphen`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("double--hyphen");
    });

    it("handles empty slug", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toBeDefined();
      expect(result[0]?.name).toBe("");
      expect(result[0]?.url).toBe("/artifacts/");
    });

    it("handles slug with numbers", async () => {
      const resolver = createResolveRoomsInfo(organizationId);
      const result = await resolver({
        roomIds: [`${organizationId}:artifact:doc-123-test`],
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("doc-123-test");
    });
  });
});
