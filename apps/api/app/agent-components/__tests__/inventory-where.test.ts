/**
 * FEA-4086: the org inventory read (`listForOrg`) must scope to
 * currently-installed components. The desktop tombstones an uninstalled
 * component by stamping `uninstalledAt` on its row (it does not delete the row),
 * so without a `uninstalledAt: null` predicate the web/desktop-Cloud inventory
 * keeps tombstoned rows forever and the honest "No plugins installed." empty
 * state is unreachable. These cover the where-builder that produces that
 * predicate directly, so the tombstone filter cannot silently regress.
 */
import { describe, expect, it, vi } from "vitest";

// The service module pulls @repo/database and the sessions service at import
// time; mock the minimum so we can import the pure where-builder in isolation.
vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));
vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: vi.fn() },
}));

import { orgInventoryWhere } from "../org-population-reads";

describe("orgInventoryWhere — tombstone scoping (FEA-4086)", () => {
  it("filters uninstalled (tombstoned) rows out of the org inventory read", () => {
    const where = orgInventoryWhere("org-1", {});
    // A row whose `uninstalledAt` is set (tombstoned) cannot match `null`, so it
    // never surfaces; active rows (`uninstalledAt === null`, incl. pre-column
    // NULLs) do.
    expect(where).toMatchObject({
      organizationId: "org-1",
      uninstalledAt: null,
    });
  });

  it("keeps the tombstone predicate alongside the kind + search facets", () => {
    const where = orgInventoryWhere("org-2", {
      kinds: ["plugin"],
      search: "pack",
    });
    expect(where.organizationId).toBe("org-2");
    expect(where.uninstalledAt).toBeNull();
    expect(where.componentKind).toEqual({ in: ["plugin"] });
    // Search is an OR over name + componentKey; the tombstone filter is a
    // sibling predicate, ANDed, not swallowed by the search OR.
    expect(Array.isArray(where.OR)).toBe(true);
  });

  it("still emits the tombstone predicate on a bare unfiltered read", () => {
    const where = orgInventoryWhere("org-3", {});
    expect(Object.keys(where)).toContain("uninstalledAt");
    expect(where.uninstalledAt).toBeNull();
    expect(where.componentKind).toBeUndefined();
    expect(where.OR).toBeUndefined();
  });
});
