/**
 * The plugin child-usage identity prefilter must be expressible as an INDEXED
 * equality on the persisted fold, on BOTH lanes that emit it — the list rollup
 * (`loadChildUsageByPackId`) and the detail lookup
 * (`loadDetailChildIdentityLookup`).
 *
 * The predicate used to be a case-insensitive `contains` of the normalized key on
 * the RAW `component_key` column. `ILIKE` is an operator no btree implements, so
 * that spelling scanned every same-kind row of the table ACROSS EVERY TENANT —
 * this table carries no `organization_id`, org arrives through the
 * `session.artifact` join — and discarded the rest with a post-scan filter. The
 * ISS-6756 index migration named this lane as the one it could not help; the
 * equality asserted here is what reaches
 * `agent_component_session_usage_kind_key_norm_idx`.
 *
 * A shape test, not a row test, for the reason
 * `token-trend-identity-index.test.ts` states about its own lane: the scanning
 * spelling and the indexed one return the SAME rows, so no assertion on the
 * rollup's numbers can tell them apart. Only the predicate can.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadChildUsageByPackId,
  loadDetailChildIdentityLookup,
} from "../plugin-child-usage";

const ORG = "org-prefilter-1111";

/** Inventory children whose keys carry the case/whitespace the fold removes. */
const CHILD_INVENTORY = [
  {
    id: "inv-skill",
    componentKind: AgentComponentKind.Skill,
    componentKey: "  Deploy  ",
    packId: "pack-a",
    uninstalledAt: null,
  },
  {
    id: "inv-command",
    componentKind: AgentComponentKind.Command,
    componentKey: "Ship-It",
    packId: "pack-a",
    uninstalledAt: null,
  },
];

/** The arms both lanes must emit, written out rather than derived from the code. */
const EXPECTED_PREFILTER = [
  {
    componentKind: AgentComponentKind.Skill,
    componentKeyNormalized: "deploy",
  },
  {
    componentKind: AgentComponentKind.Command,
    componentKeyNormalized: "ship-it",
  },
];

const EXPECTED_LIST_PREFILTER = [
  { agentComponentId: { in: ["inv-skill", "inv-command"] } },
  ...EXPECTED_PREFILTER,
];

function makeDb(): {
  db: Record<string, unknown>;
  usageFindMany: ReturnType<typeof vi.fn>;
} {
  const usageFindMany = vi.fn().mockResolvedValue([]);
  return {
    db: {
      agentComponent: { findMany: vi.fn().mockResolvedValue(CHILD_INVENTORY) },
      agentComponentSessionUsage: { findMany: usageFindMany },
    },
    usageFindMany,
  };
}

/**
 * Every operator spelling a btree on `(component_kind, component_key_normalized)`
 * cannot serve. Asserted as absence from the serialized predicate so a future arm
 * that reintroduces one on ANY key — not only the two this test names — is caught.
 */
const UNINDEXABLE_PREDICATE_TOKENS = [
  "insensitive",
  "contains",
  // Quoted, so it names the RAW column's JSON key and is not satisfied by the
  // `componentKeyNormalized` key that legitimately starts with it.
  '"componentKey"',
];

describe("child-usage identity prefilter is an indexed equality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits indexed component-id and normalized-key arms from the list rollup", async () => {
    const { db, usageFindMany } = makeDb();

    await loadChildUsageByPackId(db as never, ["pack-a"], ORG);

    // ISS-8932 issues the FK lane and the identity lane as separate bound-sliced
    // statements, so the prefilter this asserts is their union in emission order
    // — flattened rather than read off one call, which also puts every emitted
    // statement under the unindexable-token check instead of only the first.
    const arms = usageFindMany.mock.calls.flatMap(
      ([args]) => (args.where as { OR: unknown[] }).OR
    );
    expect(arms).toEqual(EXPECTED_LIST_PREFILTER);
    for (const token of UNINDEXABLE_PREDICATE_TOKENS) {
      expect(JSON.stringify(arms)).not.toContain(token);
    }
  });

  it("emits the same equalities for the detail lookup", async () => {
    const { db } = makeDb();

    const { identityPrefilter } = await loadDetailChildIdentityLookup(
      db as never,
      ["pack-a"],
      ORG
    );

    expect(identityPrefilter).toEqual(EXPECTED_PREFILTER);
    for (const token of UNINDEXABLE_PREDICATE_TOKENS) {
      expect(JSON.stringify(identityPrefilter)).not.toContain(token);
    }
  });

  it("skips an inventory child whose key folds to nothing", async () => {
    // A child whose key folds to nothing has no identity to ask for, and an
    // equality on `''` would admit every usage row whose own key is blank or
    // whitespace — the one case where narrowing the predicate could WIDEN the
    // admitted set instead.
    const usageFindMany = vi.fn().mockResolvedValue([]);
    const db = {
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          ...CHILD_INVENTORY,
          {
            id: "inv-blank",
            componentKind: AgentComponentKind.Mcp,
            componentKey: "   ",
            packId: "pack-a",
            uninstalledAt: null,
          },
        ]),
      },
      agentComponentSessionUsage: { findMany: usageFindMany },
    };

    await loadChildUsageByPackId(db as never, ["pack-a"], ORG);

    const arms = usageFindMany.mock.calls.flatMap(
      (call) => (call[0] as { where: { OR: unknown[] } }).where.OR
    ) as Array<{
      componentKeyNormalized?: string;
      agentComponentId?: { in: string[] };
    }>;
    expect(arms).toEqual([
      {
        agentComponentId: {
          in: ["inv-skill", "inv-command", "inv-blank"],
        },
      },
      ...EXPECTED_PREFILTER,
    ]);
    expect(arms.some((arm) => arm.componentKeyNormalized === "")).toBe(false);
  });
});
