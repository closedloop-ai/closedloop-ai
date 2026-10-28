/**
 * ISS-11280: `ensureBranchArtifactRow` (singular) and
 * `materializeSessionBranchAggregate` are only ever called by the branch
 * materialization retry drain (a different lane's file), so none of the
 * sibling `branch-links*.test.ts` suites — which all drive the batch entry
 * point `persistSessionBranchArtifactLinks` — exercise them. These tests
 * call both functions directly against a small transaction double.
 */

import { ArtifactType, BranchPushSource } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { branchAuthorityMap } from "@/__tests__/support/agent-sessions/branch-links.test-harness";
import type { AgentSessionUpsertTx } from "@/app/agent-sessions/service/records";
import { CloudBranchNonMaterializationKind } from "@/app/branches/branch-write-eligibility";
import {
  BranchMaterializationStatus,
  ensureBranchArtifactRow,
  materializeSessionBranchAggregate,
} from "./branch-links";
import type { BranchRefAggregate } from "./branch-ref-aggregate";

const ORG = "org-1";
const REPO = "acme/web";
const BRANCH = "feat/x";
const SESSION_ARTIFACT_ID = "persisted-session-1";
const NEW_ARTIFACT_ID = "new-branch-artifact-1";
const EXISTING_ARTIFACT_ID = "existing-branch-artifact-1";
const OBSERVED_AT = "2026-05-20T17:03:00.000Z";
const INGEST_AT = "2026-05-02T00:00:00.000Z";

type MaterializeTxDouble = {
  tx: AgentSessionUpsertTx;
  branchDetailFindFirst: ReturnType<typeof vi.fn>;
  artifactCreate: ReturnType<typeof vi.fn>;
  branchDetailUpdateMany: ReturnType<typeof vi.fn>;
  artifactLinkFindFirst: ReturnType<typeof vi.fn>;
  artifactLinkUpsert: ReturnType<typeof vi.fn>;
  artifactUpdateMany: ReturnType<typeof vi.fn>;
};

function makeMaterializeTx(
  existingBranchArtifactId: string | null = null
): MaterializeTxDouble {
  const branchDetailFindFirst = vi
    .fn()
    .mockResolvedValue(
      existingBranchArtifactId ? { artifactId: existingBranchArtifactId } : null
    );
  const artifactCreate = vi.fn().mockResolvedValue({ id: NEW_ARTIFACT_ID });
  const branchDetailUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const artifactLinkFindFirst = vi.fn().mockResolvedValue(null);
  const artifactLinkUpsert = vi.fn().mockResolvedValue({ id: "link-1" });
  const artifactUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const executeRaw = vi.fn().mockResolvedValue(1);
  const tx = {
    $executeRaw: executeRaw,
    branchDetail: {
      findFirst: branchDetailFindFirst,
      updateMany: branchDetailUpdateMany,
    },
    artifact: { create: artifactCreate, updateMany: artifactUpdateMany },
    artifactLink: {
      findFirst: artifactLinkFindFirst,
      upsert: artifactLinkUpsert,
    },
  } as unknown as AgentSessionUpsertTx;
  return {
    tx,
    branchDetailFindFirst,
    artifactCreate,
    branchDetailUpdateMany,
    artifactLinkFindFirst,
    artifactLinkUpsert,
    artifactUpdateMany,
  };
}

function authorityFor(repo: string) {
  return branchAuthorityMap([repo]).get(repo);
}

