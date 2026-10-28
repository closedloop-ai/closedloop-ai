/**
 * ISS-6756 (whitlockk) — `usageSearchWhere`'s READMISSION arm is an identity
 * equality, so it must ask for the persisted fold rather than for Prisma's
 * `mode: "insensitive"`.
 *
 * That arm exists because a component found by its display `name` has no `name`
 * column on the usage table, so its rows are readmitted by `(kind, key)`.
 * Prisma compiles `{ equals: k, mode: "insensitive" }` to `component_key ILIKE
 * $n` and binds `k` as the PATTERN, unescaped — so readmitting
 * `mcp__closedloop__ping` also readmitted `mcpXXclosedloopYYping`, and the
 * orphan fold seeded a synthetic bucket for a DIFFERENT component into a
 * `?search=` response. The list applies no post-fold `search` filter, so nothing
 * downstream would have caught it.
 *
 * The substring arm is deliberately still on the raw column: it is a genuine
 * `contains` over whatever the user typed, and there is no folded value to
 * compare a fragment against.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

import {
  matchesUsageSearchOr,
  type UsageSearchOr,
} from "@/__tests__/support/agent-components/usage-lane-doubles";
import { usageSearchWhere } from "../org-population-reads";

const MCP_KEY = "Mcp__closedloop__ping";
const MCP_DECOY_KEY = "mcpXXclosedloopYYping";
const KIND = "mcp_tool";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usageSearchWhere identity arm (ISS-6756)", () => {
  it("readmits a name-matched identity by its persisted fold, with no ILIKE", () => {
    const where = usageSearchWhere({
      search: "ping",
      nameMatchedIdentities: [{ kind: KIND, key: MCP_KEY }],
    });

    expect(where.OR).toEqual([
      { componentKey: { contains: "ping", mode: "insensitive" } },
      { componentKind: KIND, componentKeyNormalized: "mcp__closedloop__ping" },
    ]);
    // The substring arm keeps its `mode`; the identity arm must not have one.
    expect(JSON.stringify(where.OR?.[1])).not.toContain("insensitive");
  });

  it("does not readmit a different component whose key differs only where the `_`s are", () => {
    const or = usageSearchWhere({
      // A search that the decoy's key does NOT contain, so the substring arm
      // cannot admit it and the identity arm is the only way in.
      search: "closedloop__ping",
      nameMatchedIdentities: [{ kind: KIND, key: MCP_KEY }],
    }).OR as UsageSearchOr;

    expect(
      matchesUsageSearchOr({ componentKind: KIND, componentKey: MCP_KEY }, or)
    ).toBe(true);
    expect(
      matchesUsageSearchOr(
        { componentKind: KIND, componentKey: MCP_DECOY_KEY },
        or
      )
    ).toBe(false);
  });

  it("emits no predicate at all when there is no search facet", () => {
    expect(usageSearchWhere(null)).toEqual({});
    expect(
      usageSearchWhere({ search: undefined, nameMatchedIdentities: [] })
    ).toEqual({});
  });
});
