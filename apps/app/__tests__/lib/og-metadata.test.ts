import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOgMetadata } from "@/lib/og-metadata";

// Mock env module
vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_API_URL: "http://localhost:3002" },
}));

describe("resolveOgMetadata", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 404 }))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("document handlers (prds, implementation-plans, documents)", () => {
    it("fetches metadata for prds/<slug>", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "My PRD", type: "PRD" })
      );

      const metadata = await resolveOgMetadata("prds/my-prd");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/my-prd/meta",
        expect.any(Object)
      );
      expect(metadata.title).toBe("My PRD | ClosedLoop.ai");
      expect(metadata.description).toBe("PRD");
    });

    it("fetches metadata for implementation-plans/<slug>", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({
          title: "Auth Plan",
          type: "IMPLEMENTATION_PLAN",
        })
      );

      const metadata = await resolveOgMetadata(
        "implementation-plans/auth-plan"
      );

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/auth-plan/meta",
        expect.any(Object)
      );
      expect(metadata.title).toBe("Auth Plan | ClosedLoop.ai");
      expect(metadata.description).toBe("Plan");
    });

    it("fetches metadata for documents/<slug> (fallback redirect)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "Some Document", type: "PRD" })
      );

      const metadata = await resolveOgMetadata("documents/some-slug");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/some-slug/meta",
        expect.any(Object)
      );
      expect(metadata.title).toBe("Some Document | ClosedLoop.ai");
    });
  });

  describe("feature handler", () => {
    it("fetches metadata for features/<slug>", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "Fix login bug", status: "IN_PROGRESS" })
      );

      const metadata = await resolveOgMetadata("features/fix-login-bug");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/features/by-slug/fix-login-bug/meta",
        expect.any(Object)
      );
      expect(metadata.title).toBe("Fix login bug | ClosedLoop.ai");
      expect(metadata.description).toBe("Feature — In Progress");
    });
  });

  describe("fallback behavior", () => {
    it("returns fallback metadata for unknown paths", async () => {
      const metadata = await resolveOgMetadata("settings");

      expect(metadata.title).toBe("ClosedLoop.ai");
    });

    it("returns fallback metadata for empty string", async () => {
      const metadata = await resolveOgMetadata("");

      expect(metadata.title).toBe("ClosedLoop.ai");
    });

    it("returns fallback metadata for nested unknown paths", async () => {
      const metadata = await resolveOgMetadata("teams/abc/projects/def");

      expect(metadata.title).toBe("ClosedLoop.ai");
    });

    it("returns fallback metadata when API returns 404", async () => {
      const metadata = await resolveOgMetadata("prds/nonexistent");

      expect(metadata.title).toBe("ClosedLoop.ai");
    });

    it("returns fallback metadata when fetch throws", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Network error")
      );

      const metadata = await resolveOgMetadata("prds/my-slug");

      expect(metadata.title).toBe("ClosedLoop.ai");
    });
  });

  describe("OpenGraph and Twitter card metadata", () => {
    it("includes proper OG tags for artifacts", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "My PRD", type: "PRD" })
      );

      const metadata = await resolveOgMetadata("prds/my-prd");

      expect(metadata.openGraph).toEqual({
        title: "My PRD | ClosedLoop.ai",
        description: "PRD",
        type: "website",
        siteName: "ClosedLoop.ai",
      });
      expect(metadata.twitter).toEqual({
        card: "summary",
        title: "My PRD | ClosedLoop.ai",
        description: "PRD",
      });
    });

    it("includes proper OG tags for fallback", async () => {
      const metadata = await resolveOgMetadata("unknown");

      expect(metadata.openGraph).toEqual(
        expect.objectContaining({
          title: "ClosedLoop.ai",
          description: "Sign in to view this content.",
        })
      );
    });
  });
});
