import { describe, expect, it, vi } from "vitest";
import {
  asRetryTx,
  type SqlLike,
} from "@/__tests__/support/agent-sessions/service/artifact-links/branch-materialization-retry.test-helpers";
import { CloudBranchNonMaterializationKind } from "@/app/branches/branch-write-eligibility";
import {
  type BranchMaterializationRetryClaim,
  type BranchMaterializationRetryFence,
  BranchMaterializationRetryState,
  claimDueBranchMaterializationRetries,
  rescheduleBranchMaterializationRetry,
  revalidateCurrentBranchMaterializationRetryClaim,
  settleSuccessfulBranchMaterializationRetry,
  settleTerminalBranchMaterializationRetry,
  terminalReasonFromBranchMaterializationCause,
} from "./branch-materialization-retry";
import { BranchMaterializationRetryTerminalReason } from "./branch-materialization-retry-monitor";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

const FENCE: BranchMaterializationRetryFence = {
  id: "retry-1",
  organizationId: "org-1",
  claimGeneration: 3,
};

const CLAIM: BranchMaterializationRetryClaim = {
  id: "retry-1",
  organizationId: "org-1",
  sourceArtifactId: "session-1",
  repositoryFullName: "acme/web",
  branchName: "feat/x",
  branchRef: null,
  attempts: 1,
  claimGeneration: 7,
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  projectId: "project-1",
  validationReason: null,
};

const NOW = new Date("2026-08-25T13:00:00.000Z");

type SettleCase = [string, (tx: unknown) => Promise<"settled" | "stale_claim">];

const settleCases: SettleCase[] = [
  [
    "settleSuccessfulBranchMaterializationRetry",
    (tx) => settleSuccessfulBranchMaterializationRetry(asRetryTx(tx), FENCE),
  ],
  [
    "rescheduleBranchMaterializationRetry",
    (tx) =>
      rescheduleBranchMaterializationRetry(
        asRetryTx(tx),
        FENCE,
        new Date("2026-08-25T13:05:00.000Z"),
        NOW
      ),
  ],
  [
    "settleTerminalBranchMaterializationRetry",
    (tx) =>
      settleTerminalBranchMaterializationRetry(
        asRetryTx(tx),
        FENCE,
        BranchMaterializationRetryState.Terminal,
        BranchMaterializationRetryTerminalReason.CorruptState,
        NOW
      ),
  ],
];

describe("Branch materialization retry claim fences", () => {
  describe.each(settleCases)("%s", (_name, call) => {
    it("binds the fence's claim generation into the write predicate", async () => {
      const tx = { $executeRaw: vi.fn().mockResolvedValue(1) };

      await call(tx);

      const write = tx.$executeRaw.mock.calls[0][0] as SqlLike;
      expect(valueBoundTo(write, "claim_generation")).toBe(
        FENCE.claimGeneration
      );
    });

    it("reports settled when exactly one row is affected", async () => {
      const tx = { $executeRaw: vi.fn().mockResolvedValue(1) };

      const result = await call(tx);

      expect(result).toBe("settled");
    });

    it.each([0, 2])(
      "reports a stale claim when the affected-row count is %i",
      async (count) => {
        const tx = { $executeRaw: vi.fn().mockResolvedValue(count) };

        const result = await call(tx);

        expect(result).toBe("stale_claim");
      }
    );
  });

  it("reports a stale claim when the row backing a revalidation is gone", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };

    const result = await revalidateCurrentBranchMaterializationRetryClaim(
      asRetryTx(tx),
      CLAIM
    );

    expect(result).toEqual({ status: "stale_claim" });
  });

  it("reports terminal with the stored reason when revalidation finds a corrupt claim", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          validationReason:
            BranchMaterializationRetryTerminalReason.CrossOrganization,
          branchRef: null,
          projectId: null,
        },
      ]),
    };

    const result = await revalidateCurrentBranchMaterializationRetryClaim(
      asRetryTx(tx),
      CLAIM
    );

    expect(result).toEqual({
      status: "terminal",
      reason: BranchMaterializationRetryTerminalReason.CrossOrganization,
    });
  });

  it("omits the organization exclusion clause when claiming with no options", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };

    await claimDueBranchMaterializationRetries(asRetryTx(tx), NOW, 5);

    const query = tx.$queryRaw.mock.calls[0][0] as SqlLike;
    expect(query.sql).not.toContain("NOT IN");
  });

  it("excludes every listed organization from the claim candidate set", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };

    await claimDueBranchMaterializationRetries(asRetryTx(tx), NOW, 5, {
      excludedOrganizationIds: ["org-2", "org-3"],
    });

    const query = tx.$queryRaw.mock.calls[0][0] as SqlLike;
    expect(query.sql).toContain("NOT IN");
    expect(query.values).toEqual(expect.arrayContaining(["org-2", "org-3"]));
  });

  it.each([
    [
      CloudBranchNonMaterializationKind.ConflictingAuthority,
      BranchMaterializationRetryTerminalReason.ConflictingAuthority,
    ],
    [
      CloudBranchNonMaterializationKind.DefaultBranch,
      BranchMaterializationRetryTerminalReason.DefaultBranch,
    ],
    [
      CloudBranchNonMaterializationKind.IdentityMismatch,
      BranchMaterializationRetryTerminalReason.IdentityMismatch,
    ],
    // AuthorityUnavailable names no case in the mapper's if-chain, so it is the
    // one cause that falls through every named check to the CorruptState default.
    [
      CloudBranchNonMaterializationKind.AuthorityUnavailable,
      BranchMaterializationRetryTerminalReason.CorruptState,
    ],
  ])("maps %s to %s", (cause, expected) => {
    expect(terminalReasonFromBranchMaterializationCause(cause)).toBe(expected);
  });
});

/**
 * The bound value behind `<column> = ?` in a composed statement, or undefined
 * when the statement carries no such predicate.
 */
function valueBoundTo(query: SqlLike, column: string): unknown {
  const at = query.sql.indexOf(`${column} = ?`);
  if (at === -1) {
    return;
  }
  const placeholderIndex = query.sql.slice(0, at).split("?").length - 1;
  return query.values[placeholderIndex];
}
