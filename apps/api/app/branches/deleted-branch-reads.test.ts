import { ArtifactType } from "@repo/api/src/types/artifact";
import { describe, expect, it, vi } from "vitest";
import { renderSql } from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { directParticipationService } from "../artifacts/collaborators/direct-participation-service";
import { collaboratorReadFitsBudget } from "../artifacts/collaborators/read-budget";
import { readBatchSessionLinkEvidence } from "./branch-read-service/batch-session-link-evidence";
import { readPushContributionWindow } from "./branch-read-service/contributor-source-windows";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const BRANCH_ID = "22222222-2222-4222-8222-222222222222";

/**
 * ISS-11589: a branch's deletion decides only whether it is active. Each read
 * below feeds a list row or a collaborator header, so a `b.deleted_at` filter
 * here would drop a deleted branch's owner, comments or collaborators while
 * the branch itself is listed.
 */
describe("Branch reads that must not filter on deleted_at", () => {
  it("reads owner and comment evidence for a deleted Branch", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);

    await readBatchSessionLinkEvidence(
      { $queryRaw: queryRaw },
      ORGANIZATION_ID,
      [BRANCH_ID],
      5
    );

    expect(queryRaw).toHaveBeenCalledTimes(2);
    for (const [query] of queryRaw.mock.calls) {
      expect(renderSql(query)).not.toContain("b.deleted_at");
    }
  });

  it("reads push-contribution windows for a deleted Branch", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);

    await readPushContributionWindow(
      { $queryRaw: queryRaw },
      { organizationId: ORGANIZATION_ID, branchIds: [BRANCH_ID], limit: 5 }
    );

    expect(queryRaw).toHaveBeenCalledTimes(2);
    for (const [query] of queryRaw.mock.calls) {
      expect(renderSql(query)).not.toContain("b.deleted_at");
    }
  });

  it("counts a deleted Branch toward the collaborator read budget", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ candidateCount: 1 }]);

    await collaboratorReadFitsBudget(
      { $queryRaw: queryRaw } as never,
      ORGANIZATION_ID,
      {
        artifactType: ArtifactType.Branch,
        artifactIds: [BRANCH_ID],
      }
    );

    expect(renderSql(queryRaw.mock.calls[0]?.[0])).not.toContain(
      "b.deleted_at"
    );
  });

  it("reads direct participation for a deleted Branch", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);

    await directParticipationService.read(
      { $queryRaw: queryRaw },
      ORGANIZATION_ID,
      ArtifactType.Branch,
      [BRANCH_ID]
    );

    expect(queryRaw).toHaveBeenCalledOnce();
    // `readBatch`'s Branch arm drops any entry this read omits, so screening
    // here takes the row's whole collaborator set with it.
    expect(renderSql(queryRaw.mock.calls[0]?.[0])).not.toContain(
      "b.deleted_at"
    );
  });
});
