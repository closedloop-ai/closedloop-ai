/**
 * ISS-12552: the SQL branch-lane classifier the bounded Related Sessions batch
 * read ranks with must agree with `branchLaneParticipationKind`, which the
 * single-artifact reads use, on every persisted link shape.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { generateSlug } from "@/app/documents/document-utils";
import { branchLaneParticipationSql } from "./link-participation-sql";
import {
  branchLaneParticipationKind,
  PARTICIPATION_TO_KIND,
} from "./provenance-eligibility";

const tracker = createCommittedTestOrganizationTracker();

const WROTE = BranchParticipationKind.Wrote;
const REVIEWED = BranchParticipationKind.Reviewed;
const PR = { repositoryFullName: "acme/app", prNumber: 7 };
const BRANCH = { linkKind: SessionArtifactLinkKind.SessionBranch };
const REVIEW_EVENT = { kind: BranchLifecycleBoundaryKind.ReviewFeedback };

/**
 * Each persisted shape, as the JSON text stored in `artifact_links.metadata`
 * (text, so a value like `7.0` reaches Postgres as written), and the
 * participation both classifiers must give it.
 */
const SHAPES: {
  label: string;
  column?: string;
  metadata: string | null;
  expected: BranchParticipationKind | null;
}[] = [
  { label: "column wrote", column: WROTE, metadata: "{}", expected: WROTE },
  {
    label: "column reviewed over scalar metadata",
    column: REVIEWED,
    metadata: '"text"',
    expected: REVIEWED,
  },
  {
    label: "unknown column falls to metadata",
    column: "bogus",
    metadata: json({ ...BRANCH, relation: ArtifactRefRelation.Output }),
    expected: WROTE,
  },
  {
    label: "legacy PR created",
    metadata: json({
      linkKind: SessionArtifactLinkKind.SessionPr,
      ...PR,
      relationTypes: [SessionPrRelationType.Created],
    }),
    expected: WROTE,
  },
  {
    label: "legacy PR number written as 7.0",
    metadata: `{"linkKind":"${SessionArtifactLinkKind.SessionPr}","repositoryFullName":"acme/app","prNumber":7.0,"relationTypes":["${SessionPrRelationType.Created}"]}`,
    expected: WROTE,
  },
  {
    label: "legacy PR past the safe integer range",
    metadata: `{"linkKind":"${SessionArtifactLinkKind.SessionPr}","repositoryFullName":"acme/app","prNumber":9007199254740992,"relationTypes":["${SessionPrRelationType.Created}"]}`,
    expected: null,
  },
  {
    label: "legacy PR with a repository and no number",
    metadata: json({
      linkKind: SessionArtifactLinkKind.SessionPr,
      repositoryFullName: "acme/app",
      relationTypes: [SessionPrRelationType.Created],
    }),
    expected: null,
  },
  {
    label: "canonical PR set reviewed",
    metadata: json({
      linkKinds: [SessionArtifactLinkKind.SessionPrSet],
      prRefs: [{ ...PR, relationTypes: [SessionPrRelationType.Reviewed] }],
      relationTypes: [SessionPrRelationType.Reviewed],
    }),
    expected: REVIEWED,
  },
  {
    label: "canonical PR set with an invalid ref",
    metadata: json({
      prRefs: [{ ...PR, prNumber: 0, relationTypes: [] }],
      relationTypes: [SessionPrRelationType.Created],
    }),
    expected: null,
  },
  {
    label: "canonical PR ref without relation types",
    metadata: json({
      prRefs: [PR],
      relationTypes: [SessionPrRelationType.Created],
    }),
    expected: null,
  },
  {
    label: "canonical PR ref with an empty method",
    metadata: json({
      prRefs: [{ ...PR, relationTypes: [], method: "" }],
      relationTypes: [SessionPrRelationType.Created],
    }),
    expected: null,
  },
  {
    label: "empty PR refs without participation",
    metadata: json({ prRefs: [] }),
    expected: null,
  },
  {
    label: "empty PR refs with stated participation",
    metadata: json({ prRefs: [], branchParticipation: REVIEWED }),
    expected: REVIEWED,
  },
  {
    label: "PR set kind without refs",
    metadata: json({
      linkKind: SessionArtifactLinkKind.SessionPr,
      linkKinds: [SessionArtifactLinkKind.SessionPrSet],
      relation: ArtifactRefRelation.Created,
    }),
    expected: null,
  },
  {
    label: "branch created",
    metadata: json({ ...BRANCH, relation: ArtifactRefRelation.Created }),
    expected: WROTE,
  },
  {
    label: "branch review feedback command",
    metadata: json({
      ...BRANCH,
      method: ArtifactRefMethod.PrReviewFeedbackCommand,
    }),
    expected: REVIEWED,
  },
  {
    label: "branch review feedback event",
    metadata: json({
      ...BRANCH,
      branchLifecycleEvents: [
        { ...REVIEW_EVENT, observedAt: "2026-10-01T00:00:00.000Z" },
      ],
    }),
    expected: REVIEWED,
  },
  {
    label: "branch event with an unreadable time",
    metadata: json({
      ...BRANCH,
      branchLifecycleEvents: [{ ...REVIEW_EVENT, observedAt: "not a date" }],
    }),
    expected: null,
  },
  {
    label: "branch event that is not an object",
    metadata: json({
      ...BRANCH,
      relation: ArtifactRefRelation.Output,
      branchLifecycleEvents: [5],
    }),
    expected: null,
  },
  {
    label: "branch among link kinds",
    metadata: json({
      linkKind: SessionArtifactLinkKind.SessionEvidence,
      linkKinds: [
        SessionArtifactLinkKind.SessionEvidence,
        SessionArtifactLinkKind.SessionBranch,
      ],
      relation: ArtifactRefRelation.Output,
    }),
    expected: null,
  },
  {
    label: "branch among link kinds without a link kind",
    metadata: json({
      linkKinds: [
        SessionArtifactLinkKind.SessionEvidence,
        SessionArtifactLinkKind.SessionBranch,
      ],
      relation: ArtifactRefRelation.Output,
    }),
    expected: WROTE,
  },
  {
    label: "link kinds with a non-string member",
    metadata: json({
      linkKinds: [5, SessionArtifactLinkKind.SessionBranch],
      relation: ArtifactRefRelation.Output,
    }),
    expected: null,
  },
  {
    label: "null link kind beside a branch link kind",
    metadata: json({
      linkKind: null,
      linkKinds: [SessionArtifactLinkKind.SessionBranch],
      relation: ArtifactRefRelation.Output,
    }),
    expected: null,
  },
  {
    label: "prose PR on a branch",
    metadata: json({
      linkKind: SessionArtifactLinkKind.SessionPrProse,
      linkKinds: [SessionArtifactLinkKind.SessionBranch],
      relationTypes: [SessionPrRelationType.Created],
    }),
    expected: WROTE,
  },
  {
    label: "branch stated participation in metadata",
    metadata: json({ ...BRANCH, branchParticipation: WROTE }),
    expected: WROTE,
  },
  {
    label: "branch relation types that are not an array",
    metadata: json({ ...BRANCH, relationTypes: SessionPrRelationType.Created }),
    expected: null,
  },
  {
    label: "branch confidence out of range",
    metadata: json({
      ...BRANCH,
      confidence: 2,
      relation: ArtifactRefRelation.Created,
    }),
    expected: null,
  },
  {
    label: "branch empty method",
    metadata: json({
      ...BRANCH,
      method: "",
      relation: ArtifactRefRelation.Created,
    }),
    expected: null,
  },
  {
    label: "branch passive workspace",
    metadata: json({ ...BRANCH, relation: ArtifactRefRelation.Workspace }),
    expected: null,
  },
  {
    label: "slug-lane output mention",
    metadata: json({ relation: "created", role: "output", method: "slug" }),
    expected: null,
  },
  {
    label: "evidence link",
    metadata: json({ linkKind: SessionArtifactLinkKind.SessionEvidence }),
    expected: null,
  },
  { label: "no metadata", metadata: null, expected: null },
  { label: "array metadata", metadata: "[]", expected: null },
];

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 branch-lane participation in SQL",
  () => {
    afterEach(() => tracker.cleanup());

    it("gives every persisted link shape the participation branchLaneParticipationKind gives it", async () => {
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
        await withDb(async (db) => {
          const link = await db.artifactLink.create({
            data: {
              organizationId,
              sourceId: sessionId,
              targetId: target.id,
              linkType: LinkType.RelatesTo,
              branchParticipation: shape.column ?? null,
            },
            select: { id: true },
          });
          await db.$executeRaw`
            UPDATE artifact_links SET metadata = ${shape.metadata}::jsonb
            WHERE id = ${link.id}::uuid
          `;
        });
      }

      const [sqlRows, links] = await withDb((db) =>
        Promise.all([
          db.$queryRaw<{ sourceId: string; participation: string | null }[]>`
            SELECT al.source_id AS "sourceId",
              ${branchLaneParticipationSql()} AS participation
            FROM artifact_links al
            WHERE al.target_id = ${target.id}::uuid
          `,
          db.artifactLink.findMany({
            where: { targetId: target.id },
            select: {
              sourceId: true,
              branchParticipation: true,
              metadata: true,
            },
          }),
        ])
      );

      const byLabel = (
        entries: [string, BranchParticipationKind | null][]
      ): Record<string, BranchParticipationKind | null> =>
        Object.fromEntries(
          entries.map(([sourceId, participation]) => [
            labelBySession.get(sourceId) ?? sourceId,
            participation,
          ])
        );
      const expected = Object.fromEntries(
        SHAPES.map((shape) => [shape.label, shape.expected])
      );
      expect(
        byLabel(
          sqlRows.map((row) => [
            row.sourceId,
            row.participation === WROTE || row.participation === REVIEWED
              ? row.participation
              : null,
          ])
        )
      ).toEqual(expected);
      const participationByKind = new Map(
        [WROTE, REVIEWED].map((participation) => [
          PARTICIPATION_TO_KIND[participation],
          participation,
        ])
      );
      expect(
        byLabel(
          links.map((link) => {
            const kind = branchLaneParticipationKind(link);
            return [
              link.sourceId,
              kind === undefined
                ? null
                : (participationByKind.get(kind) ?? null),
            ];
          })
        )
      ).toEqual(expected);
    });
  }
);

function json(value: unknown): string {
  return JSON.stringify(value);
}
