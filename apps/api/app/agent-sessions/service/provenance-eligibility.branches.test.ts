/**
 * Branch-coverage top-up for `provenance-eligibility.ts` (ISS-11280):
 * `sessionProvenanceLinkWhere`'s array-of-ids scope, the multi-target raw-SQL
 * reader's empty-input short circuit and count conversion,
 * `readSessionProvenanceEvidence`'s over-cap throw and invocation-only skip of
 * the link read, the default `kinds` param on both list helpers, and
 * `selectLatestEligibleContributions`'s latest-wins/tie-break reduction.
 *
 * `provenance-eligibility.test.ts` (sibling file) already drives the
 * org-isolation and classification fixtures through
 * `listEligibleSessionArtifactIds`; this file targets the arms that fixture
 * never reaches.
 */
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  ProvenanceRelationshipKind,
  RELATED_SESSION_ELIGIBLE_KINDS,
} from "@repo/api/src/types/provenance-relationship";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  queryRaw: vi.fn(),
  artifactLinkFindMany: vi.fn(),
  usageFindMany: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
  withDb: mocks.withDb,
  // The evidence read composes its CTEs with the real `Prisma.sql`.
  Prisma: (
    await vi.importActual<typeof import("@repo/database")>("@repo/database")
  ).Prisma,
}));

import { Prisma } from "@repo/database";
import {
  listEligibleSessionArtifactIds,
  listEligibleSessionContributions,
  readLatestRelatedSessionContributionsForTargets,
  readSessionProvenanceEvidence,
  selectLatestEligibleContributions,
  sessionProvenanceLinkWhere,
} from "./provenance-eligibility";

const OVER_CAP_COUNT_PATTERN = /1001/;

const ORG_A = "org-a";
const ARTIFACT_A = "artifact-a";
const ARTIFACT_B = "artifact-b";
const COMPONENT_A = "component-a";
const SESSION_CONTRIBUTOR = "session-contributor";
const SESSION_COMMENTER = "session-commenter";

beforeEach(() => {
  vi.clearAllMocks();
  const db = {
    $queryRaw: mocks.queryRaw,
    artifactLink: { findMany: mocks.artifactLinkFindMany },
    agentComponentSessionUsage: { findMany: mocks.usageFindMany },
  };
  mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
    cb(db)
  );
  mocks.artifactLinkFindMany.mockImplementation(
    ({ where }: { where: { source?: { is?: { organizationId?: string } } } }) =>
      Promise.resolve(
        where.source?.is?.organizationId === ORG_A
          ? [
              {
                sourceId: SESSION_CONTRIBUTOR,
                linkType: LinkType.RelatesTo,
                metadata: { relation: "created" },
                branchParticipation: null,
                lastContributedAt: null,
                createdAt: new Date("2026-05-01T00:00:00.000Z"),
              },
              {
                sourceId: SESSION_COMMENTER,
                linkType: LinkType.RelatesTo,
                metadata: { relation: "reviewed" },
                branchParticipation: null,
                lastContributedAt: null,
                createdAt: new Date("2026-05-01T00:00:00.000Z"),
              },
            ]
          : []
      )
  );
  mocks.usageFindMany.mockResolvedValue([]);
});

describe("sessionProvenanceLinkWhere — target scope", () => {
  it("scopes to a deduped set of target ids when given an array", () => {
    const where = sessionProvenanceLinkWhere(
      ORG_A,
      [ARTIFACT_A, ARTIFACT_B, ARTIFACT_A],
      RELATED_SESSION_ELIGIBLE_KINDS
    );

    expect(where.targetId).toEqual({ in: [ARTIFACT_A, ARTIFACT_B] });
  });
});

