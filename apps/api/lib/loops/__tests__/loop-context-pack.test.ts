/**
 * Loop-context-pack regression tests — agents-supersede (T-21.5b, AC-027, AC-028).
 *
 * These are unit tests for `listAgentsForContextPack` from
 * `@/app/catalog/service`, which is the function called internally by
 * `fetchAgentsForContextPack` inside `loop-context-pack.ts`.
 *
 * After the agents-supersede migration (T-21.1–T-21.4) the context-pack
 * assembly reads from `CatalogItem{targetKind:'agent'}` instead of the legacy
 * `Agent` model.  These tests assert:
 *
 * - Only CatalogItems with enabled=true and non-archived are returned
 * - The sourceRepo filter works: "" (org-wide) + matching repo slugs are
 *   included; mismatched repos are excluded
 * - When repos is undefined, all enabled org-wide + repo-specific items are returned
 * - Items with null prompt (asset-only, no CatalogItemVersion content) are skipped
 * - The ContextPackAgent wire shape {slug, name, prompt} is emitted correctly
 * - The slug is derived from `role` (preferred) or `name` (fallback)
 * - RepoBootstrapConfig rows are returned as criticGates repoConfigs
 * - Flag-off suppression is exercised through the isAgentsEnabledForUser path
 *   (tested here by asserting listAgentsForContextPack returns empty when the
 *   mocked DB returns disabled items)
 *
 * @repo/database and @repo/analytics are mocked — no live DB required.
 */

import { describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import { listAgentsForContextPack } from "@/app/catalog/service";

const mockWithDb = withDb as unknown as Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal CatalogItem row shape returned by the DB query. */
type CatalogItemRow = {
  role: string | null;
  name: string;
  // Persisted, disambiguated context-pack slug (FEA-2923). Optional here so
  // legacy-row cases can omit it and exercise the role-derived fallback.
  agentSlug?: string | null;
  versions: Array<{ content: string | null }>;
};

/** Minimal RepoBootstrapConfig row returned by the DB query. */
type RepoConfigRow = {
  repoFullName: string;
  criticGates: Record<string, unknown>;
};

function mockDbForListAgents(
  items: CatalogItemRow[],
  repoConfigs: RepoConfigRow[] = []
): void {
  const catalogItem = { findMany: vi.fn().mockResolvedValue(items) };
  const repoBootstrapConfig = {
    findMany: vi.fn().mockResolvedValue(repoConfigs),
  };

  // withDb is called with a callback that receives the DB client and is
  // wrapped in Promise.all — mock the function to invoke the callback and
  // return both sub-queries in order.
  mockWithDb.mockImplementation(
    (
      callback: (db: {
        catalogItem: typeof catalogItem;
        repoBootstrapConfig: typeof repoBootstrapConfig;
      }) => unknown
    ) => callback({ catalogItem, repoBootstrapConfig })
  );
}

// ---------------------------------------------------------------------------
// Wire shape — ContextPackAgent: {slug, name, prompt}
// ---------------------------------------------------------------------------

describe("listAgentsForContextPack — ContextPackAgent wire shape", () => {
  it("emits {slug, name, prompt} for each enabled item with a prompt", async () => {
    mockDbForListAgents([
      {
        role: "code-reviewer",
        name: "Code Reviewer",
        versions: [{ content: "You are a code reviewer." }],
      },
    ]);

    const result = await listAgentsForContextPack("org-1");

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toEqual({
      slug: "code-reviewer",
      name: "Code Reviewer",
      prompt: "You are a code reviewer.",
    });
  });

  it("derives slug from role when role is set", async () => {
    mockDbForListAgents([
      {
        role: "Security Auditor",
        name: "Security Audit Agent",
        versions: [{ content: "Audit security." }],
      },
    ]);

    const result = await listAgentsForContextPack("org-1");

    expect(result.agents[0]?.slug).toBe("security-auditor");
  });

  it("falls back to name-derived slug when role is null", async () => {
    mockDbForListAgents([
      {
        role: null,
        name: "My Custom Agent",
        versions: [{ content: "I am custom." }],
      },
    ]);

    const result = await listAgentsForContextPack("org-1");

    expect(result.agents[0]?.slug).toBe("my-custom-agent");
  });

  it("emits the persisted agentSlug (SSOT) rather than recomputing from role", async () => {
    // The persisted slug carries the -2 disambiguation suffix; recomputing from
    // role would drop it. The service must emit the stored value verbatim.
    mockDbForListAgents([
      {
        role: "code-reviewer",
        name: "Code Reviewer (repo)",
        agentSlug: "code-reviewer-2",
        versions: [{ content: "Repo-specific reviewer." }],
      },
    ]);

    const result = await listAgentsForContextPack("org-1");

    expect(result.agents[0]?.slug).toBe("code-reviewer-2");
  });

  it("keeps same-role agents from different sourceRepos distinct via persisted slugs (no harness file collision)", async () => {
    // Two agents share the role "code-reviewer" (org-wide + repo-specific
    // override). Before FEA-2923 both recomputed to "code-reviewer" and the
    // harness silently overwrote one .claude/agents/code-reviewer.md. The
    // persisted, disambiguated slugs keep them distinct.
    mockDbForListAgents([
      {
        role: "code-reviewer",
        name: "Code Reviewer (org)",
        agentSlug: "code-reviewer",
        versions: [{ content: "Org-wide reviewer." }],
      },
      {
        role: "code-reviewer",
        name: "Code Reviewer (repo)",
        agentSlug: "code-reviewer-2",
        versions: [{ content: "Repo-specific reviewer." }],
      },
    ]);

    const result = await listAgentsForContextPack("org-1", ["org/repo"]);

    const slugs = result.agents.map((a) => a.slug);
    expect(slugs).toEqual(["code-reviewer", "code-reviewer-2"]);
    // No collision: two distinct harness file names.
    expect(new Set(slugs).size).toBe(result.agents.length);
  });
});

// ---------------------------------------------------------------------------
// Enabled / disabled filter
// ---------------------------------------------------------------------------

describe("listAgentsForContextPack — enabled filter", () => {
  it("returns only enabled items (DB filter: enabled=true, archived=false)", async () => {
    // Simulate the DB already applying the enabled+archived filter by returning
    // only one enabled row.  The service relies on the WHERE clause in the DB
    // query; this test asserts that the service passes the correct shape to the
    // DB and correctly includes enabled items.
    mockDbForListAgents([
      {
        role: "enabled-agent",
        name: "Enabled",
        versions: [{ content: "I am enabled." }],
      },
    ]);

    const result = await listAgentsForContextPack("org-1");

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.slug).toBe("enabled-agent");
  });

  it("returns empty agents list when no items pass the enabled filter", async () => {
    mockDbForListAgents([]);

    const result = await listAgentsForContextPack("org-1");

    expect(result.agents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Asset-only items (null content) must be excluded
// ---------------------------------------------------------------------------

describe("listAgentsForContextPack — asset-only items skipped", () => {
  it("excludes items whose latest version has null content (asset-only)", async () => {
    mockDbForListAgents([
      {
        role: "asset-only",
        name: "Asset Only Agent",
        versions: [{ content: null }],
      },
      {
        role: "real-agent",
        name: "Real Agent",
        versions: [{ content: "A real prompt." }],
      },
    ]);

    const result = await listAgentsForContextPack("org-1");

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.slug).toBe("real-agent");
  });

  it("excludes items that have no versions at all", async () => {
    mockDbForListAgents([
      { role: "no-versions", name: "No Versions", versions: [] },
    ]);

    const result = await listAgentsForContextPack("org-1");

    expect(result.agents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sourceRepo filter: IN ('', ...repos)
// ---------------------------------------------------------------------------

describe("listAgentsForContextPack — sourceRepo filter", () => {
  it("passes sourceRepo IN ['', ...repos] filter when repos are provided", async () => {
    const catalogFindMany = vi.fn().mockResolvedValue([]);
    const repoConfigFindMany = vi.fn().mockResolvedValue([]);

    mockWithDb.mockImplementation(
      (
        callback: (db: {
          catalogItem: { findMany: typeof catalogFindMany };
          repoBootstrapConfig: { findMany: typeof repoConfigFindMany };
        }) => unknown
      ) =>
        callback({
          catalogItem: { findMany: catalogFindMany },
          repoBootstrapConfig: { findMany: repoConfigFindMany },
        })
    );

    await listAgentsForContextPack("org-1", ["owner/repo-a", "owner/repo-b"]);

    expect(catalogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceRepo: { in: ["", "owner/repo-a", "owner/repo-b"] },
        }),
      })
    );
  });

  it("omits sourceRepo filter when no repos are provided", async () => {
    const catalogFindMany = vi.fn().mockResolvedValue([]);
    const repoConfigFindMany = vi.fn().mockResolvedValue([]);

    mockWithDb.mockImplementation(
      (
        callback: (db: {
          catalogItem: { findMany: typeof catalogFindMany };
          repoBootstrapConfig: { findMany: typeof repoConfigFindMany };
        }) => unknown
      ) =>
        callback({
          catalogItem: { findMany: catalogFindMany },
          repoBootstrapConfig: { findMany: repoConfigFindMany },
        })
    );

    await listAgentsForContextPack("org-1");

    const callArgs = catalogFindMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(callArgs?.where).not.toHaveProperty("sourceRepo");
  });

  it("is scoped to the provided organizationId", async () => {
    const catalogFindMany = vi.fn().mockResolvedValue([]);
    const repoConfigFindMany = vi.fn().mockResolvedValue([]);

    mockWithDb.mockImplementation(
      (
        callback: (db: {
          catalogItem: { findMany: typeof catalogFindMany };
          repoBootstrapConfig: { findMany: typeof repoConfigFindMany };
        }) => unknown
      ) =>
        callback({
          catalogItem: { findMany: catalogFindMany },
          repoBootstrapConfig: { findMany: repoConfigFindMany },
        })
    );

    await listAgentsForContextPack("org-xyz");

    expect(catalogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-xyz",
          targetKind: "agent",
          enabled: true,
          archived: false,
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// RepoBootstrapConfig — criticGates
// ---------------------------------------------------------------------------

describe("listAgentsForContextPack — repoConfigs/criticGates", () => {
  it("returns repoConfigs with repoFullName and criticGates", async () => {
    mockDbForListAgents(
      [],
      [
        {
          repoFullName: "owner/repo-a",
          criticGates: { security: true, style: false },
        },
      ]
    );

    const result = await listAgentsForContextPack("org-1", ["owner/repo-a"]);

    expect(result.repoConfigs).toHaveLength(1);
    expect(result.repoConfigs[0]).toEqual({
      repoFullName: "owner/repo-a",
      criticGates: { security: true, style: false },
    });
  });

  it("returns empty repoConfigs when no RepoBootstrapConfig rows match", async () => {
    mockDbForListAgents([]);

    const result = await listAgentsForContextPack("org-1", ["owner/repo-x"]);

    expect(result.repoConfigs).toHaveLength(0);
  });

  it("returns both agents and repoConfigs in the same response", async () => {
    mockDbForListAgents(
      [{ role: "helper", name: "Helper", versions: [{ content: "Help." }] }],
      [{ repoFullName: "owner/repo", criticGates: { lint: true } }]
    );

    const result = await listAgentsForContextPack("org-1", ["owner/repo"]);

    expect(result.agents).toHaveLength(1);
    expect(result.repoConfigs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Flag-off simulation — empty output when no enabled CatalogItems exist
// ---------------------------------------------------------------------------

describe("listAgentsForContextPack — empty output when flag is off (simulated)", () => {
  it("returns empty agents and repoConfigs when the DB returns no rows (flag-off simulation)", async () => {
    // When AGENTS_FEATURE_FLAG_KEY is disabled the upstream caller
    // (fetchAgentsForContextPack in loop-context-pack.ts) short-circuits and
    // never calls listAgentsForContextPack.  We test the catalogue service
    // separately to confirm it returns empty output for empty DB results,
    // which is the same result the caller would return on flag-off.
    mockDbForListAgents([]);

    const result = await listAgentsForContextPack("org-1");

    expect(result).toEqual({ agents: [], repoConfigs: [] });
  });
});
