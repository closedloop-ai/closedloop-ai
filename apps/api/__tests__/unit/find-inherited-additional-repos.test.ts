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

import { type Mock, vi } from "vitest";

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

import { LoopCommand } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it } from "vitest";
import { loopsService } from "@/app/loops/service";

const mockWithDb = withDb as unknown as Mock;

type FindFirstResult = {
  id: string;
  command: string;
  additionalRepos: unknown;
} | null;

/**
 * Stage a sequence of findFirst responses, one per call. Returns the spy so
 * tests can assert the where clauses each call received.
 */
function stageFindFirstSequence(results: FindFirstResult[]) {
  const findFirst = vi.fn();
  for (const result of results) {
    findFirst.mockResolvedValueOnce(result);
  }
  mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({ loop: { findFirst } })
  );
  return findFirst;
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
        source: { loopId: "plan-completed", command: LoopCommand.Plan },
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
      const findFirst = stageFindFirstSequence([null, null, null, null]);

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
        expect(statusJson).not.toContain("FAILED");
        expect(statusJson).not.toContain("PENDING");
        expect(statusJson).not.toContain("CLAIMED");
        expect(statusJson).not.toContain("RUNNING");
      }
    });

    it("stops querying as soon as a candidate with peers is found", async () => {
      const findFirst = stageFindFirstSequence([
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
      const findFirst = stageFindFirstSequence([
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
      });
      // First query is the PLAN tier; never reached EXECUTE.
      expect(findFirst.mock.calls[0][0].where.command).toBe(LoopCommand.Plan);
    });

    it("falls back to EXECUTE when no PLAN loop has peers", async () => {
      const findFirst = stageFindFirstSequence([
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
      const findFirst = stageFindFirstSequence([
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
      const findFirst = stageFindFirstSequence([null, null]);

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
      const findFirst = stageFindFirstSequence([
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
      const findFirst = stageFindFirstSequence([]);

      const result = await loopsService.findInheritedAdditionalRepos(
        "doc-1",
        "org-1",
        LoopCommand.Chat
      );

      expect(result).toEqual({ additionalRepos: [], source: null });
      expect(findFirst).not.toHaveBeenCalled();
    });

    it("returns empty without hitting the DB for evaluators", async () => {
      const findFirst = stageFindFirstSequence([]);

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
});