describe("readLatestRelatedSessionContributionsForTargets", () => {
  it("returns an empty page without touching the database when no target ids are given", async () => {
    const page = await readLatestRelatedSessionContributionsForTargets({
      organizationId: ORG_A,
      artifactIds: [],
      limit: 10,
    });

    expect(page).toEqual({ contributions: [], totalByTarget: new Map() });
    expect(mocks.withDb).not.toHaveBeenCalled();
  });

  it("maps raw rows into contributions and converts both a bigint and a plain-number total", async () => {
    const occurredAt = new Date("2026-05-01T00:00:00.000Z");
    mocks.queryRaw.mockResolvedValue([
      {
        targetId: ARTIFACT_A,
        sessionArtifactId: SESSION_CONTRIBUTOR,
        kind: ProvenanceRelationshipKind.Contribution,
        occurredAt,
        total: 3n,
      },
      {
        targetId: ARTIFACT_B,
        sessionArtifactId: SESSION_COMMENTER,
        kind: ProvenanceRelationshipKind.Comment,
        occurredAt,
        total: 1,
      },
    ]);

    const page = await readLatestRelatedSessionContributionsForTargets({
      organizationId: ORG_A,
      artifactIds: [ARTIFACT_A, ARTIFACT_B],
      limit: 10,
    });

    expect(page.contributions).toEqual([
      {
        targetId: ARTIFACT_A,
        sessionArtifactId: SESSION_CONTRIBUTOR,
        kind: ProvenanceRelationshipKind.Contribution,
        occurredAt,
      },
      {
        targetId: ARTIFACT_B,
        sessionArtifactId: SESSION_COMMENTER,
        kind: ProvenanceRelationshipKind.Comment,
        occurredAt,
      },
    ]);
    expect(page.totalByTarget.get(ARTIFACT_A)).toBe(3);
    expect(page.totalByTarget.get(ARTIFACT_B)).toBe(1);

    // The bound params that carry the caller's actual input (org, the deduped
    // target ids, and the row-limit floor) must reach the query — not just
    // that some canned rows came back regardless of what was asked.
    // The CTEs arrive as one composed fragment; read its bound values too.
    const boundValues = (mocks.queryRaw.mock.calls[0]?.slice(1) ?? []).flatMap(
      (value: unknown) =>
        value instanceof Prisma.Sql ? [value, ...value.values] : [value]
    );
    expect(boundValues).toEqual(
      expect.arrayContaining([ORG_A, [ARTIFACT_A, ARTIFACT_B], 10])
    );
  });
});

describe("readSessionProvenanceEvidence — invocation cap and link-read skip", () => {
  it("throws instead of issuing a truncated IN-list query when agentComponentIds exceeds the ceiling", async () => {
    const overCap = Array.from({ length: 1001 }, (_unused, i) => `comp-${i}`);

    await expect(
      readSessionProvenanceEvidence({
        organizationId: ORG_A,
        artifactId: ARTIFACT_A,
        kinds: [ProvenanceRelationshipKind.Invocation],
        agentComponentIds: overCap,
      })
    ).rejects.toThrow(OVER_CAP_COUNT_PATTERN);
  });

  it("skips the artifact-links read entirely when only invocation evidence is requested", async () => {
    mocks.usageFindMany.mockResolvedValue([
      {
        agentSessionId: SESSION_CONTRIBUTOR,
        lastInvokedAt: null,
        createdAt: new Date("2026-05-02T00:00:00.000Z"),
      },
    ]);

    const evidence = await readSessionProvenanceEvidence({
      organizationId: ORG_A,
      artifactId: ARTIFACT_A,
      kinds: [ProvenanceRelationshipKind.Invocation],
      agentComponentIds: [COMPONENT_A],
    });

    expect(mocks.artifactLinkFindMany).not.toHaveBeenCalled();
    expect(evidence).toEqual([
      {
        sessionArtifactId: SESSION_CONTRIBUTOR,
        kind: ProvenanceRelationshipKind.Invocation,
        occurredAt: new Date("2026-05-02T00:00:00.000Z"),
      },
    ]);
  });
});

