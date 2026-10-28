import type { Metadata } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveOgMetadata,
  resolveOgMetadataFromRedirectUrl,
} from "@/lib/og-metadata";

// Mutable env mock so individual tests can exercise the server-side
// SERVER_API_URL branch of resolveApiOrigin.
const envState = vi.hoisted(() => ({
  NEXT_PUBLIC_API_URL: "http://localhost:3002" as string | undefined,
  SERVER_API_URL: undefined as string | undefined,
}));

vi.mock("@/env", () => ({
  env: envState,
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ host: "app.closedloop.ai" })),
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

  describe("document paths (documents and the legacy prds, implementation-plans)", () => {
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

    it("fetches metadata for documents/<slug>", async () => {
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

  describe("ISS-12855: /documents/<slug> serves every document's unfurl", () => {
    it("describes an issue at documents/<slug> as Issue, <status>", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({
          title: "Fix login bug",
          type: "FEATURE",
          status: "IN_PROGRESS",
        })
      );

      const metadata = await resolveOgMetadata("acme/documents/ISS-42");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/ISS-42/meta?org=acme",
        expect.any(Object)
      );
      expect(metadata.title).toBe("Fix login bug | Closedloop.ai");
      expect(metadata.description).toBe("Issue, In Progress");
    });

    it("returns the fallback for a Template, which has no detail page", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "PRD template", type: "TEMPLATE" })
      );

      const metadata = await resolveOgMetadata("acme/documents/TPL-1");

      expect(metadata.title).toBe("Closedloop.ai");
    });

    it("describes a PRD at documents/<slug> by its type badge", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ title: "My PRD", type: "PRD", status: "DRAFT" })
      );

      const metadata = await resolveOgMetadata("acme/documents/PRD-1");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/PRD-1/meta?org=acme",
        expect.any(Object)
      );
      expect(metadata.description).toBe("PRD");
    });
  });

  describe("legacy issue paths (issues, features)", () => {
    it("fetches metadata for features/<slug>", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({
          title: "Fix login bug",
          type: "FEATURE",
          status: "IN_PROGRESS",
        })
      );

      const metadata = await resolveOgMetadata("features/fix-login-bug");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/fix-login-bug/meta",
        expect.any(Object)
      );
      expect(metadata.title).toBe("Fix login bug | Closedloop.ai");
      expect(metadata.description).toBe("Issue, In Progress");
    });

    // The legacy /issues/ and /features/ paths still unfurl (Clerk's
    // redirect_url and the Slackbot rewrite carry them).
    it("fetches metadata for issues/<slug>", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({
          title: "Fix login bug",
          type: "FEATURE",
          status: "IN_PROGRESS",
        })
      );

      const metadata = await resolveOgMetadata("acme/issues/ISS-42");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/by-slug/ISS-42/meta?org=acme",
        expect.any(Object)
      );
      expect(metadata.title).toBe("Fix login bug | Closedloop.ai");
      expect(metadata.description).toBe("Issue, In Progress");
    });

    // ISS-9560. This unfurl ships to Slack and Linear for every /issues/ link,
    // and its old fallback chain printed the raw wire token and then fell
    // through to the artifact TYPE label — so a status-less issue previewed as
    // "Issue, Issue": the type stated twice, and nothing about the status.
    // UNGATED, unlike the in-app surfaces: server module, no flag seam, and a
    // broken fallback restored is a bug fix.
    it.each([
      ["a status the build does not recognize", "BRANCH_MERGED"],
      ["no status at all", undefined],
    ])(
      "describes %s as Unknown rather than restating the type",
      async (_case, status) => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          Response.json({ title: "Fix login bug", type: "FEATURE", status })
        );

        const metadata = await resolveOgMetadata("issues/ISS-42");

        expect(metadata.description).toBe("Issue, Unknown");
      }
    );
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
        Response.json({
          title: "Auth Feature",
          type: "FEATURE",
          status: "DRAFT",
        })
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

describe("server-side API origin resolution", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 404 }))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    envState.NEXT_PUBLIC_API_URL = "http://localhost:3002";
    envState.SERVER_API_URL = undefined;
  });

  it("prefers SERVER_API_URL in a server runtime (Docker)", async () => {
    // generateMetadata runs server-side; inside the app container
    // NEXT_PUBLIC_API_URL points at the container's own localhost, so the
    // BFF call must honor SERVER_API_URL (e.g. http://api:3002) instead.
    vi.stubGlobal("window", undefined);
    envState.SERVER_API_URL = "http://api:3002";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ title: "My PRD", type: "PRD" })
    );

    const metadata = await resolveOgMetadata("prds/my-prd");

    expect(fetch).toHaveBeenCalledWith(
      "http://api:3002/documents/by-slug/my-prd/meta",
      expect.any(Object)
    );
    expect(metadata.title).toBe("My PRD | Closedloop.ai");
  });
});

describe("resolveOgMetadataFromRedirectUrl", () => {
  const fallback: Metadata = { title: "Auth page" };

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 404 }))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves document metadata for a same-host absolute redirect_url", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        title: "My Feature",
        type: "FEATURE",
        status: "IN_PROGRESS",
      })
    );

    const metadata = await resolveOgMetadataFromRedirectUrl(
      "https://app.closedloop.ai/acme/features/FEA-1",
      fallback
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3002/documents/by-slug/FEA-1/meta?org=acme",
      expect.any(Object)
    );
    expect(metadata.title).toBe("My Feature | Closedloop.ai");
  });

  it("returns the fallback for a foreign-host absolute redirect_url", async () => {
    const metadata = await resolveOgMetadataFromRedirectUrl(
      "https://evil.example.com/acme/features/FEA-1",
      fallback
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(metadata).toBe(fallback);
  });

  it("resolves document metadata for a relative redirect_url", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ title: "My PRD", type: "PRD" })
    );

    const metadata = await resolveOgMetadataFromRedirectUrl(
      "/acme/prds/PRD-9?version=2",
      fallback
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3002/documents/by-slug/PRD-9/meta?org=acme",
      expect.any(Object)
    );
    expect(metadata.title).toBe("My PRD | Closedloop.ai");
  });

  it("returns the fallback when redirect_url is missing", async () => {
    const metadata = await resolveOgMetadataFromRedirectUrl(
      undefined,
      fallback
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(metadata).toBe(fallback);
  });

  it("returns the fallback for a repeated redirect_url (string[]) without throwing", async () => {
    // Next.js hands repeated query keys through as string[]:
    // /sign-up?redirect_url=/a&redirect_url=/b
    const metadata = await resolveOgMetadataFromRedirectUrl(
      ["/acme/features/FEA-1", "/acme/features/FEA-2"],
      fallback
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(metadata).toBe(fallback);
  });
});
