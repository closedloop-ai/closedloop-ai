/**
 * FEA-3951 org-scoping regression for the attach mechanism.
 *
 * Attaching an evergreen Document to a FEAT/PRD as context creates an
 * ArtifactLink via `artifactLinksService.createLink`. That write MUST be
 * org-scoped on BOTH endpoints: a caller in org-A must not be able to link an
 * artifact that lives in org-B (neither as the source doc nor the target FEAT).
 *
 * `createLink` enforces this by asserting each endpoint exists within the
 * caller's org before inserting. This test drives the real service with a
 * mocked DB that models per-org visibility and asserts the two-org isolation
 * behaviorally (the write throws and no row is created when an endpoint is
 * foreign).
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  linkCreate: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: { DbNull: Symbol("DbNull") },
}));

import { artifactLinksService } from "../service";

const RE_NOT_IN_ORG = /not found in organization/;
const ORG_A = "org-a";
const ORG_B = "org-b";
const DOC_IN_A = "doc-a";
const FEAT_IN_A = "feat-a";
const DOC_IN_B = "doc-b";

/**
 * Model per-org artifact visibility: `artifact.findFirst({ where: { id,
 * organizationId } })` returns the row only when the id belongs to that org.
 */
const ARTIFACT_ORG: Record<string, string> = {
  [DOC_IN_A]: ORG_A,
  [FEAT_IN_A]: ORG_A,
  [DOC_IN_B]: ORG_B,
};

describe("artifactLinksService.createLink — two-org isolation (FEA-3951)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.artifactFindFirst.mockImplementation(
      ({ where }: { where: { id: string; organizationId: string } }) => {
        const owner = ARTIFACT_ORG[where.id];
        return Promise.resolve(
          owner === where.organizationId ? { id: where.id } : null
        );
      }
    );
    mocks.linkCreate.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: "link-1",
          metadata: null,
          createdAt: new Date(),
          ...data,
        })
    );

    const db = {
      artifact: { findFirst: mocks.artifactFindFirst },
      artifactLink: { create: mocks.linkCreate },
    };
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );
  });

  it("creates the link when both endpoints belong to the caller's org", async () => {
    const link = await artifactLinksService.createLink(ORG_A, {
      sourceId: DOC_IN_A,
      targetId: FEAT_IN_A,
      linkType: LinkType.RelatesTo,
    });

    expect(link.sourceId).toBe(DOC_IN_A);
    expect(link.targetId).toBe(FEAT_IN_A);
    expect(link.linkType).toBe(LinkType.RelatesTo);
    expect(mocks.linkCreate).toHaveBeenCalledTimes(1);
    expect(mocks.linkCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: ORG_A }),
      })
    );
  });

  it("rejects linking a source Document that lives in another org", async () => {
    await expect(
      artifactLinksService.createLink(ORG_A, {
        sourceId: DOC_IN_B,
        targetId: FEAT_IN_A,
        linkType: LinkType.RelatesTo,
      })
    ).rejects.toThrow(RE_NOT_IN_ORG);

    // No cross-org row is ever written.
    expect(mocks.linkCreate).not.toHaveBeenCalled();
  });

  it("rejects linking to a target FEAT that lives in another org", async () => {
    // org-B caller trying to attach its DOC to org-A's FEAT.
    await expect(
      artifactLinksService.createLink(ORG_B, {
        sourceId: DOC_IN_B,
        targetId: FEAT_IN_A,
        linkType: LinkType.RelatesTo,
      })
    ).rejects.toThrow(RE_NOT_IN_ORG);

    expect(mocks.linkCreate).not.toHaveBeenCalled();
  });
});