describe("listEligibleSessionArtifactIds / listEligibleSessionContributions — default kinds", () => {
  it("defaults listEligibleSessionArtifactIds to the Related Sessions kind set when kinds is omitted", async () => {
    const ids = await listEligibleSessionArtifactIds({
      organizationId: ORG_A,
      artifactId: ARTIFACT_A,
    });

    expect(ids).toEqual([SESSION_CONTRIBUTOR, SESSION_COMMENTER]);
    // The org predicate AND the link-type filter the omitted `kinds` resolves
    // to — proving the default actually reached the query, not just that some
    // canned rows came back regardless of it.
    expect(mocks.artifactLinkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_A,
          targetId: ARTIFACT_A,
          linkType: { in: [LinkType.RelatesTo] },
          source: {
            is: {
              organizationId: ORG_A,
              type: ArtifactType.Session,
              session: { isNot: null },
            },
          },
        }),
      })
    );
  });

  it("defaults listEligibleSessionContributions to the Related Sessions kind set when kinds is omitted", async () => {
    const contributions = await listEligibleSessionContributions({
      organizationId: ORG_A,
      artifactId: ARTIFACT_A,
    });

    // Both fixture rows share one `createdAt`, so `listEligibleSessionContributions`
    // (unlike the plain id-list helper above) re-sorts them by session id as its
    // tie-break rather than preserving read order.
    expect(contributions.map((row) => row.sessionArtifactId)).toEqual([
      SESSION_COMMENTER,
      SESSION_CONTRIBUTOR,
    ]);
    expect(mocks.artifactLinkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_A,
          targetId: ARTIFACT_A,
          linkType: { in: [LinkType.RelatesTo] },
        }),
      })
    );
  });
});

describe("selectLatestEligibleContributions", () => {
  it("drops an ineligible-kind row entirely, keeps only a session's LATEST eligible row, and never lets an earlier-seen older row demote it", () => {
    const oldest = new Date("2026-04-30T00:00:00.000Z");
    const older = new Date("2026-05-01T00:00:00.000Z");
    const newer = new Date("2026-05-02T00:00:00.000Z");
    const result = selectLatestEligibleContributions(
      [
        {
          sessionArtifactId: "s1",
          kind: ProvenanceRelationshipKind.Contribution,
          occurredAt: older,
        },
        {
          sessionArtifactId: "s1",
          kind: ProvenanceRelationshipKind.Contribution,
          occurredAt: newer,
        },
        // Seen AFTER s1's newer row: older still, so it must not replace the
        // held newer entry (the "neither operand is true" outcome).
        {
          sessionArtifactId: "s1",
          kind: ProvenanceRelationshipKind.Contribution,
          occurredAt: oldest,
        },
        // Reference is outside RELATED_SESSION_ELIGIBLE_KINDS and must be
        // dropped before it can ever become "the latest" for s2.
        {
          sessionArtifactId: "s2",
          kind: ProvenanceRelationshipKind.Reference,
          occurredAt: newer,
        },
        {
          sessionArtifactId: "s2",
          kind: ProvenanceRelationshipKind.Comment,
          occurredAt: newer,
        },
      ],
      RELATED_SESSION_ELIGIBLE_KINDS
    );

    // s1 settles on its newer row (not the oldest one seen last), and the tie
    // between s1 and s2 at the same `newer` timestamp breaks on session id.
    expect(result).toEqual([
      {
        sessionArtifactId: "s1",
        kind: ProvenanceRelationshipKind.Contribution,
        occurredAt: newer,
      },
      {
        sessionArtifactId: "s2",
        kind: ProvenanceRelationshipKind.Comment,
        occurredAt: newer,
      },
    ]);
  });

  it("orders two sessions with DIFFERENT timestamps by occurredAt descending, without falling to the id tie-break", () => {
    const earlier = new Date("2026-05-01T00:00:00.000Z");
    const later = new Date("2026-05-03T00:00:00.000Z");
    const result = selectLatestEligibleContributions(
      [
        {
          sessionArtifactId: "s-a",
          kind: ProvenanceRelationshipKind.Contribution,
          occurredAt: earlier,
        },
        {
          sessionArtifactId: "s-b",
          kind: ProvenanceRelationshipKind.Comment,
          occurredAt: later,
        },
      ],
      RELATED_SESSION_ELIGIBLE_KINDS
    );

    // "s-a" would sort first by id, but its timestamp is older, so the time
    // comparison alone must decide this order.
    expect(result.map((row) => row.sessionArtifactId)).toEqual(["s-b", "s-a"]);
  });
});
