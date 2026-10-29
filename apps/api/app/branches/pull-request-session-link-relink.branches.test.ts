import { LinkType } from "@repo/api/src/types/artifact";
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { relinkPullRequestSessionLinksInTransaction } from "./pull-request-session-link-relink";

const ORGANIZATION_ID = "019ff900-2000-7000-8000-000000000001";
const SESSION_ID = "019ff900-2000-7000-8000-000000000002";
const SOURCE_BRANCH_ID = "019ff900-2000-7000-8000-000000000003";
const TARGET_BRANCH_ID = "019ff900-2000-7000-8000-000000000004";

describe("relinkPullRequestSessionLinksInTransaction (branch pins)", () => {
  it("does nothing for a PR whose repository is unknown", async () => {
    const tx = {
      $executeRaw: vi.fn(),
      artifactLink: {
        findMany: vi.fn(),
        upsert: vi.fn(),
        delete: vi.fn(),
        update: vi.fn(),
      },
    };

    await expect(
      relinkPullRequestSessionLinksInTransaction(tx as never, {
        organizationId: ORGANIZATION_ID,
        pullRequestNumber: 6980,
        repositoryFullName: null,
        sourceBranchArtifactIds: [SOURCE_BRANCH_ID],
        targetBranchArtifactId: TARGET_BRANCH_ID,
      })
    ).resolves.toBe(false);

    expect(tx.artifactLink.findMany).not.toHaveBeenCalled();
  });

  it("is a no-op when a matching link is discovered but no longer matches once re-read under lock", async () => {
    // The discovery read (unlocked) sees a matching link; the second, re-read
    // is what the relink actually acts on. A link that stopped matching
    // between the two reads (e.g. concurrently edited) means there is
    // nothing left to move once the advisory lock is held.
    const discoveryLink = {
      id: "source-link",
      sourceId: SESSION_ID,
      targetId: SOURCE_BRANCH_ID,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [SessionArtifactLinkKind.SessionPr],
        relationTypes: [SessionPrRelationType.Referenced],
        repositoryFullName: "closedloop-ai/closedloop-ai",
        prNumber: 6980,
      },
    };
    const relinkedAwayLink = {
      ...discoveryLink,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [SessionArtifactLinkKind.SessionPr],
        relationTypes: [SessionPrRelationType.Referenced],
        repositoryFullName: "closedloop-ai/closedloop-ai",
        prNumber: 9999,
      },
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      artifactLink: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([discoveryLink])
          .mockResolvedValueOnce([relinkedAwayLink]),
        upsert: vi.fn(),
        delete: vi.fn(),
        update: vi.fn(),
      },
    };

    await expect(
      relinkPullRequestSessionLinksInTransaction(tx as never, {
        organizationId: ORGANIZATION_ID,
        pullRequestNumber: 6980,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        sourceBranchArtifactIds: [SOURCE_BRANCH_ID],
        targetBranchArtifactId: TARGET_BRANCH_ID,
      })
    ).resolves.toBe(false);

    expect(tx.artifactLink.findMany).toHaveBeenCalledTimes(2);
    expect(tx.artifactLink.upsert).not.toHaveBeenCalled();
  });

  it("excludes a link whose metadata cannot be parsed as a JSON object from discovery", async () => {
    const unparseable = {
      id: "garbage-link",
      sourceId: SESSION_ID,
      targetId: SOURCE_BRANCH_ID,
      metadata: "not-an-object",
    };
    const matching = {
      id: "source-link",
      sourceId: SESSION_ID,
      targetId: SOURCE_BRANCH_ID,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [SessionArtifactLinkKind.SessionPr],
        relationTypes: [SessionPrRelationType.Referenced],
        repositoryFullName: "closedloop-ai/closedloop-ai",
        prNumber: 6980,
      },
    };
    const target = {
      id: "target-link",
      sourceId: SESSION_ID,
      targetId: TARGET_BRANCH_ID,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [SessionArtifactLinkKind.SessionPr],
        relationTypes: [SessionPrRelationType.Created],
        repositoryFullName: "closedloop-ai/closedloop-ai",
        prNumber: 7000,
      },
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      artifactLink: {
        // Keyed on the `where` shape rather than call order: the discovery
        // read has no `sourceId` filter, the locked re-read does, and the two
        // must not be interchangeable.
        findMany: vi
          .fn()
          .mockImplementation((args: { where: unknown }) =>
            Promise.resolve(
              (args.where as { sourceId?: unknown }).sourceId === undefined
                ? [unparseable, matching, target]
                : [matching, target]
            )
          ),
        upsert: vi.fn().mockResolvedValue({ id: "target-link" }),
        delete: vi.fn().mockResolvedValue({ id: "source-link" }),
        update: vi.fn(),
      },
    };

    await expect(
      relinkPullRequestSessionLinksInTransaction(tx as never, {
        organizationId: ORGANIZATION_ID,
        pullRequestNumber: 6980,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        sourceBranchArtifactIds: [SOURCE_BRANCH_ID],
        targetBranchArtifactId: TARGET_BRANCH_ID,
      })
    ).resolves.toBe(true);

    // Only the genuinely matching link is deleted; the unparseable one was
    // never a candidate and is left completely alone.
    expect(tx.artifactLink.delete).toHaveBeenCalledTimes(1);
    expect(tx.artifactLink.delete).toHaveBeenCalledWith({
      where: { id: "source-link" },
    });
    expect(tx.artifactLink.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: ORGANIZATION_ID,
        linkType: LinkType.RelatesTo,
        targetId: { in: [SOURCE_BRANCH_ID, TARGET_BRANCH_ID] },
      },
      select: { id: true, sourceId: true, targetId: true, metadata: true },
    });
    expect(tx.artifactLink.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        organizationId: ORGANIZATION_ID,
        linkType: LinkType.RelatesTo,
        targetId: { in: [SOURCE_BRANCH_ID, TARGET_BRANCH_ID] },
        sourceId: { in: [SESSION_ID] },
      },
      select: { id: true, sourceId: true, targetId: true, metadata: true },
    });
  });

  it("restores SessionBranch on the source link when independent branch evidence survives full PR removal", async () => {
    const links = [
      {
        id: "source-link",
        sourceId: SESSION_ID,
        targetId: SOURCE_BRANCH_ID,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPr],
          relationTypes: [SessionPrRelationType.Referenced],
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 6980,
          branchLinked: true,
        },
      },
      {
        id: "target-link",
        sourceId: SESSION_ID,
        targetId: TARGET_BRANCH_ID,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPr],
          relationTypes: [SessionPrRelationType.Reviewed],
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 6980,
        },
      },
    ];
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      artifactLink: {
        findMany: vi.fn().mockResolvedValue(links),
        upsert: vi.fn().mockResolvedValue({ id: "target-link" }),
        delete: vi.fn(),
        update: vi.fn().mockResolvedValue({ id: "source-link" }),
      },
    };

    await expect(
      relinkPullRequestSessionLinksInTransaction(tx as never, {
        organizationId: ORGANIZATION_ID,
        pullRequestNumber: 6980,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        sourceBranchArtifactIds: [SOURCE_BRANCH_ID],
        targetBranchArtifactId: TARGET_BRANCH_ID,
      })
    ).resolves.toBe(true);

    // The PR contribution moved off this link entirely, but its own
    // `branchLinked` evidence means the link must not be deleted outright —
    // it degrades to a bare SessionBranch link instead.
    expect(tx.artifactLink.delete).not.toHaveBeenCalled();
    expect(tx.artifactLink.update).toHaveBeenCalledWith({
      where: { id: "source-link" },
      data: {
        metadata: expect.objectContaining({
          linkKind: SessionArtifactLinkKind.SessionBranch,
          linkKinds: [SessionArtifactLinkKind.SessionBranch],
        }),
      },
      select: { id: true },
    });
  });

  it("carries forward source/confidence/extractorVersion from the contributing source link", async () => {
    const links = [
      {
        id: "source-link",
        sourceId: SESSION_ID,
        targetId: SOURCE_BRANCH_ID,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPr],
          relationTypes: [SessionPrRelationType.Referenced],
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 6980,
          source: "extractor",
          confidence: 0.85,
          extractorVersion: "v3",
        },
      },
      {
        id: "target-link",
        sourceId: SESSION_ID,
        targetId: TARGET_BRANCH_ID,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPr],
          relationTypes: [SessionPrRelationType.Reviewed],
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 6980,
        },
      },
    ];
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      artifactLink: {
        findMany: vi.fn().mockResolvedValue(links),
        upsert: vi.fn().mockResolvedValue({ id: "target-link" }),
        delete: vi.fn().mockResolvedValue({ id: "source-link" }),
        update: vi.fn(),
      },
    };

    await expect(
      relinkPullRequestSessionLinksInTransaction(tx as never, {
        organizationId: ORGANIZATION_ID,
        pullRequestNumber: 6980,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        sourceBranchArtifactIds: [SOURCE_BRANCH_ID],
        targetBranchArtifactId: TARGET_BRANCH_ID,
      })
    ).resolves.toBe(true);

    expect(tx.artifactLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          metadata: expect.objectContaining({
            source: "extractor",
            confidence: 0.85,
            extractorVersion: "v3",
          }),
        },
      })
    );
  });

  it("carries forward merged branch-lifecycle events onto the surviving target link", async () => {
    const links = [
      {
        id: "source-link",
        sourceId: SESSION_ID,
        targetId: SOURCE_BRANCH_ID,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPr],
          relationTypes: [SessionPrRelationType.Referenced],
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 6980,
          branchLifecycleEvents: [
            { kind: BranchLifecycleBoundaryKind.PrRaised },
          ],
        },
      },
      {
        id: "target-link",
        sourceId: SESSION_ID,
        targetId: TARGET_BRANCH_ID,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPr],
          relationTypes: [SessionPrRelationType.Reviewed],
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 6980,
        },
      },
    ];
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      artifactLink: {
        findMany: vi.fn().mockResolvedValue(links),
        upsert: vi.fn().mockResolvedValue({ id: "target-link" }),
        delete: vi.fn().mockResolvedValue({ id: "source-link" }),
        update: vi.fn(),
      },
    };

    await expect(
      relinkPullRequestSessionLinksInTransaction(tx as never, {
        organizationId: ORGANIZATION_ID,
        pullRequestNumber: 6980,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        sourceBranchArtifactIds: [SOURCE_BRANCH_ID],
        targetBranchArtifactId: TARGET_BRANCH_ID,
      })
    ).resolves.toBe(true);

    expect(tx.artifactLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          metadata: expect.objectContaining({
            branchLifecycleEvents: [
              expect.objectContaining({
                kind: BranchLifecycleBoundaryKind.PrRaised,
              }),
            ],
          }),
        },
      })
    );
  });

  it("rejects a relink whose target link already carries an invalid canonical PR-set shape", async () => {
    const links = [
      {
        id: "source-link",
        sourceId: SESSION_ID,
        targetId: SOURCE_BRANCH_ID,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPr],
          relationTypes: [SessionPrRelationType.Referenced],
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 6980,
        },
      },
      {
        id: "target-link",
        sourceId: SESSION_ID,
        targetId: TARGET_BRANCH_ID,
        metadata: {
          // Claims the canonical multi-PR kind but carries no `prRefs` — an
          // invalid canonical shape `classifySessionPrMetadata` fails closed on.
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPrSet],
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 7000,
        },
      },
    ];
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      artifactLink: {
        findMany: vi.fn().mockResolvedValue(links),
        upsert: vi.fn(),
        delete: vi.fn(),
        update: vi.fn(),
      },
    };

    await expect(
      relinkPullRequestSessionLinksInTransaction(tx as never, {
        organizationId: ORGANIZATION_ID,
        pullRequestNumber: 6980,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        sourceBranchArtifactIds: [SOURCE_BRANCH_ID],
        targetBranchArtifactId: TARGET_BRANCH_ID,
      })
    ).rejects.toThrow("pull request branch relink Session link conflict");

    expect(tx.artifactLink.upsert).not.toHaveBeenCalled();
  });
});
