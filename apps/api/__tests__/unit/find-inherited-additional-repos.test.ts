/**
 * Tests for loopsService.findInheritedAdditionalRepos.
 *
 * The method drives the UI pre-fill: given a target command the user is
 * about to launch and a source document, it resolves the peer-repo set the
 * UI should default to. The precedence chain is dispatched per target
 * command — see `INHERITED_REPOS_SOURCE_PRECEDENCE` in service.ts:
 *
 *   PLAN              → [PLAN, GENERATE_PRD]
 *   GENERATE_PRD      → [GENERATE_PRD]
 *   REQUEST_PRD_CHANGES → [GENERATE_PRD]
 *   EXECUTE           → [PLAN, EXECUTE]
 *   (others)          → no chain → returns { [], null } without hitting DB
 *
 * For each source command in a chain we look for the latest non-empty
 * `additionalRepos` — preferring COMPLETED, then falling back to
 * CANCELLED/TIMED_OUT. FAILED loops and active states are never queried.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: vi.fn(),
  RunTaskCommand: vi.fn(),
  StopTaskCommand: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  getInstallationAccessToken: vi.fn(),
  verifyInstallationBranchExists: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  GitHubInstallationStatus: {
    Active: "ACTIVE",
    Suspended: "SUSPENDED",
    Pending: "PENDING",
  },
  Prisma: { JsonNull: null },
}));

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: {
    select: { id: true, email: true, firstName: true, lastName: true },
  },
}));

// --- Imports (after mocks) ---

import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { loopsService } from "@/app/loops/service";

const mockWithDb = withDb as unknown as Mock;

type FindFirstResult = {
  id: string;
  command: string;
  additionalRepos: unknown;
} | null;

type ArtifactLinkFindFirstResult = { sourceId: string } | null;

/**
 * Stage a sequence of loop.findFirst responses, one per call. Returns the spy
 * so tests can assert the where clauses each call received.
 *
 * artifactLink.findFirst defaults to null (no PRODUCES parent) so existing
 * tests that only care about the self-lookup path are unaffected.
 */
function stageFindFirstSequence(
  results: FindFirstResult[],
  artifactLinkResults: ArtifactLinkFindFirstResult[] = []
) {
  const findFirst = vi.fn();
  for (const result of results) {
    findFirst.mockResolvedValueOnce(result);
  }
  const artifactLinkFindFirst = vi.fn();
  for (const result of artifactLinkResults) {
    artifactLinkFindFirst.mockResolvedValueOnce(result);
  }
  // Default: no parent artifact link exists (terminates ancestor walk).
  artifactLinkFindFirst.mockResolvedValue(null);
  mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      loop: { findFirst },
      artifactLink: { findFirst: artifactLinkFindFirst },
    })
  );
  return { findFirst, artifactLinkFindFirst };
}

const PEERS = [
  { fullName: "org/peer-a", branch: "main" },
  { fullName: "org/peer-b", branch: "develop" },
];

