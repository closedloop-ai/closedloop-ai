import { describe, expect, it } from "vitest";
import {
  isOrgScopeOwned,
  OrgScopeOutcome,
  resolveOrgScope,
  resolveOrgScopeVia,
} from "./org-scope";

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";

describe("resolveOrgScope", () => {
  it("returns Owned with the narrowed entity when the org matches", () => {
    const entity = { organizationId: ORG_A, id: "branch-1" };
    const result = resolveOrgScope(ORG_A, entity);

    expect(result.outcome).toBe(OrgScopeOutcome.Owned);
    // Narrowed non-null on the Owned branch — no re-check needed.
    if (isOrgScopeOwned(result)) {
      expect(result.value).toBe(entity);
      expect(result.value.id).toBe("branch-1");
    } else {
      throw new Error("expected Owned");
    }
  });

  it("returns NotOwned for a cross-org entity (never leaks that it exists)", () => {
    const result = resolveOrgScope(ORG_A, {
      organizationId: ORG_B,
      id: "branch-2",
    });

    expect(result.outcome).toBe(OrgScopeOutcome.NotOwned);
    expect(isOrgScopeOwned(result)).toBe(false);
  });

  it("collapses a null / undefined resolution to the same NotOwned outcome", () => {
    for (const missing of [null, undefined]) {
      const result = resolveOrgScope(ORG_A, missing);
      expect(result.outcome).toBe(OrgScopeOutcome.NotOwned);
    }
  });
});

describe("resolveOrgScopeVia", () => {
  it("returns Owned with the child when the ancestor org matches", () => {
    const child = { id: "token-event-1", inputTokens: 10n };
    const result = resolveOrgScopeVia(ORG_A, { organizationId: ORG_A }, child);

    expect(result.outcome).toBe(OrgScopeOutcome.Owned);
    if (isOrgScopeOwned(result)) {
      expect(result.value).toBe(child);
    } else {
      throw new Error("expected Owned");
    }
  });

  it("returns NotOwned when the ancestor belongs to another org", () => {
    const result = resolveOrgScopeVia(
      ORG_A,
      { organizationId: ORG_B },
      { id: "token-event-2" }
    );
    expect(result.outcome).toBe(OrgScopeOutcome.NotOwned);
  });

  it("returns NotOwned when the ancestor is null/undefined (unresolved chain)", () => {
    for (const missingAncestor of [null, undefined]) {
      const result = resolveOrgScopeVia(ORG_A, missingAncestor, {
        id: "commit-1",
      });
      expect(result.outcome).toBe(OrgScopeOutcome.NotOwned);
    }
  });

  it("returns NotOwned when the child itself did not resolve", () => {
    const result = resolveOrgScopeVia(ORG_A, { organizationId: ORG_A }, null);
    expect(result.outcome).toBe(OrgScopeOutcome.NotOwned);
  });
});
