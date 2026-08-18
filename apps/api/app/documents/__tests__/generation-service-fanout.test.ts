/**
 * FEA-3299 regression: the PRODUCES-lineage walk must not fan out one pooled pg
 * connection per frontier node.
 *
 * `SOURCE_LINEAGE_MAX_DEPTH` bounds how *deep* the walk goes and the `visited`
 * set stops it revisiting, but neither bounds the frontier's *width*: an
 * artifact with many PRODUCES parents issues one `findSourceLinks` query per
 * parent, concurrently, and the frontier compounds at each level. Link counts
 * are user-grown (createLink / the MCP tool / gdrive import), so nothing in the
 * schema caps them (PRD-528).
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DB_FANOUT_MAX_CONCURRENCY } from "@/lib/db-fanout";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  findSourceLinks: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  ArtifactType: { DOCUMENT: "DOCUMENT" },
}));

vi.mock("../../artifact-links/service", () => ({
  artifactLinksService: { findSourceLinks: mocks.findSourceLinks },
}));

import { documentGenerationService } from "../generation-service";

const ORG_ID = "org-1";
const ROOT_ID = "artifact-root";
const PROJECT_ID = "project-1";

// Sized off the bound, not hardcoded: must always exceed
// DB_FANOUT_MAX_CONCURRENCY or the assertion has no power.
const PARENT_COUNT = DB_FANOUT_MAX_CONCURRENCY * 2 + 2;

describe("findSourcePrdContext lineage fan-out (FEA-3299)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bounds concurrent PRODUCES-link lookups across a wide frontier", async () => {
    // Level 1: the root has PARENT_COUNT distinct PRODUCES parents, so the
    // level-2 frontier is PARENT_COUNT wide and every node issues its own
    // pooled query.
    const wideParents = Array.from({ length: PARENT_COUNT }, (_, i) => ({
      sourceId: `parent-${i}`,
    }));

    let inFlight = 0;
    let peakInFlight = 0;
    mocks.findSourceLinks.mockImplementation(async (_org, id: string) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return id === ROOT_ID ? wideParents : [];
    });

    mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({
        artifact: {
          findUnique: () => Promise.resolve({ projectId: PROJECT_ID }),
          // No parent resolves to a PRD/Feature document, so the walk keeps
          // expanding through the wide frontier — which is the case under test.
          findMany: vi.fn().mockResolvedValue([]),
        },
      })
    );

    await documentGenerationService.findSourcePrdContext(ROOT_ID, ORG_ID);

    // An unbounded Promise.all over the level-2 frontier would peak at 12.
    expect(peakInFlight).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);
    expect(peakInFlight).toBeGreaterThan(1);
    // Every frontier node was still visited: root + PARENT_COUNT parents.
    expect(mocks.findSourceLinks).toHaveBeenCalledWith(
      ORG_ID,
      ROOT_ID,
      LinkType.Produces
    );
    expect(mocks.findSourceLinks).toHaveBeenCalledTimes(1 + PARENT_COUNT);
  });
});
