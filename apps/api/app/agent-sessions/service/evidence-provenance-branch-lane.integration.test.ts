/**
 * ISS-12552: the flag-on Related Sessions read filters links in SQL before
 * `branchLaneParticipationKind` reads them. The filter must keep every link
 * that classifier admits and drop the slug-lane mentions it never does.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { DocumentStatus } from "@repo/api/src/types/document";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-pr-link-metadata";
import {
  ArtifactSubtype,
  ArtifactType,
  type Prisma,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { generateSlug } from "@/app/documents/document-utils";
import { branchLaneLinkWhere } from "./evidence-provenance";
import { branchLaneParticipationKind } from "./provenance-eligibility";

const tracker = createCommittedTestOrganizationTracker();

const PR_REF = {
  repositoryFullName: "acme/app",
  prNumber: 7,
  relationTypes: ["created"],
};

/** Each persisted link shape, and whether the SQL filter keeps it. */
const SHAPES: {
  label: string;
  kept: boolean;
  branchParticipation?: string;
  metadata: Prisma.InputJsonValue;
}[] = [
  {
    label: "branch participation",
    kept: true,
    branchParticipation: BranchParticipationKind.Wrote,
    metadata: {},
  },
  {
    label: "legacy PR link",
    kept: true,
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      ...PR_REF,
    },
  },
  {
    label: "canonical PR refs",
    kept: true,
    metadata: {
      linkKinds: [SessionArtifactLinkKind.SessionPrSet],
      prRefs: [PR_REF],
    },
  },
  { label: "empty PR refs", kept: true, metadata: { prRefs: [] } },
  {
    label: "branch link",
    kept: true,
    metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
  },
  {
    label: "branch among link kinds",
    kept: true,
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionEvidence,
      linkKinds: [
        SessionArtifactLinkKind.SessionEvidence,
        SessionArtifactLinkKind.SessionBranch,
      ],
    },
  },
  {
    label: "slug-lane output mention",
    kept: false,
    metadata: { relation: "created", role: "output", method: "slug" },
  },
  {
    label: "evidence link",
    kept: false,
    metadata: { linkKind: SessionArtifactLinkKind.SessionEvidence },
  },
];

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 branch-lane link filter",
  () => {
    afterEach(async () => {
      await tracker.cleanup();
    });

    it("keeps every link the branch-lane classifier admits and drops slug-lane mentions", async () => {
      const organizationId = await tracker.create();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);
      const target = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Plan",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId,
            createdById: user.id,
            projectId,
          },
          select: { id: true },
        })
      );
      const labelBySession = new Map<string, string>();
      for (const shape of SHAPES) {
        const sessionId = await createTestSessionDetail({
          organizationId,
          userId: user.id,
          label: shape.label,
        });
        labelBySession.set(sessionId, shape.label);
        await withDb((db) =>
          db.artifactLink.create({
            data: {
              organizationId,
              sourceId: sessionId,
              targetId: target.id,
              linkType: LinkType.RelatesTo,
              branchParticipation: shape.branchParticipation ?? null,
              metadata: shape.metadata,
            },
          })
        );
      }

      const [kept, all] = await Promise.all(
        [
          { AND: [{ targetId: target.id }, branchLaneLinkWhere()] },
          { targetId: target.id },
        ].map((where) =>
          withDb((db) =>
            db.artifactLink.findMany({
              where,
              select: {
                sourceId: true,
                branchParticipation: true,
                metadata: true,
              },
            })
          )
        )
      );

      const keptLabels = kept.map((link) => labelBySession.get(link.sourceId));
      expect(new Set(keptLabels)).toEqual(
        new Set(
          SHAPES.filter((shape) => shape.kept).map((shape) => shape.label)
        )
      );
      const admitted = (all ?? []).filter(
        (link) => branchLaneParticipationKind(link) !== undefined
      );
      expect(admitted.length).toBeGreaterThan(0);
      for (const link of admitted) {
        expect(keptLabels).toContain(labelBySession.get(link.sourceId));
      }
    });
  }
);
