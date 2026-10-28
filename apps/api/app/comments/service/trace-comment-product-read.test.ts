/**
 * ISS-11190: `branch_detail.artifact_id` is `@db.Uuid`, and Postgres raises on
 * a non-UUID there rather than matching nothing. A desktop Branch id is an
 * `encodeBranchId` value, never a UUID, so the artifact-id probe must not run
 * for it. A mock that answered `null` to that probe would hide the raise; these
 * cases assert the probe is never issued instead.
 */
import { encodeBranchId } from "@repo/api/src/types/branch";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveProductBranchArtifactId } from "./trace-comment-product-read";

const ORGANIZATION_ID = "org-trace-1";
const BRANCH_ARTIFACT_ID = "0199d0f8-1d4a-7c3e-9b2a-5f6e7d8c9b0a";
const ENCODED_BRANCH_ID = encodeBranchId({
  repoFullName: "acme/trace-comments",
  branchName: "feat/iss-11190",
});

const findFirst = vi.fn();
const db = { branchDetail: { findFirst }, $queryRaw: vi.fn() } as never;

function probedArtifactIds(): unknown[] {
  return findFirst.mock.calls
    .map((call) => call[0].where.artifactId)
    .filter((value: unknown) => value !== undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveProductBranchArtifactId", () => {
  it("never probes the artifact id for an encoded Branch id", async () => {
    findFirst.mockResolvedValue({ artifactId: BRANCH_ARTIFACT_ID });

    const resolved = await resolveProductBranchArtifactId(db, {
      organizationId: ORGANIZATION_ID,
      targetId: ENCODED_BRANCH_ID,
    });

    expect(resolved).toBe(BRANCH_ARTIFACT_ID);
    expect(probedArtifactIds()).toEqual([]);
    expect(findFirst).toHaveBeenCalledOnce();
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      branchName: "feat/iss-11190",
      repository: { is: { fullName: "acme/trace-comments" } },
    });
  });

  it("probes the artifact id first for a UUID target and returns its hit", async () => {
    findFirst.mockResolvedValue({ artifactId: BRANCH_ARTIFACT_ID });

    const resolved = await resolveProductBranchArtifactId(db, {
      organizationId: ORGANIZATION_ID,
      targetId: BRANCH_ARTIFACT_ID,
    });

    expect(resolved).toBe(BRANCH_ARTIFACT_ID);
    expect(findFirst).toHaveBeenCalledOnce();
    expect(probedArtifactIds()).toEqual([BRANCH_ARTIFACT_ID]);
  });

  it("falls back to decodeBranchId when a UUID target misses the artifact id", async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ artifactId: "branch-by-name" });

    const resolved = await resolveProductBranchArtifactId(db, {
      organizationId: ORGANIZATION_ID,
      targetId: BRANCH_ARTIFACT_ID,
    });

    expect(resolved).toBe("branch-by-name");
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst.mock.calls[1][0].where).toMatchObject({
      branchName: BRANCH_ARTIFACT_ID,
    });
  });
});