describe("ensureBranchArtifactRow (singular)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns NotMaterialized without creating a row when createWhenAbsent is false", async () => {
    const d = makeMaterializeTx();

    const result = await ensureBranchArtifactRow(d.tx, {
      organizationId: ORG,
      projectId: null,
      repositoryAuthority: authorityFor(REPO),
      repositoryFullName: REPO,
      branchName: BRANCH,
      createWhenAbsent: false,
    });

    expect(result).toEqual({
      status: BranchMaterializationStatus.NotMaterialized,
      cause: CloudBranchNonMaterializationKind.NotPushed,
    });
    expect(d.artifactCreate).not.toHaveBeenCalled();
  });

  it("rejects a PR-head aggregate with no PR identity before touching the database", async () => {
    const d = makeMaterializeTx();
    const aggregate: BranchRefAggregate = {
      repositoryFullName: REPO,
      branchName: BRANCH,
      method: "pr_head_something",
      relation: ArtifactRefRelation.Created,
      branchLifecycleEvents: [],
      pullRequestObserved: true,
      branchRefObserved: false,
      // no prRefs -> missing PR identity
    };

    const result = await materializeSessionBranchAggregate(d.tx, {
      organizationId: ORG,
      projectId: null,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      aggregate,
      repositoryAuthority: authorityFor(REPO),
    });

    expect(result).toEqual({
      status: BranchMaterializationStatus.NotMaterialized,
      cause: CloudBranchNonMaterializationKind.IdentityMismatch,
    });
    // Rejected before any row lookup — proves the early return, not a lookup
    // that happened to come back empty.
    expect(d.branchDetailFindFirst).not.toHaveBeenCalled();
  });

  it("returns the ensure-row rejection unchanged and never persists a link", async () => {
    const d = makeMaterializeTx();
    const aggregate: BranchRefAggregate = {
      repositoryFullName: REPO,
      branchName: BRANCH,
      method: ArtifactRefMethod.GitCommand,
      relation: ArtifactRefRelation.Created,
      branchLifecycleEvents: [],
      pushObserved: true,
    };

    const result = await materializeSessionBranchAggregate(d.tx, {
      organizationId: ORG,
      projectId: null,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      aggregate,
      // No authority resolved for this repo -> ensureBranchArtifactRow rejects.
      repositoryAuthority: undefined,
    });

    expect(result).toEqual({
      status: BranchMaterializationStatus.NotMaterialized,
      cause: CloudBranchNonMaterializationKind.AuthorityUnavailable,
    });
    expect(d.artifactLinkUpsert).not.toHaveBeenCalled();
    expect(d.branchDetailUpdateMany).not.toHaveBeenCalled();
  });

  it("skips persisting and priority seeding when the branch is the session's own artifact", async () => {
    const d = makeMaterializeTx(SESSION_ARTIFACT_ID);
    const aggregate: BranchRefAggregate = {
      repositoryFullName: REPO,
      branchName: BRANCH,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
      branchLifecycleEvents: [],
      pushObserved: true,
      priority: Priority.High,
    };

    const result = await materializeSessionBranchAggregate(d.tx, {
      organizationId: ORG,
      projectId: null,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      aggregate,
      repositoryAuthority: authorityFor(REPO),
    });

    expect(result).toEqual({
      status: BranchMaterializationStatus.Materialized,
      artifactId: SESSION_ARTIFACT_ID,
    });
    expect(d.artifactLinkUpsert).not.toHaveBeenCalled();
    expect(d.artifactUpdateMany).not.toHaveBeenCalled();
  });

  it("seeds a freshly materialized branch's priority when the aggregate carries one", async () => {
    const d = makeMaterializeTx();
    const aggregate: BranchRefAggregate = {
      repositoryFullName: REPO,
      branchName: BRANCH,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
      branchLifecycleEvents: [],
      pushObserved: true,
      priority: Priority.Urgent,
    };

    const result = await materializeSessionBranchAggregate(d.tx, {
      organizationId: ORG,
      projectId: null,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      aggregate,
      repositoryAuthority: authorityFor(REPO),
    });

    expect(result).toEqual({
      status: BranchMaterializationStatus.Materialized,
      artifactId: NEW_ARTIFACT_ID,
    });
    expect(d.artifactUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: [NEW_ARTIFACT_ID] },
        organizationId: ORG,
        type: ArtifactType.Branch,
        priority: null,
      },
      data: { priority: Priority.Urgent },
    });
  });

  it("stamps firstPushedAt from the aggregate's own pushedAt timestamp", async () => {
    const d = makeMaterializeTx();
    const aggregate: BranchRefAggregate = {
      repositoryFullName: REPO,
      branchName: BRANCH,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
      branchLifecycleEvents: [],
      pushObserved: true,
      pushedAt: OBSERVED_AT,
    };

    await materializeSessionBranchAggregate(d.tx, {
      organizationId: ORG,
      projectId: null,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      aggregate,
      repositoryAuthority: authorityFor(REPO),
    });

    expect(d.branchDetailUpdateMany).toHaveBeenCalledWith({
      where: {
        artifactId: NEW_ARTIFACT_ID,
        OR: [
          { firstPushedAt: null },
          { firstPushedAt: { gt: new Date(OBSERVED_AT) } },
        ],
      },
      data: {
        firstPushedAt: new Date(OBSERVED_AT),
        pushSource: BranchPushSource.Session,
      },
    });
  });

  it("stamps the ingest instant as an upper bound for a timestamp-less push", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INGEST_AT));
    const d = makeMaterializeTx();
    const aggregate: BranchRefAggregate = {
      repositoryFullName: REPO,
      branchName: BRANCH,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
      branchLifecycleEvents: [],
      // Real push, but no observed timestamp (older Desktop build) and no
      // PR-head evidence — only `pushObserved` decides this branch.
      pushObserved: true,
    };

    await materializeSessionBranchAggregate(d.tx, {
      organizationId: ORG,
      projectId: null,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      aggregate,
      repositoryAuthority: authorityFor(REPO),
    });

    expect(d.branchDetailUpdateMany).toHaveBeenCalledWith({
      where: {
        artifactId: NEW_ARTIFACT_ID,
        OR: [
          { firstPushedAt: null },
          { firstPushedAt: { gt: new Date(INGEST_AT) } },
        ],
      },
      data: {
        firstPushedAt: new Date(INGEST_AT),
        pushSource: BranchPushSource.Session,
      },
    });
  });

  it("marks PR-head evidence when the aggregate never independently observed the branch ref", async () => {
    const d = makeMaterializeTx();
    const aggregate: BranchRefAggregate = {
      repositoryFullName: REPO,
      branchName: BRANCH,
      method: ArtifactRefMethod.PrCreateOutput,
      relation: ArtifactRefRelation.Created,
      branchLifecycleEvents: [],
      pullRequestObserved: true,
      branchRefObserved: false,
      prRefs: [
        {
          repositoryFullName: REPO,
          prNumber: 41,
          relationTypes: [SessionPrRelationType.Created],
        },
      ],
    };

    await materializeSessionBranchAggregate(d.tx, {
      organizationId: ORG,
      projectId: null,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      aggregate,
      repositoryAuthority: authorityFor(REPO),
    });

    expect(d.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    const writeData = d.artifactLinkUpsert.mock.calls[0][0];
    expect(writeData.create).toMatchObject({
      organizationId: ORG,
      sourceId: SESSION_ARTIFACT_ID,
      targetId: NEW_ARTIFACT_ID,
    });
    // PullRequestHead evidence never claims `branchLinked` — that marker is
    // reserved for INDEPENDENT branch evidence (SessionBranchLinkEvidenceSource).
    expect(writeData.create.metadata.branchLinked).toBeUndefined();
    expect(writeData.create.metadata.prRefs).toContainEqual(
      expect.objectContaining({ prNumber: 41 })
    );
  });

  it("does not stamp firstPushedAt when the aggregate carries no push evidence at all", async () => {
    // An existing branch artifact bypasses the createWhenAbsent gate, so the
    // aggregate reaches persistMaterializedSessionBranchAggregate even though
    // it carries no push evidence of its own (createWhenAbsent would be
    // false for it and a fresh row would never materialize).
    const d = makeMaterializeTx(EXISTING_ARTIFACT_ID);
    const aggregate: BranchRefAggregate = {
      repositoryFullName: REPO,
      branchName: BRANCH,
      method: "git_commit",
      relation: ArtifactRefRelation.Created,
      branchLifecycleEvents: [],
      // No pushedAt, no PR-head push evidence, and pushObserved absent — none
      // of the three push-evidence branches should fire.
    };

    await materializeSessionBranchAggregate(d.tx, {
      organizationId: ORG,
      projectId: null,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      aggregate,
      repositoryAuthority: authorityFor(REPO),
    });

    expect(d.branchDetailUpdateMany).not.toHaveBeenCalled();
  });
});
