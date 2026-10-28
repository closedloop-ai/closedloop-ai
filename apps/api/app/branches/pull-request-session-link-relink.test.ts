import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { relinkPullRequestSessionLinksInTransaction } from "./pull-request-session-link-relink";

const ORGANIZATION_ID = "019ff900-2000-7000-8000-000000000001";
const SESSION_ID = "019ff900-2000-7000-8000-000000000002";
const SOURCE_BRANCH_ID = "019ff900-2000-7000-8000-000000000003";
const TARGET_BRANCH_ID = "019ff900-2000-7000-8000-000000000004";

describe("pull request Session-link relink", () => {
  it("locks, re-reads, and unions target-side relation types", async () => {
    const links = [
      {
        id: "source-link",
        sourceId: SESSION_ID,
        targetId: SOURCE_BRANCH_ID,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPr],
          relationTypes: [SessionPrRelationType.Reviewed],
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 6980,
        },
      },
      {
        id: "target-link",
        sourceId: SESSION_ID,
        targetId: TARGET_BRANCH_ID,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPr],
          relationTypes: [SessionPrRelationType.Referenced],
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

    expect(tx.artifactLink.findMany).toHaveBeenCalledTimes(2);
    // ISS-11608: the provider lock plus one Session-link lock; the two per-edge
    // locks (source and target Branch) that made this 4 are gone.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.artifactLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          metadata: expect.objectContaining({
            relationTypes: [
              SessionPrRelationType.Referenced,
              SessionPrRelationType.Reviewed,
            ],
          }),
        },
      })
    );
    expect(tx.artifactLink.delete).toHaveBeenCalledWith({
      where: { id: "source-link" },
    });
  });

  it("moves one identity out of a multi-PR source without losing siblings", async () => {
    const sourceMetadata = {
      linkKind: SessionArtifactLinkKind.SessionBranch,
      linkKinds: [
        SessionArtifactLinkKind.SessionBranch,
        SessionArtifactLinkKind.SessionPrSet,
      ],
      relationTypes: [
        SessionPrRelationType.Referenced,
        SessionPrRelationType.Reviewed,
      ],
      prRefs: [
        {
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 6979,
          relationTypes: [SessionPrRelationType.Referenced],
        },
        {
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 6980,
          relationTypes: [SessionPrRelationType.Reviewed],
        },
      ],
    };
    const targetMetadata = {
      linkKind: SessionArtifactLinkKind.SessionPr,
      linkKinds: [SessionArtifactLinkKind.SessionPr],
      relationTypes: [SessionPrRelationType.Created],
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber: 7000,
      prRefs: [
        {
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 7000,
          relationTypes: [SessionPrRelationType.Created],
        },
      ],
    };
    const links = [
      {
        id: "source-set-link",
        sourceId: SESSION_ID,
        targetId: SOURCE_BRANCH_ID,
        metadata: sourceMetadata,
      },
      {
        id: "target-single-link",
        sourceId: SESSION_ID,
        targetId: TARGET_BRANCH_ID,
        metadata: targetMetadata,
      },
    ];
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      artifactLink: {
        findMany: vi.fn().mockResolvedValue(links),
        upsert: vi.fn().mockResolvedValue({ id: "target-single-link" }),
        delete: vi.fn(),
        update: vi.fn().mockResolvedValue({ id: "source-set-link" }),
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
            linkKind: SessionArtifactLinkKind.SessionBranch,
            linkKinds: [
              SessionArtifactLinkKind.SessionBranch,
              SessionArtifactLinkKind.SessionPrSet,
            ],
            prRefs: [
              {
                repositoryFullName: "closedloop-ai/closedloop-ai",
                prNumber: 6980,
                relationTypes: [SessionPrRelationType.Reviewed],
              },
              {
                repositoryFullName: "closedloop-ai/closedloop-ai",
                prNumber: 7000,
                relationTypes: [SessionPrRelationType.Created],
              },
            ],
          }),
        },
      })
    );
    expect(tx.artifactLink.update).toHaveBeenCalledWith({
      where: { id: "source-set-link" },
      data: {
        metadata: expect.objectContaining({
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPr],
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 6979,
          prRefs: [
            {
              repositoryFullName: "closedloop-ai/closedloop-ai",
              prNumber: 6979,
              relationTypes: [SessionPrRelationType.Referenced],
            },
          ],
        }),
      },
      select: { id: true },
    });
    expect(tx.artifactLink.delete).not.toHaveBeenCalled();
  });

  it("keeps a prose-only mention prose after a relink (ISS-5823)", async () => {
    // Review cid 3839477585 / codex P1. A relink MOVES a link between branch
    // artifacts; it is not new evidence about how the reference was found. Two
    // separate defects promoted it anyway, and either alone is enough:
    // `normalizePrRef` dropped `method` (a method-less ref reads as a
    // pre-ISS-5823 row, therefore command-derived), and the kind was stamped
    // `session_pr` unconditionally. A prose mention then bought its way into
    // the metric readers and the GitHub-write authorization probe, which is
    // exactly the gate this ticket installs.
    const links = [
      {
        id: "source-link",
        sourceId: SESSION_ID,
        targetId: SOURCE_BRANCH_ID,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPrProse,
          linkKinds: [SessionArtifactLinkKind.SessionPrProse],
          relationTypes: [SessionPrRelationType.Referenced],
          prRefs: [
            {
              repositoryFullName: "closedloop-ai/closedloop-ai",
              prNumber: 6980,
              relationTypes: [SessionPrRelationType.Referenced],
              method: ArtifactRefMethod.PrMentionInProse,
            },
          ],
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

    const written = tx.artifactLink.upsert.mock.calls[0]?.[0] as {
      create: { metadata: Record<string, unknown> };
    };
    // Provenance survives the move...
    expect(written.create.metadata.prRefs).toEqual([
      expect.objectContaining({ method: ArtifactRefMethod.PrMentionInProse }),
    ]);
    // ...and the tier stays weak, on BOTH the scalar and the set. Asserting only
    // one would stay green while the other promoted the link, and the metric
    // predicate reads both.
    expect(written.create.metadata.linkKind).toBe(
      SessionArtifactLinkKind.SessionPrProse
    );
    expect(written.create.metadata.linkKinds).toEqual([
      SessionArtifactLinkKind.SessionPrProse,
    ]);
  });
});