describe("loopsService.findInheritedAdditionalRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("target = PLAN (chain: PLAN, GENERATE_PRD)", () => {
    it("returns the latest COMPLETED PLAN's additionalRepos with source command PLAN", async () => {
      stageFindFirstSequence([
        {
          id: "plan-completed",
          command: LoopCommand.Plan,
          additionalRepos: PEERS,
        },
      ]);

      const result = await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.Plan
      );

      expect(result).toEqual({
        additionalRepos: PEERS,
        source: {
          loopId: "plan-completed",
          command: LoopCommand.Plan,
          artifactId: "doc-1",
        },
      });
    });

    it("falls back to a CANCELLED PLAN when no COMPLETED PLAN exists", async () => {
      stageFindFirstSequence([
        null,
        {
          id: "plan-cancelled",
          command: LoopCommand.Plan,
          additionalRepos: PEERS,
        },
      ]);

      const result = await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.Plan
      );

      expect(result.source?.loopId).toBe("plan-cancelled");
      expect(result.source?.command).toBe(LoopCommand.Plan);
      expect(result.additionalRepos).toEqual(PEERS);
    });

    it("falls back to GENERATE_PRD when no PLAN loop has peers", async () => {
      stageFindFirstSequence([
        null,
        null,
        {
          id: "prd-completed",
          command: LoopCommand.GeneratePrd,
          additionalRepos: PEERS,
        },
      ]);

      const result = await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.Plan
      );

      expect(result.source).toEqual({
        loopId: "prd-completed",
        command: LoopCommand.GeneratePrd,
        artifactId: "doc-1",
      });
      expect(result.additionalRepos).toEqual(PEERS);
    });

    it("treats a candidate with empty additionalRepos as no candidate and keeps falling through", async () => {
      stageFindFirstSequence([
        { id: "plan-empty", command: LoopCommand.Plan, additionalRepos: [] },
        {
          id: "plan-cancelled-empty",
          command: LoopCommand.Plan,
          additionalRepos: null,
        },
        {
          id: "prd-completed",
          command: LoopCommand.GeneratePrd,
          additionalRepos: PEERS,
        },
      ]);

      const result = await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.Plan
      );

      expect(result.source?.loopId).toBe("prd-completed");
    });

    it("returns no source when nothing inheritable exists", async () => {
      stageFindFirstSequence([null, null, null, null]);

      const result = await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.Plan
      );

      expect(result).toEqual({ additionalRepos: [], source: null });
    });

    it("scopes every query to artifactId + organizationId and never queries FAILED or active states", async () => {
      const { findFirst } = stageFindFirstSequence([null, null, null, null]);

      await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.Plan
      );

      expect(findFirst).toHaveBeenCalledTimes(4);
      for (const call of findFirst.mock.calls) {
        const where = call[0].where as Record<string, unknown>;
        expect(where.artifactId).toBe("doc-1");
        expect(where.organizationId).toBe("org-1");
        const statusJson = JSON.stringify(where.status);
        expect(statusJson).not.toContain(LoopStatus.Failed);
        expect(statusJson).not.toContain(LoopStatus.Pending);
        expect(statusJson).not.toContain(LoopStatus.Claimed);
        expect(statusJson).not.toContain(LoopStatus.Running);
      }
    });

    it("stops querying as soon as a candidate with peers is found", async () => {
      const { findFirst } = stageFindFirstSequence([
        {
          id: "plan-completed",
          command: LoopCommand.Plan,
          additionalRepos: PEERS,
        },
      ]);

      await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.Plan
      );

      expect(findFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe("target = EXECUTE (chain: PLAN, EXECUTE)", () => {
    it("inherits from the latest PLAN loop on this document", async () => {
      const { findFirst } = stageFindFirstSequence([
        {
          id: "plan-completed",
          command: LoopCommand.Plan,
          additionalRepos: PEERS,
        },
      ]);

      const result = await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.Execute
      );

      expect(result.source).toEqual({
        loopId: "plan-completed",
        command: LoopCommand.Plan,
        artifactId: "doc-1",
      });
      // First query is the PLAN tier; never reached EXECUTE.
      expect(findFirst.mock.calls[0][0].where.command).toBe(LoopCommand.Plan);
    });

    it("falls back to EXECUTE when no PLAN loop has peers", async () => {
      const { findFirst } = stageFindFirstSequence([
        null,
        null,
        {
          id: "execute-completed",
          command: LoopCommand.Execute,
          additionalRepos: PEERS,
        },
      ]);

      const result = await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.Execute
      );

      expect(result.source?.command).toBe(LoopCommand.Execute);
      expect(findFirst.mock.calls[2][0].where.command).toBe(
        LoopCommand.Execute
      );
    });
  });

  describe("target = GENERATE_PRD (chain: GENERATE_PRD)", () => {
    it("only queries GENERATE_PRD loops", async () => {
      const { findFirst } = stageFindFirstSequence([
        {
          id: "prd-completed",
          command: LoopCommand.GeneratePrd,
          additionalRepos: PEERS,
        },
      ]);

      const result = await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.GeneratePrd
      );

      expect(result.source?.command).toBe(LoopCommand.GeneratePrd);
      for (const call of findFirst.mock.calls) {
        expect(call[0].where.command).toBe(LoopCommand.GeneratePrd);
      }
    });

    it("queries at most twice (COMPLETED + fallback) and returns empty when nothing matches", async () => {
      const { findFirst } = stageFindFirstSequence([null, null]);

      const result = await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.GeneratePrd
      );

      expect(result).toEqual({ additionalRepos: [], source: null });
      expect(findFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe("target = REQUEST_PRD_CHANGES (chain: GENERATE_PRD)", () => {
    it("inherits from the originating GENERATE_PRD on this PRD", async () => {
      const { findFirst } = stageFindFirstSequence([
        {
          id: "prd-completed",
          command: LoopCommand.GeneratePrd,
          additionalRepos: PEERS,
        },
      ]);

      const result = await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.RequestPrdChanges
      );

      expect(result.source?.command).toBe(LoopCommand.GeneratePrd);
      expect(findFirst.mock.calls[0][0].where.command).toBe(
        LoopCommand.GeneratePrd
      );
    });
  });

  describe("targets without an inheritance chain", () => {
    it("returns empty without hitting the DB for CHAT", async () => {
      const { findFirst } = stageFindFirstSequence([]);

      const result = await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.Chat
      );

      expect(result).toEqual({ additionalRepos: [], source: null });
      expect(findFirst).not.toHaveBeenCalled();
    });

    it("returns empty without hitting the DB for evaluators", async () => {
      const { findFirst } = stageFindFirstSequence([]);

      for (const cmd of [
        LoopCommand.EvaluatePrd,
        LoopCommand.EvaluatePlan,
        LoopCommand.EvaluateCode,
        LoopCommand.EvaluateFeature,
        LoopCommand.Decompose,
        LoopCommand.Explore,
        LoopCommand.Bootstrap,
        LoopCommand.RequestChanges,
      ]) {
        const result = await loopsService.findInheritedAdditionalRepos(
          "doc-1",
          "org-1",
          cmd
        );
        expect(result).toEqual({ additionalRepos: [], source: null });
      }
      expect(findFirst).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Ancestor walk (PRODUCES link inheritance)
  // ---------------------------------------------------------------------------

  describe("ancestor walk via PRODUCES links", () => {
    /**
     * AC-001: Feature -> PRD (one hop).
     * Feature has no prior loops; PRD has additionalRepos on its GENERATE_PRD loop.
     * The chain for PLAN target is [PLAN, GENERATE_PRD].
     * Self-lookup exhausts 4 loop.findFirst calls (2 commands × 2 status tiers),
     * then artifactLink.findFirst returns the PRD's id, and the PRD's
     * GENERATE_PRD COMPLETED loop supplies the peer set.
     */
    it("inherits additionalRepos from a parent PRD when Feature has no prior loops (AC-001)", async () => {
      // Self-lookup: 4 null results (PLAN/COMPLETED, PLAN/fallback, GeneratePrd/COMPLETED, GeneratePrd/fallback)
      // Ancestor lookup for PRD: PLAN/COMPLETED → null, PLAN/fallback → null, GeneratePrd/COMPLETED → hit
      const { findFirst, artifactLinkFindFirst } = stageFindFirstSequence(
        [
          null,
          null,
          null,
          null,
          null,
          null,
          {
            id: "prd-loop",
            command: LoopCommand.GeneratePrd,
            additionalRepos: PEERS,
          },
        ],
        [{ sourceId: "prd-id" }]
      );

      const result = await loopsService.findInheritedAdditionalRepos(
        "feature-id",
        "org-1",
        LoopCommand.Plan
      );

      expect(result).toEqual({
        additionalRepos: PEERS,
        source: {
          loopId: "prd-loop",
          command: LoopCommand.GeneratePrd,
          artifactId: "prd-id",
        },
      });
      // artifactLink.findFirst must have been called with the feature's id as targetId
      expect(artifactLinkFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ targetId: "feature-id" }),
        })
      );
      // loop.findFirst should have been called with the ancestor's id too
      const prdLoopCall = findFirst.mock.calls.find(
        (call) => call[0].where.artifactId === "prd-id"
      );
      expect(prdLoopCall).toBeDefined();
    });

    /**
     * AC-003: Plan -> Feature -> PRD (two hops).
     * Plan launched on a Feature; Feature has no loops; PRD has additionalRepos.
     * The ancestor walk must step through Feature first, find nothing,
     * then step up to the PRD and find the peer set.
     */
    it("walks two hops (Plan -> Feature -> PRD) to inherit additionalRepos (AC-003)", async () => {
      // For PLAN command, precedence = [PLAN, GENERATE_PRD]
      // Plan self-lookup: 4 nulls
      // Feature ancestor: artifactLink → feature-id, then walkPrecedence(feature-id): 4 nulls
      // PRD ancestor: artifactLink → prd-id, then walkPrecedence(prd-id): PLAN/COMPLETED null, PLAN/fallback null, GeneratePrd/COMPLETED → hit
      const { findFirst, artifactLinkFindFirst } = stageFindFirstSequence(
        [
          null,
          null,
          null,
          null, // plan self-lookup: 4 nulls
          null,
          null,
          null,
          null, // feature ancestor walkPrecedence: 4 nulls
          null,
          null, // prd ancestor PLAN tier (COMPLETED + fallback)
          {
            id: "prd-loop-2",
            command: LoopCommand.GeneratePrd,
            additionalRepos: PEERS,
          }, // prd GeneratePrd COMPLETED
        ],
        [
          { sourceId: "feature-id" }, // plan's PRODUCES parent is Feature
          { sourceId: "prd-id" }, // feature's PRODUCES parent is PRD
        ]
      );

      const result = await loopsService.findInheritedAdditionalRepos(
        "plan-id",
        "org-1",
        LoopCommand.Plan
      );

      expect(result.additionalRepos).toEqual(PEERS);
      expect(result.source).toEqual({
        loopId: "prd-loop-2",
        command: LoopCommand.GeneratePrd,
        artifactId: "prd-id",
      });
      // Two artifactLink lookups should have occurred
      expect(artifactLinkFindFirst).toHaveBeenCalledTimes(2);
      // First link lookup must scope to plan-id
      expect(artifactLinkFindFirst.mock.calls[0][0].where.targetId).toBe(
        "plan-id"
      );
      // Second link lookup must scope to feature-id
      expect(artifactLinkFindFirst.mock.calls[1][0].where.targetId).toBe(
        "feature-id"
      );
      // loop.findFirst must have queried the PRD's id at some point
      const prdLoopCalls = findFirst.mock.calls.filter(
        (call) => call[0].where.artifactId === "prd-id"
      );
      expect(prdLoopCalls.length).toBeGreaterThan(0);
    });

    /**
     * AC-002: Sibling Features independently inherit the same PRD's additionalRepos.
     * Each Feature's lookup follows the same ancestor walk and reaches the same PRD.
     */
    it("two sibling Features each independently inherit the PRD's additionalRepos (AC-002)", async () => {
      function runForFeature(featureId: string) {
        // Self-lookup: 4 nulls; ancestor: artifactLink returns prd-id; PRD PLAN tier: 2 nulls, GeneratePrd COMPLETED hits
        stageFindFirstSequence(
          [
            null,
            null,
            null,
            null,
            null,
            null,
            {
              id: "prd-loop-shared",
              command: LoopCommand.GeneratePrd,
              additionalRepos: PEERS,
            },
          ],
          [{ sourceId: "prd-id" }]
        );
        return loopsService.findInheritedAdditionalRepos(
          featureId,
          "org-1",
          LoopCommand.Plan
        );
      }

      const [resultA, resultB] = await Promise.all([
        runForFeature("feature-a"),
        runForFeature("feature-b"),
      ]);

      expect(resultA.additionalRepos).toEqual(PEERS);
      expect(resultB.additionalRepos).toEqual(PEERS);
      expect(resultA.source?.artifactId).toBe("prd-id");
      expect(resultB.source?.artifactId).toBe("prd-id");
    });

    /**
     * AC-004: An ancestor with empty additionalRepos falls through to its own parent.
     * Feature has no loops; Feature's parent PRD has empty additionalRepos on its loop;
     * PRD's parent grandparent PRD has PEERS.
     */
    it("falls through an ancestor with empty additionalRepos to find a grandparent with repos (AC-004)", async () => {
      // Precedence for PLAN: [PLAN, GENERATE_PRD]
      // Feature self-lookup: 4 nulls
      // mid-prd walkPrecedence: PLAN/COMPLETED → null, PLAN/fallback → null,
      //   GeneratePrd/COMPLETED → loop with empty repos (skipped),
      //   GeneratePrd/fallback → null
      // grandparent walkPrecedence: PLAN tiers: 2 nulls, GeneratePrd/COMPLETED → PEERS
      const { findFirst, artifactLinkFindFirst } = stageFindFirstSequence(
        [
          null,
          null,
          null,
          null, // feature self-lookup: 4 nulls
          null,
          null, // mid-prd: PLAN tier (COMPLETED + fallback)
          {
            id: "mid-prd-loop",
            command: LoopCommand.GeneratePrd,
            additionalRepos: [],
          }, // GeneratePrd COMPLETED but empty
          null, // mid-prd: GeneratePrd fallback
          null,
          null, // grandparent: PLAN tier
          {
            id: "grand-prd-loop",
            command: LoopCommand.GeneratePrd,
            additionalRepos: PEERS,
          }, // grandparent GeneratePrd COMPLETED
        ],
        [
          { sourceId: "mid-prd-id" }, // feature's parent is mid-prd
          { sourceId: "grand-prd-id" }, // mid-prd's parent is grand-prd
        ]
      );

      const result = await loopsService.findInheritedAdditionalRepos(
        "feature-id",
        "org-1",
        LoopCommand.Plan
      );

      expect(result.additionalRepos).toEqual(PEERS);
      expect(result.source?.loopId).toBe("grand-prd-loop");
      expect(result.source?.artifactId).toBe("grand-prd-id");
      expect(artifactLinkFindFirst).toHaveBeenCalledTimes(2);
      // Verify the findFirst calls queried both ancestor IDs
      const queriedArtifactIds = findFirst.mock.calls.map(
        (call) => call[0].where.artifactId
      );
      expect(queriedArtifactIds).toContain("mid-prd-id");
      expect(queriedArtifactIds).toContain("grand-prd-id");
    });

    /**
     * AC-007: Cycle guard — A -> B -> A produces a cycle; lookup must terminate
     * without hanging or throwing.
     */
    it("terminates cleanly when PRODUCES links form a cycle (AC-007)", async () => {
      // Self-lookup for A: 4 nulls (walkPrecedence on A).
      // Ancestor walk from A: artifactLink → B; B is not in visited, so
      // walkPrecedence(B): 4 nulls. Then recurse into walkAncestors(B):
      // artifactLink → A; the cycle guard sees A in visited and returns null
      // BEFORE walkPrecedence(A) runs. Total: 8 loop.findFirst calls.
      const { findFirst, artifactLinkFindFirst } = stageFindFirstSequence(
        [null, null, null, null, null, null, null, null], // 4 for A self + 4 for B
        [
          { sourceId: "artifact-b" }, // A's parent is B
          { sourceId: "artifact-a" }, // B's parent is A (cycle)
        ]
      );

      const result = await loopsService.findInheritedAdditionalRepos(
        "artifact-a",
        "org-1",
        LoopCommand.Plan
      );

      expect(result).toEqual({ additionalRepos: [], source: null });
      // Lock in the exact call count so a regression in the cycle guard
      // (e.g. a redundant walkPrecedence on A's second visit) is caught.
      expect(findFirst).toHaveBeenCalledTimes(8);
      // The cycle must not cause a third artifactLink lookup (B's walk hits visited set)
      expect(artifactLinkFindFirst).toHaveBeenCalledTimes(2);
    });

    /**
     * AC-008: Max depth — walk stops at INHERITANCE_ANCESTOR_MAX_DEPTH = 3
     * even if more ancestors exist. No error is thrown.
     */
    it("stops at INHERITANCE_ANCESTOR_MAX_DEPTH and returns empty without throwing (AC-008)", async () => {
      // Depth calculation in walkAncestors: starts at depth=1, increments on each
      // recursive call. The guard is `depth > INHERITANCE_ANCESTOR_MAX_DEPTH (3)`.
      // So the walk executes at depth 1, 2, 3; depth 4 is blocked.
      //
      // Self-lookup: 4 nulls
      // depth=1 ancestor (ancestor-1): 4 nulls for walkPrecedence, then link to ancestor-2
      // depth=2 ancestor (ancestor-2): 4 nulls for walkPrecedence, then link to ancestor-3
      // depth=3 ancestor (ancestor-3): 4 nulls for walkPrecedence, then link to ancestor-4
      // depth=4: blocked by max-depth guard → returns null
      const { findFirst, artifactLinkFindFirst } = stageFindFirstSequence(
        [
          null,
          null,
          null,
          null, // self
          null,
          null,
          null,
          null, // depth-1 ancestor
          null,
          null,
          null,
          null, // depth-2 ancestor
          null,
          null,
          null,
          null, // depth-3 ancestor
        ],
        [
          { sourceId: "ancestor-1" },
          { sourceId: "ancestor-2" },
          { sourceId: "ancestor-3" },
          { sourceId: "ancestor-4" }, // would be depth-4, but guard fires before this
        ]
      );

      const result = await loopsService.findInheritedAdditionalRepos(
        "root-id",
        "org-1",
        LoopCommand.Plan
      );

      expect(result).toEqual({ additionalRepos: [], source: null });
      // loop.findFirst: 4 × 4 = 16 calls (self + 3 ancestors)
      expect(findFirst).toHaveBeenCalledTimes(16);
      // artifactLink.findFirst: 3 calls (at depth 1, 2, 3; depth-4 guard fires before the 4th link query)
      expect(artifactLinkFindFirst).toHaveBeenCalledTimes(3);
    });

    /**
     * AC-006: Self-lookup takes priority — a Feature with its own prior loop
     * must return that loop's repos without consulting ancestors.
     */
    it("returns self-lookup result without consulting ancestors when own loop has repos (AC-006)", async () => {
      // Feature has a COMPLETED PLAN loop with PEERS — self-lookup wins immediately.
      const { findFirst, artifactLinkFindFirst } = stageFindFirstSequence(
        [
          {
            id: "feature-own-loop",
            command: LoopCommand.Plan,
            additionalRepos: PEERS,
          },
        ],
        [] // no PRODUCES links staged — should never be reached
      );

      const result = await loopsService.findInheritedAdditionalRepos(
        "feature-id",
        "org-1",
        LoopCommand.Plan
      );

      expect(result).toEqual({
        additionalRepos: PEERS,
        source: {
          loopId: "feature-own-loop",
          command: LoopCommand.Plan,
          artifactId: "feature-id",
        },
      });
      // Self-lookup found a result in the first call — only one loop.findFirst call needed
      expect(findFirst).toHaveBeenCalledTimes(1);
      // Ancestor walk must never be reached
      expect(artifactLinkFindFirst).not.toHaveBeenCalled();
    });
  });
});
