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
      expect(metadata.title).toBe("My PRD | Closedloop.ai");
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
      expect(metadata.title).toBe("Auth Plan | Closedloop.ai");
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
      expect(metadata.title).toBe("Some Document | Closedloop.ai");
    });
  });

  describe("feature handler", () => {
    it("fetches metadata for features/<slug>", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "Fix login bug", status: "IN_PROGRESS" })
      );

      const metadata = await resolveOgMetadata("features/fix-login-bug");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/fix-login-bug/meta",
        expect.any(Object)
      );
      expect(metadata.title).toBe("Fix login bug | Closedloop.ai");
      expect(metadata.description).toBe("Feature — In Progress");
    });
  });

  describe("fallback behavior", () => {
    it("returns fallback metadata for unknown paths", async () => {
      const metadata = await resolveOgMetadata("settings");

      expect(metadata.title).toBe("Closedloop.ai");
    });

    it("returns fallback metadata for empty string", async () => {
      const metadata = await resolveOgMetadata("");

      expect(metadata.title).toBe("Closedloop.ai");
    });

    it("returns fallback metadata for nested unknown paths", async () => {
      const metadata = await resolveOgMetadata("teams/abc/projects/def");

      expect(metadata.title).toBe("Closedloop.ai");
    });

    it("returns fallback metadata when API returns 404", async () => {
      const metadata = await resolveOgMetadata("prds/nonexistent");

      expect(metadata.title).toBe("Closedloop.ai");
    });

    it("returns fallback metadata when fetch throws", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Network error")
      );

      const metadata = await resolveOgMetadata("prds/my-slug");

      expect(metadata.title).toBe("Closedloop.ai");
    });
  });

  describe("org-scoped paths", () => {
    it("fetches metadata for org-scoped prds path", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "My PRD", type: "PRD" })
      );

      const metadata = await resolveOgMetadata("acme/prds/my-prd");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/my-prd/meta?org=acme",
        expect.any(Object)
      );
      expect(metadata.title).toBe("My PRD | Closedloop.ai");
    });

    it("fetches metadata for org-scoped features path", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "Auth Feature", status: "DRAFT" })
      );

      const metadata = await resolveOgMetadata("acme/features/FEA-42");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/FEA-42/meta?org=acme",
        expect.any(Object)
      );
      expect(metadata.title).toBe("Auth Feature | Closedloop.ai");
    });

    it("fetches metadata for org-scoped implementation-plans path", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "My Plan", type: "IMPLEMENTATION_PLAN" })
      );

      const metadata = await resolveOgMetadata(
        "acme/implementation-plans/PLN-7"
      );

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/PLN-7/meta?org=acme",
        expect.any(Object)
      );
      expect(metadata.title).toBe("My Plan | Closedloop.ai");
    });

    it("still works without org slug prefix (backward compat)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "Old PRD", type: "PRD" })
      );

      const metadata = await resolveOgMetadata("prds/old-prd");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/old-prd/meta",
        expect.any(Object)
      );
      expect(metadata.title).toBe("Old PRD | Closedloop.ai");
    });

    it("encodes org slug with special characters in query param", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "A PRD", type: "PRD" })
      );

      await resolveOgMetadata("org-with-hyphens/prds/PRD-1");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/PRD-1/meta?org=org-with-hyphens",
        expect.any(Object)
      );
    });
  });

  describe("OpenGraph and Twitter card metadata", () => {
    it("includes proper OG tags for artifacts", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "My PRD", type: "PRD" })
      );

      const metadata = await resolveOgMetadata("prds/my-prd");

      expect(metadata.openGraph).toEqual({
        title: "My PRD | Closedloop.ai",
        description: "PRD",
        type: "website",
        siteName: "Closedloop.ai",
      });
      expect(metadata.twitter).toEqual({
        card: "summary",
        title: "My PRD | Closedloop.ai",
        description: "PRD",
      });
    });

    it("includes proper OG tags for fallback", async () => {
      const metadata = await resolveOgMetadata("unknown");

      expect(metadata.openGraph).toEqual(
        expect.objectContaining({
          title: "Closedloop.ai",
          description: "Sign in to view this content.",
        })
      );
    });
  });
});
