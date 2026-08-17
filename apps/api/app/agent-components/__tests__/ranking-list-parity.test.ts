/**
 * ISS-4635 regression suite: the ranking leaderboard and the catalog list must
 * describe the SAME org.
 *
 * Two defects motivated this:
 *   1. Ranking aggregated usage only over `AgentComponentSessionUsage` rows
 *      whose nullable `agentComponentId` FK joined a capped inventory id, so an
 *      org whose usage rows are predominantly ORPHANED (usage synced before the
 *      inventory row existed, or never FK-linked) got a leaderboard where every
 *      item reported `invocations: 0` — and the "usage" sort degenerated into an
 *      alphabetical tie-break — while the detail endpoint reported real
 *      invocations for the same component.
 *   2. Ranking deduped on the RAW `${kind}::${componentKey}` slug while the list
 *      normalized instance-unique subagent labels and collapsed content-hash
 *      version buckets into families, so the two endpoints reported different
 *      populations (3311 vs 2132) for one org.
 *
 * Both now read `buildOrgComponentPopulation` + `collapseToCanonicalFamilies`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  // ISS-4669: `buildOrgComponentPopulation` reads FK-linked + orphan usage in one
  // `withDb.tx({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })`
  // snapshot, so the mocked module must expose that enum value.
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

// Both services transitively pull the heavy agent-sessions read service (the
// detail path's `sessionsTab`). Stub it so these tests stay isolated — neither
// `getRanking` nor `listForOrg` calls it.
vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: vi.fn().mockResolvedValue([]) },
}));

import { rankingService } from "../ranking/service";
import { agentComponentsService } from "../service";
import {
  buildPopulationDb,
  listQuery,
  mismatchedFkKindFixtures,
  mismatchedFkSearchFixtures,
  multiVersionFamilyFixtures,
  ORG_A,
  type PopulationFixtures,
  reportedOrgFixtures,
} from "./org-population-fixtures";

function installDb(fixtures: PopulationFixtures) {
  const built = buildPopulationDb(fixtures);
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  return built;
}

describe("ISS-4635 — ranking/list population and usage parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts orphan (null-FK) usage, so a used component never ranks at zero", async () => {
    installDb(reportedOrgFixtures());

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    const mcp = result.items.find(
      (item) => item.slug === "mcp::mcp__closedloop__create_branch_artifact"
    );
    // 2 + 1 orphan invocations across two distinct sessions — the exact count
    // the detail endpoint reports, not the 0 the FK-only rollup produced.
    expect(mcp?.invocations).toBe(3);
    expect(mcp?.sessions).toBe(2);
    expect(mcp?.errorRate).toBeCloseTo(1 / 3);

    // Usage-only components (no inventory row at all) are ranked too.
    const usageOnly = result.items.find(
      (item) => item.slug === "skill::usage-only-skill"
    );
    expect(usageOnly?.invocations).toBe(7);

    // And the leaderboard is genuinely ordered by usage — the alphabetically
    // first component (`_add_comment_to_issue`, 1 invocation) is NOT rank 1.
    expect(result.items[0]?.slug).toBe("skill::usage-only-skill");
    expect(result.items[0]?.rank).toBe(1);
    expect(result.items.map((item) => item.invocations)).toEqual([7, 3, 1, 0]);
  });

  it("ranks the same population the catalog list reports for one org", async () => {
    installDb(reportedOrgFixtures());
    const ranking = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 200,
    });

    installDb(reportedOrgFixtures());
    const list = await agentComponentsService.listForOrg(ORG_A, listQuery());

    // Same count …
    expect(ranking.total).toBe(list.total);
    // … over the same components: the three instance-unique subagent rows fold
    // into ONE `general-purpose` identity, and the usage-only skill (which has
    // no inventory row) is present, on BOTH surfaces.
    expect([...ranking.items.map((item) => item.name)].sort()).toEqual(
      [...list.items.map((item) => item.name)].sort()
    );
    expect(ranking.total).toBe(4);

    // … reporting the same usage per component.
    const listInvocationsByName = new Map(
      list.items.map((item) => [item.name, item.invocations])
    );
    for (const item of ranking.items) {
      expect(item.invocations).toBe(listInvocationsByName.get(item.name));
    }
  });

  it("collapses same-slug version buckets into ONE family with summed usage on both surfaces", async () => {
    // shafty023 review: the fixtures above only carry `contentHash: null`, so they
    // never create multiple version buckets for one component and family collapse
    // is not actually exercised. This fixture installs `command::build` at TWO
    // distinct content hashes (5 + 3 invocations across 2 sessions). Both surfaces
    // MUST report ONE `build` row with the summed usage — dropping
    // `collapseToCanonicalFamilies` from either would split it back into two.
    installDb(multiVersionFamilyFixtures());
    const ranking = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 200,
    });

    installDb(multiVersionFamilyFixtures());
    const list = await agentComponentsService.listForOrg(ORG_A, listQuery());

    // ONE family on each surface, not two version buckets.
    expect(ranking.total).toBe(1);
    expect(list.total).toBe(1);
    expect(ranking.items).toHaveLength(1);
    expect(list.items).toHaveLength(1);

    // Summed usage across both version buckets (5 + 3), over both sessions.
    expect(ranking.items[0]?.name).toBe("build");
    expect(list.items[0]?.name).toBe("build");
    expect(ranking.items[0]?.invocations).toBe(8);
    expect(list.items[0]?.invocations).toBe(8);
    expect(ranking.items[0]?.sessions).toBe(2);
    expect(list.items[0]?.sessions).toBe(2);

    // The list row surfaces the collapsed version count (the quiet catalog signal).
    expect(list.items[0]?.versionCount).toBe(2);
  });

  it("applies the same kind facet to both surfaces", async () => {
    installDb(reportedOrgFixtures());
    const ranking = await rankingService.getRanking({
      organizationId: ORG_A,
      kind: "mcp",
      limit: 200,
    });

    installDb(reportedOrgFixtures());
    const list = await agentComponentsService.listForOrg(
      ORG_A,
      listQuery({ kinds: ["mcp"] })
    );

    expect(ranking.total).toBe(list.total);
    expect(ranking.items).toHaveLength(1);
    expect(ranking.items[0]?.invocations).toBe(3);
    expect(list.items[0]?.invocations).toBe(3);
  });

  it("does not leak a mismatched-FK cross-kind usage row into a ?kind= response", async () => {
    // shafty023 review: `foldFkUsageIntoMerged` (ISS-4630) attributes FK-linked
    // usage by the usage row's OWN (kind, key) and SEEDS a synthetic bucket for an
    // identity absent from the kind-filtered inventory. A usage row FK-linked to a
    // selected `skill` row but carrying its own `command::deploy` identity would
    // otherwise surface a command under `?kind=skill`. The FK groupBy is now
    // kind-scoped, so the mismatched group is dropped before the fold.
    installDb(mismatchedFkKindFixtures());
    const ranking = await rankingService.getRanking({
      organizationId: ORG_A,
      kind: "skill",
      limit: 200,
    });

    installDb(mismatchedFkKindFixtures());
    const list = await agentComponentsService.listForOrg(
      ORG_A,
      listQuery({ kinds: ["skill"] })
    );

    // Both surfaces: exactly ONE row (the skill), NEVER the mismatched command.
    for (const surface of [ranking.items, list.items]) {
      expect(surface).toHaveLength(1);
      expect(surface[0]?.kind).toBe("skill");
      expect(surface[0]?.name).toBe("review");
      // Only the skill's own matching usage (4) counts — never the FK'd command's 9.
      expect(surface[0]?.invocations).toBe(4);
    }
    expect(ranking.total).toBe(1);
    expect(list.total).toBe(1);
    expect(
      [...ranking.items, ...list.items].some((item) => item.kind === "command")
    ).toBe(false);
  });

  it("does not leak a mismatched-FK usage row into a ?search= response", async () => {
    // ISS-4660 (item 3): the `?search=` analogue of the kind leak above. The
    // inventory read is search-filtered, but `foldFkUsageIntoMerged` (ISS-4630)
    // attributes FK-linked usage by the usage row's OWN key and SEEDS a bucket
    // for an identity the inventory read never returned — and the list applies
    // no post-fold search filter. A usage row FK-linked to the matching
    // "Review helper" row but carrying its own `deploy` key would therefore
    // surface `deploy` under `?search=review`. The FK groupBy now carries the
    // same search predicate as the orphan lane, so the mismatched group is
    // dropped first.
    //
    // The fixture matches on the display NAME only (its key is `code-audit`),
    // which is what exercises `usageSearchWhere`'s `nameMatchedIdentities` arm
    // rather than its `componentKey contains` arm — PR #4285 reviewer wongk.
    installDb(mismatchedFkSearchFixtures());
    const list = await agentComponentsService.listForOrg(
      ORG_A,
      listQuery({ search: "review" })
    );

    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.name).toBe("Review helper");
    // Only the matching identity's own usage (4) counts — never the 9 belonging
    // to the `deploy` identity the search excluded. This number is the proof the
    // name-matched arm is applied: the honest row's key does not contain
    // "review", so without that arm the predicate would drop it too and this
    // would read 0.
    expect(list.items[0]?.invocations).toBe(4);
    // A leaked synthetic bucket has no inventory row, so it would surface under
    // its own key as both the name and the identity slug.
    expect(list.items.some((item) => item.name === "deploy")).toBe(false);
    expect(list.items.some((item) => item.slug.endsWith("deploy"))).toBe(false);
    expect(list.total).toBe(1);
  });
});
