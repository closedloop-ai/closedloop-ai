/**
 * ISS-5355 — the `projectIds` Project facet predicate.
 *
 * The project-detail strip counts "active sessions with a linked artifact in
 * this project" and links to the Sessions listing carrying the same selection,
 * so the SERVER side of that agreement is this predicate: whatever the strip's
 * count read narrows by, the listing read must narrow by identically.
 *
 * The load-bearing assertion is WHICH edge the predicate walks. A session's own
 * artifact is created unparented, so `artifact.projectId` is null for
 * essentially every session — a facet built on that column would be permanently
 * empty and the strip would report 0 on every project forever. The facet must
 * walk the session→document link instead (ISS-5236's "linked artifacts").
 */
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionListQuery } from "../validators";
import { buildProjectLinkWhere } from "./project-link-where";
import { buildWhere } from "./query-builder";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

const ORG_ID = "org_1";
const PROJECT_A = "019f8008-1969-74f9-b056-99c13cca9a07";
const PROJECT_B = "019f8008-1969-74f9-b056-99c13cca9a08";

function listFilters(
  filters: Partial<AgentSessionListQuery> = {}
): AgentSessionListQuery {
  return { quality: "all", ...filters } as AgentSessionListQuery;
}

type ArtifactIs = {
  is?: {
    projectId?: unknown;
    sourceLinks?: { some?: Prisma.ArtifactLinkWhereInput };
  };
};

/** The session→document link predicate the Project FACET writes. */
function projectLinkPredicate(where: Prisma.SessionDetailWhereInput) {
  return (where.artifact as ArtifactIs | undefined)?.is?.sourceLinks?.some;
}

/** The pre-existing singular `projectId` scope — a different dimension. */
function projectScopePredicate(where: Prisma.SessionDetailWhereInput) {
  return (where.artifact as ArtifactIs | undefined)?.is?.projectId;
}

describe("ISS-5355 Project facet predicate", () => {
  it("walks the session→document link, not the session artifact's own projectId", async () => {
    // The regression this pins: `artifact.projectId` is null on a synced session
    // artifact, so a predicate on that column matches nothing and the strip
    // renders a permanent zero.
    const where = await buildWhere(
      { organizationId: ORG_ID },
      listFilters({ projectIds: [PROJECT_A] })
    );

    expect(projectScopePredicate(where)).toBeUndefined();
    expect(projectLinkPredicate(where)).toEqual({
      linkType: LinkType.RelatesTo,
      target: {
        is: {
          type: ArtifactType.Document,
          projectId: { in: [PROJECT_A] },
        },
      },
    });
  });

  it("counts only RELATES_TO edges, the link type the projection exposes", async () => {
    // The session detail's "linked artifacts" list selects `linkType =
    // RELATES_TO` only (`records.ts`). A PRODUCES or BLOCKS edge to a document
    // in the project is reachable on `artifact_links`, so an untyped predicate
    // would attribute a session to a project through an edge the projection
    // never shows — the facet number would exceed what the detail can account
    // for.
    const where = await buildWhere(
      { organizationId: ORG_ID },
      listFilters({ projectIds: [PROJECT_A] })
    );

    expect(projectLinkPredicate(where)?.linkType).toBe(LinkType.RelatesTo);
  });

  it("builds that predicate from the shared link definition, not a local copy", async () => {
    // The filter's one definition lives in `project-link-where.ts`, beside the
    // facet counts' SQL spelling of the same edge, which
    // `project-facet-options.integration.test.ts` pins to it. A local copy here
    // could drift and the count would stop describing the rows.
    const where = await buildWhere(
      { organizationId: ORG_ID },
      listFilters({ projectIds: [PROJECT_A] })
    );

    expect(projectLinkPredicate(where)).toEqual(
      buildProjectLinkWhere([PROJECT_A])
    );
  });

  it("ORs a multi-project selection rather than dropping all but one", async () => {
    const where = await buildWhere(
      { organizationId: ORG_ID },
      listFilters({ projectIds: [PROJECT_A, PROJECT_B] })
    );

    expect(projectLinkPredicate(where)).toEqual(
      buildProjectLinkWhere([PROJECT_A, PROJECT_B])
    );
  });

  it("only counts DOCUMENT targets, so a branch or PR link is not a project link", async () => {
    // Session→branch and session→PR links share the same `sourceLinks` edge. A
    // predicate that ignored the target type would attribute a session to a
    // project through a branch that merely lives near it.
    const where = await buildWhere(
      { organizationId: ORG_ID },
      listFilters({ projectIds: [PROJECT_A] })
    );

    expect(projectLinkPredicate(where)?.target).toMatchObject({
      is: { type: ArtifactType.Document },
    });
  });

  it("applies no link predicate when the facet is unselected", async () => {
    const where = await buildWhere({ organizationId: ORG_ID }, listFilters());

    expect(projectLinkPredicate(where)).toBeUndefined();
  });

  it("applies no link predicate for an empty selection", async () => {
    // An empty array is "no project chosen", not "no project matches" — it must
    // not collapse the list to zero rows.
    const where = await buildWhere(
      { organizationId: ORG_ID },
      listFilters({ projectIds: [] })
    );

    expect(projectLinkPredicate(where)).toBeUndefined();
  });

  it("keeps the pre-existing singular projectId scope working unchanged", async () => {
    const where = await buildWhere(
      { organizationId: ORG_ID },
      listFilters({ projectId: PROJECT_A })
    );

    expect(projectScopePredicate(where)).toBe(PROJECT_A);
    expect(projectLinkPredicate(where)).toBeUndefined();
  });

  it("ANDs the scope and the facet as the separate dimensions they are", async () => {
    const where = await buildWhere(
      { organizationId: ORG_ID },
      listFilters({ projectId: PROJECT_A, projectIds: [PROJECT_B] })
    );

    expect(projectScopePredicate(where)).toBe(PROJECT_A);
    expect(projectLinkPredicate(where)).toEqual(
      buildProjectLinkWhere([PROJECT_B])
    );
  });

  // The strip's shared predicate is `{ statuses: [ACTIVE], projectIds: [id] }`.
  // Both dimensions must survive into one where, or the listing the strip links
  // to answers a different question than the number the user clicked.
  it("composes with the Active status facet the strip's predicate carries", async () => {
    const where = await buildWhere(
      { organizationId: ORG_ID },
      listFilters({
        projectIds: [PROJECT_A],
        statuses: [SESSION_STATUS.ACTIVE],
      })
    );

    expect(projectLinkPredicate(where)).toEqual(
      buildProjectLinkWhere([PROJECT_A])
    );
    // ISS-9939 / ISS-10629: Active is now a plain `artifact.status` equality
    // (hoisted alongside the project scope), not a session-level derivation —
    // the operator ruling collapsed the FILTER to the three persisted
    // SESSION_STATUS values.
    const artifact = where.artifact as { is?: { status?: unknown } };
    expect(artifact.is?.status).toBe(SESSION_STATUS.ACTIVE);
  });

  it("keeps the org scope alongside the project narrowing", async () => {
    const where = await buildWhere(
      { organizationId: ORG_ID },
      listFilters({ projectIds: [PROJECT_A] })
    );

    const artifact = where.artifact as { is?: { organizationId?: string } };
    expect(artifact.is?.organizationId).toBe(ORG_ID);
  });
});
