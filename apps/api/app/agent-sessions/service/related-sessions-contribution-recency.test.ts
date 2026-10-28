/**
 * ISS-7669: Related Sessions orders by the artifact's NEWEST contribution.
 *
 * `readSessionProvenanceEvidence` used to read `link.createdAt` for that, but
 * the slug-link lane is find-then-create-if-absent, so `createdAt` is pinned at
 * the sync that first created the edge and never moves. A session that created a
 * document at 09:00 and revised it at 17:00 therefore reported 09:00 — the type
 * name and the JSDoc said "newest contribution" while the data said "first
 * linked". These pin the read half of the fix: `lastContributedAt` when the row
 * has one, `createdAt` when it does not.
 *
 * The fake below projects EXACTLY the columns the production `select` names, the
 * same discipline the sibling `provenance-eligibility.test.ts` uses — so
 * forgetting to select `lastContributedAt` in production drops it from the row
 * here and these cases go red, rather than silently passing on a column Prisma
 * would never have returned.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import {
  ProvenanceRelationshipKind,
  RELATED_SESSION_ELIGIBLE_KINDS,
} from "@repo/api/src/types/provenance-relationship";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSessionProvenanceEvidence,
  selectLatestEligibleContributions,
} from "./provenance-eligibility";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

const ORG = "org-1";
const ARTIFACT = "artifact-doc-1";
const SESSION_REVISED = "session-revised";
const SESSION_LEGACY = "session-legacy";

/** 09:00 — when the session first referenced the document. */
const FIRST_LINKED = new Date("2026-08-22T09:00:00.000Z");
/** 17:00 — when a later sync saw it restate that reference. */
const REVISED = new Date("2026-08-22T17:00:00.000Z");

type LinkRow = {
  sourceId: string;
  linkType: string;
  branchParticipation: string | null;
  metadata: unknown;
  lastContributedAt: Date | null;
  createdAt: Date;
};

/** Prisma returns only the columns `select` names — honor that exactly. */
const LINK_ROW_COLUMNS: Record<string, (row: LinkRow) => unknown> = {
  sourceId: (row) => row.sourceId,
  linkType: (row) => row.linkType,
  branchParticipation: (row) => row.branchParticipation,
  metadata: (row) => row.metadata,
  lastContributedAt: (row) => row.lastContributedAt,
  createdAt: (row) => row.createdAt,
};

function contributionLink(overrides: Partial<LinkRow>): LinkRow {
  return {
    sourceId: SESSION_REVISED,
    linkType: LinkType.RelatesTo,
    branchParticipation: null,
    metadata: { relation: ArtifactRefRelation.Created },
    lastContributedAt: null,
    createdAt: FIRST_LINKED,
    ...overrides,
  };
}

let linkRows: LinkRow[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  linkRows = [];
  const db = {
    artifactLink: {
      findMany: ({ select }: { select?: Record<string, boolean> }) =>
        Promise.resolve(
          linkRows.map((row) => {
            const projected: Record<string, unknown> = {};
            for (const [column, read] of Object.entries(LINK_ROW_COLUMNS)) {
              if (select?.[column] === true) {
                projected[column] = read(row);
              }
            }
            return projected;
          })
        ),
    },
    agentComponentSessionUsage: { findMany: () => Promise.resolve([]) },
  };
  mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
    cb(db)
  );
});

async function evidenceFor(): Promise<
  { sessionArtifactId: string; occurredAt: Date }[]
> {
  const rows = await readSessionProvenanceEvidence({
    organizationId: ORG,
    artifactId: ARTIFACT,
    kinds: RELATED_SESSION_ELIGIBLE_KINDS,
  });
  return rows.map((row) => ({
    sessionArtifactId: row.sessionArtifactId,
    occurredAt: row.occurredAt,
  }));
}

describe("Related Sessions contribution recency (ISS-7669)", () => {
  it("reports the last-contributed instant, not the first-linked one", async () => {
    linkRows = [
      contributionLink({ createdAt: FIRST_LINKED, lastContributedAt: REVISED }),
    ];

    const [row] = await evidenceFor();

    // The literal the ticket names: revised at 17:00, first linked at 09:00.
    expect(row.occurredAt).toEqual(new Date("2026-08-22T17:00:00.000Z"));
    expect(row.occurredAt).not.toEqual(new Date("2026-08-22T09:00:00.000Z"));
  });

  it("falls back to the creation instant for a row written before the column existed", async () => {
    linkRows = [
      contributionLink({ createdAt: FIRST_LINKED, lastContributedAt: null }),
    ];

    const [row] = await evidenceFor();

    // NOT `now()` — that would re-date every legacy edge to whenever the page
    // was loaded, which is the failure the invocation path already avoids.
    expect(row.occurredAt).toEqual(new Date("2026-08-22T09:00:00.000Z"));
  });

  it("still classifies the edge's kind while carrying the newer timestamp", async () => {
    // The timestamp widening must not disturb the eligibility decision: a
    // `created` relation is a contribution whether or not it was restated.
    linkRows = [
      contributionLink({ lastContributedAt: REVISED }),
      contributionLink({
        sourceId: SESSION_LEGACY,
        metadata: { relation: ArtifactRefRelation.Referenced },
        lastContributedAt: REVISED,
      }),
    ];

    const rows = await readSessionProvenanceEvidence({
      organizationId: ORG,
      artifactId: ARTIFACT,
      kinds: RELATED_SESSION_ELIGIBLE_KINDS,
    });

    expect(rows[0].kind).toBe(ProvenanceRelationshipKind.Contribution);
    expect(rows[1].kind).toBe(ProvenanceRelationshipKind.Reference);
  });

  it("orders a restated old edge above a never-restated newer one", async () => {
    // The ordering consequence, which is what a reader actually sees: without
    // the fix the 09:00 row keeps its stale date and sorts BELOW the 12:00 one.
    const NEVER_RESTATED = new Date("2026-08-22T12:00:00.000Z");
    linkRows = [
      contributionLink({ createdAt: FIRST_LINKED, lastContributedAt: REVISED }),
      contributionLink({
        sourceId: SESSION_LEGACY,
        createdAt: NEVER_RESTATED,
        lastContributedAt: null,
      }),
    ];

    const ordered = selectLatestEligibleContributions(
      await readSessionProvenanceEvidence({
        organizationId: ORG,
        artifactId: ARTIFACT,
        kinds: RELATED_SESSION_ELIGIBLE_KINDS,
      }),
      RELATED_SESSION_ELIGIBLE_KINDS
    );

    expect(ordered.map((row) => row.sessionArtifactId)).toEqual([
      SESSION_REVISED,
      SESSION_LEGACY,
    ]);
  });
});
