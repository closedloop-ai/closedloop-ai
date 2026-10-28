import { describe, expect, it } from "vitest";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  isValidPullRequestNumber,
  PR_INT_MAX,
  parsePullRequestNumber,
  SessionPrRelationType,
  syncedArtifactRefSchema,
  syncedSessionPrRefSchema,
} from "./session-artifact-link.js";

describe("pull request number bounds (ISS-8338)", () => {
  it("accepts the Prisma Int maximum as a pull-request identity", () => {
    expect(
      syncedArtifactRefSchema.safeParse(artifactRef(PR_INT_MAX)).success
    ).toBe(true);
    expect(
      syncedSessionPrRefSchema.safeParse(sessionPrRef(PR_INT_MAX)).success
    ).toBe(true);
    expect(isValidPullRequestNumber(PR_INT_MAX)).toBe(true);
  });

  it("rejects pull-request identities outside the Prisma Int domain", () => {
    expect(
      syncedArtifactRefSchema.safeParse(artifactRef(PR_INT_MAX + 1)).success
    ).toBe(false);
    expect(
      syncedSessionPrRefSchema.safeParse(sessionPrRef(PR_INT_MAX + 1)).success
    ).toBe(false);
    expect(isValidPullRequestNumber(PR_INT_MAX + 1)).toBe(false);
    expect(isValidPullRequestNumber(42.5)).toBe(false);
    expect(isValidPullRequestNumber(0)).toBe(false);
    expect(parsePullRequestNumber(String(PR_INT_MAX))).toBe(PR_INT_MAX);
    expect(parsePullRequestNumber("42.5")).toBeNull();
    expect(parsePullRequestNumber("0x2a")).toBeNull();
  });
});

function artifactRef(prNumber: number) {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: "closedloop-ai/closedloop-ai",
    prNumber,
    method: ArtifactRefMethod.HarnessPrLink,
    relation: ArtifactRefRelation.Referenced,
  };
}

function sessionPrRef(prNumber: number) {
  return {
    repositoryFullName: "closedloop-ai/closedloop-ai",
    prNumber,
    relationType: SessionPrRelationType.Referenced,
  };
}
