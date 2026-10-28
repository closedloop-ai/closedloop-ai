/**
 * ISS-7234 / ISS-7235 — the Related Sessions call site, not the query it calls.
 *
 * `provenance-eligibility.test.ts` proves the query honours whatever kind set it
 * is handed; every case there passes `kinds` from the test body. That leaves the
 * production CHOICE of set unexercised, so swapping
 * `RELATED_SESSION_ELIGIBLE_KINDS` for the wider tab set in
 * `related-sessions.ts` would admit invocation-, usage-, and reference-only
 * sessions to Related Sessions — the exact collapse this ticket exists to
 * prevent — with the rest of the suite still green. This file closes that.
 *
 * ISS-7235 changed two expectations here, both deliberately:
 *
 *  1. ORDER. The read used to return the projection's rows in
 *     `SESSION_DEFAULT_ORDER_BY` — the session's own recency. The field states
 *     newest CONTRIBUTION, a different fact, so the read now orders by the
 *     contribution timestamp. The fixture below is authored deliberately OUT of
 *     that order so a comparator that no-ops, or one that reads the session's
 *     own clock, fails.
 *  2. SHAPE. It returns the `RelatedSessionsResult` wire rows the field
 *     renders, with the eligible `total` beside the capped `items`, instead of
 *     raw list items with no contribution timestamp to render.
 *
 * The expectation that did NOT change, and is still the point of the file, is
 * WHICH sessions are eligible.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { ProvenanceRelationshipKind } from "@repo/api/src/types/provenance-relationship";
import { RELATED_SESSIONS_DISPLAY_CAP } from "@repo/api/src/types/related-session";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  sessionDetailFindMany: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
  withDb: mocks.withDb,
  // The evidence read composes its CTEs with the real `Prisma.sql`.
  Prisma: (
    await vi.importActual<typeof import("@repo/database")>("@repo/database")
  ).Prisma,
}));

import {
  listRelatedSessions,
  listRelatedSessionsForArtifacts,
} from "./related-sessions";

const ORG = "org-a";
const ARTIFACT = "artifact-a";
const CONTRIBUTOR = "session-contributor";
const COMMENTER = "session-commenter";
const USER = "session-user";
const MENTIONER = "session-mentioner";
const RELATIONLESS_REVIEWER = "session-relationless-reviewer";

const at = (iso: string) => new Date(iso);

/**
 * Authored OUT of contribution order on purpose (oldest first, and with the
 * relation-less reviewer — the newest — buried in the middle), so a read that
 * preserves input order, or reverses it, cannot pass the ordering case.
 */
const LINK_ROWS = [
  {
    sourceId: MENTIONER,
    targetId: ARTIFACT,
    linkType: LinkType.RelatesTo,
    metadata: { relation: ArtifactRefRelation.Referenced },
    createdAt: at("2026-08-01T00:00:00.000Z"),
  },
  {
    sourceId: CONTRIBUTOR,
    targetId: ARTIFACT,
    linkType: LinkType.RelatesTo,
    metadata: { relation: ArtifactRefRelation.Created },
    createdAt: at("2026-08-02T09:00:00.000Z"),
  },
  {
    // ISS-7234 review carry-forward: NO persisted `relation`. `slug-links.ts`
    // writes `role`/`method` on every row and `relation` only when present, so
    // this shape is COMMON, not legacy. Before `roleFromMethod` / the
    // participation fold, a row like this was classified "named in prose" and
    // silently dropped from Related Sessions.
    sourceId: RELATIONLESS_REVIEWER,
    targetId: ARTIFACT,
    linkType: LinkType.RelatesTo,
    metadata: { method: ArtifactRefMethod.PrReviewFeedbackCommand },
    createdAt: at("2026-08-05T12:00:00.000Z"),
  },
  {
    sourceId: USER,
    targetId: ARTIFACT,
    linkType: LinkType.RelatesTo,
    metadata: { relation: ArtifactRefRelation.Input },
    createdAt: at("2026-08-06T00:00:00.000Z"),
  },
  {
    sourceId: COMMENTER,
    targetId: ARTIFACT,
    linkType: LinkType.RelatesTo,
    metadata: { relation: ArtifactRefRelation.Reviewed },
    createdAt: at("2026-08-03T18:30:00.000Z"),
  },
];

/** What the PROJECTION returns — a full `BasicUser`, `email` included. */
const PROJECTED_USER = {
  id: "user-1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: "https://example.test/ada.png",
};

/** What may cross the wire: name parts and avatar, never the address. */
const WIRE_OWNER = {
  id: "user-1",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: "https://example.test/ada.png",
};

function projectionRow(id: string) {
  return {
    artifactId: id,
    nameOverride: null,
    awaitingInputSince: null,
    sessionEndedAt: null,
    lastActivityAt: at("2026-08-10T00:00:00.000Z"),
    sessionStartedAt: at("2026-08-01T00:00:00.000Z"),
    endsWithError: null,
    artifact: {
      slug: `SES-${id}`,
      name: `name-${id}`,
      status: SESSION_STATUS.INACTIVE,
      assignee: PROJECTED_USER,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const db = {
    artifactLink: {
      findMany: ({ where }: { where: { linkType?: { in?: string[] } } }) =>
        Promise.resolve(
          LINK_ROWS.filter(
            (row) => where.linkType?.in?.includes(row.linkType) !== false
          )
        ),
    },
    agentComponentSessionUsage: { findMany: () => Promise.resolve([]) },
    sessionDetail: { findMany: mocks.sessionDetailFindMany },
  };
  mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
    cb(db)
  );
  mocks.sessionDetailFindMany.mockImplementation(
    ({ where }: { where: { artifactId: { in: readonly string[] } } }) =>
      Promise.resolve(where.artifactId.in.map(projectionRow))
  );
});

describe("listRelatedSessions (ISS-7234 AC2, AC3)", () => {
  it("forwards only the contributing and commenting sessions to the projection", async () => {
    await listRelatedSessions(ORG, ARTIFACT);

    expect(mocks.sessionDetailFindMany).toHaveBeenCalledTimes(1);
    const [{ where }] = mocks.sessionDetailFindMany.mock.calls[0];
    expect(where.artifact.is.organizationId).toBe(ORG);
    const ids = where.artifactId.in;
    expect([...ids].sort()).toEqual(
      [CONTRIBUTOR, COMMENTER, RELATIONLESS_REVIEWER].sort()
    );
    expect(ids).not.toContain(USER);
    expect(ids).not.toContain(MENTIONER);
  });
});

describe("listRelatedSessions ordering (ISS-7235 AC2)", () => {
  it("returns the eligible sessions newest contribution first", async () => {
    const result = await listRelatedSessions(ORG, ARTIFACT);

    expect(result.items.map((item) => item.sessionArtifactId)).toEqual([
      RELATIONLESS_REVIEWER,
      COMMENTER,
      CONTRIBUTOR,
    ]);
  });

  it("dates each row by its contribution, not by the session", async () => {
    const result = await listRelatedSessions(ORG, ARTIFACT);

    expect(
      result.items.map((item) => [item.sessionArtifactId, item.contributedAt])
    ).toEqual([
      [RELATIONLESS_REVIEWER, "2026-08-05T12:00:00.000Z"],
      [COMMENTER, "2026-08-03T18:30:00.000Z"],
      [CONTRIBUTOR, "2026-08-02T09:00:00.000Z"],
    ]);
  });

  it("keeps a session's MOST RECENT contribution when it has several", async () => {
    const db = {
      artifactLink: {
        findMany: () =>
          Promise.resolve([
            {
              sourceId: CONTRIBUTOR,
              targetId: ARTIFACT,
              linkType: LinkType.RelatesTo,
              metadata: { relation: ArtifactRefRelation.Created },
              createdAt: at("2026-08-02T09:00:00.000Z"),
            },
            {
              sourceId: CONTRIBUTOR,
              targetId: ARTIFACT,
              linkType: LinkType.RelatesTo,
              metadata: { relation: ArtifactRefRelation.Output },
              createdAt: at("2026-08-09T04:00:00.000Z"),
            },
          ]),
      },
      agentComponentSessionUsage: { findMany: () => Promise.resolve([]) },
      sessionDetail: { findMany: mocks.sessionDetailFindMany },
    };
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );

    const result = await listRelatedSessions(ORG, ARTIFACT);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].contributedAt).toBe("2026-08-09T04:00:00.000Z");
  });
});

describe("listRelatedSessions relation-less links (ISS-7234 review carry-forward)", () => {
  it("includes a contribution whose link persisted no `relation`", async () => {
    const result = await listRelatedSessions(ORG, ARTIFACT);

    const relationless = result.items.find(
      (item) => item.sessionArtifactId === RELATIONLESS_REVIEWER
    );
    expect(relationless).toBeDefined();
    expect(relationless?.kind).toBe(ProvenanceRelationshipKind.Comment);
  });
});

describe("listRelatedSessions rendered fields (ISS-7235 AC3)", () => {
  it("carries the owner and the session's own identity onto each row", async () => {
    const result = await listRelatedSessions(ORG, ARTIFACT);

    expect(result.items[0]).toMatchObject({
      sessionArtifactId: RELATIONLESS_REVIEWER,
      slug: `SES-${RELATIONLESS_REVIEWER}`,
      name: `name-${RELATIONLESS_REVIEWER}`,
      status: "inactive",
      owner: WIRE_OWNER,
    });
  });

  it("projects the session's displayed status before returning the row", async () => {
    // What proves the row goes through `projectDisplayedSessionStatus` rather
    // than a raw passthrough is the fail-open fold: an unrecognized stored
    // status displays `active`, not its raw spelling.
    mocks.sessionDetailFindMany.mockImplementation(
      ({ where }: { where: { artifactId: { in: readonly string[] } } }) =>
        Promise.resolve(
          where.artifactId.in.map((id) => {
            const row = projectionRow(id);
            return {
              ...row,
              artifact: {
                ...row.artifact,
                status: "some-future-status",
              },
            };
          })
        )
    );

    const result = await listRelatedSessions(ORG, ARTIFACT);

    expect(result.items[0].status).toBe(SESSION_STATUS.ACTIVE);
  });

  it("drops a contribution the org-scoped projection did not return", async () => {
    mocks.sessionDetailFindMany.mockImplementation(
      ({ where }: { where: { artifactId: { in: readonly string[] } } }) =>
        Promise.resolve(
          where.artifactId.in
            .filter((id) => id !== COMMENTER)
            .map((id) => projectionRow(id))
        )
    );

    const result = await listRelatedSessions(ORG, ARTIFACT);

    expect(result.items.map((item) => item.sessionArtifactId)).toEqual([
      RELATIONLESS_REVIEWER,
      CONTRIBUTOR,
    ]);
    // The dropped row must leave `total` too. Holding it at 3 here would make
    // the field render "+1 more" for a session that is not there to reveal.
    expect(result.total).toBe(2);
  });
});

describe("listRelatedSessions overflow (ISS-7235 AC6)", () => {
  it("caps the rendered rows while reporting the full eligible total", async () => {
    const result = await listRelatedSessions(ORG, ARTIFACT, 2);

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  it("reports no overflow when every eligible session fits", async () => {
    const result = await listRelatedSessions(ORG, ARTIFACT);

    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  it("floors a zero or negative bound at one row rather than inverting to unbounded", async () => {
    const result = await listRelatedSessions(ORG, ARTIFACT, 0);

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(3);
  });

  it("truncates at the shared display cap when no bound is passed", async () => {
    // One MORE eligible contribution than the cap admits, so the default is
    // actually exercised. The previous version of this case asserted
    // `items.length <= CAP` against a 3-row fixture, which held for any
    // default and would have survived narrowing it to 3 or widening it to 50.
    const overCap = RELATED_SESSIONS_DISPLAY_CAP + 1;
    const rows = Array.from({ length: overCap }, (_, index) => ({
      sourceId: `session-${index}`,
      targetId: ARTIFACT,
      linkType: LinkType.RelatesTo,
      metadata: { relation: ArtifactRefRelation.Created },
      createdAt: at(
        `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
      ),
    }));
    const db = {
      artifactLink: { findMany: () => Promise.resolve(rows) },
      agentComponentSessionUsage: { findMany: () => Promise.resolve([]) },
      sessionDetail: { findMany: mocks.sessionDetailFindMany },
    };
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );

    const result = await listRelatedSessions(ORG, ARTIFACT);

    expect(result.items).toHaveLength(8);
    expect(result.total).toBe(9);
    // Newest-first, so the cap keeps the most recent contributions.
    expect(result.items[0].sessionArtifactId).toBe(`session-${overCap - 1}`);
  });
});

describe("listRelatedSessions empty subject", () => {
  it("returns an empty result without asking the projection for rows", async () => {
    const db = {
      artifactLink: { findMany: () => Promise.resolve([]) },
      agentComponentSessionUsage: { findMany: () => Promise.resolve([]) },
    };
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );

    const result = await listRelatedSessions(ORG, ARTIFACT);

    expect(result).toEqual({ items: [], total: 0 });
    expect(mocks.sessionDetailFindMany).not.toHaveBeenCalled();
  });
});

describe("listRelatedSessionsForArtifacts (ISS-9570)", () => {
  it("returns one result per requested artifact with one evidence read and one session projection", async () => {
    const secondArtifact = "artifact-b";
    const queryRaw = vi.fn().mockResolvedValue([
      pageRow({
        targetId: ARTIFACT,
        sessionArtifactId: CONTRIBUTOR,
        kind: ProvenanceRelationshipKind.Contribution,
        occurredAt: at("2026-08-02T09:00:00.000Z"),
        total: 1n,
      }),
      pageRow({
        targetId: secondArtifact,
        sessionArtifactId: COMMENTER,
        kind: ProvenanceRelationshipKind.Comment,
        occurredAt: at("2026-08-03T18:30:00.000Z"),
        total: 1n,
      }),
    ]);
    const db = {
      $queryRaw: queryRaw,
      sessionDetail: { findMany: mocks.sessionDetailFindMany },
    };
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );

    const result = await listRelatedSessionsForArtifacts(ORG, [
      ARTIFACT,
      secondArtifact,
    ]);

    expect(Object.keys(result).sort()).toEqual([ARTIFACT, secondArtifact]);
    expect(result[ARTIFACT].items[0].sessionArtifactId).toBe(CONTRIBUTOR);
    expect(result[secondArtifact].items[0].sessionArtifactId).toBe(COMMENTER);
    expect(mocks.sessionDetailFindMany).toHaveBeenCalledTimes(1);
    const [{ where }] = mocks.sessionDetailFindMany.mock.calls[0];
    expect(where.artifactId.in.sort()).toEqual([COMMENTER, CONTRIBUTOR]);
  });

  it("pushes the per-target cap and exact total into the batch SQL", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      pageRow({
        targetId: ARTIFACT,
        sessionArtifactId: "session-new",
        kind: ProvenanceRelationshipKind.Contribution,
        occurredAt: at("2026-08-09T00:00:00.000Z"),
        total: 5n,
      }),
      pageRow({
        targetId: ARTIFACT,
        sessionArtifactId: "session-next",
        kind: ProvenanceRelationshipKind.Comment,
        occurredAt: at("2026-08-08T00:00:00.000Z"),
        total: 5n,
      }),
    ]);
    const db = {
      $queryRaw: queryRaw,
      sessionDetail: { findMany: mocks.sessionDetailFindMany },
    };
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );

    const result = await listRelatedSessionsForArtifacts(ORG, [ARTIFACT], 2);

    expect(result[ARTIFACT].items).toHaveLength(2);
    expect(result[ARTIFACT].total).toBe(5);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = renderSql(queryRaw.mock.calls[0]);
    expect(sql).toContain("COUNT(*) OVER (PARTITION BY");
    expect(sql).toContain("ROW_NUMBER() OVER");
    expect(sql).toContain("WHERE target_rank <=");
    expect(sql).toContain(
      'ORDER BY "occurredAt" DESC, "createdAt" ASC, kind ASC'
    );
    expect(queryRaw.mock.calls[0]).toContain(2);
  });

  it("keeps the batch SQL org-scoped on the link, source, and target rows", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const db = {
      $queryRaw: queryRaw,
      sessionDetail: { findMany: mocks.sessionDetailFindMany },
    };
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );

    await listRelatedSessionsForArtifacts(ORG, [ARTIFACT]);

    const sql = renderSql(queryRaw.mock.calls[0]);
    expect(sql).toContain("al.organization_id =");
    expect(sql).toContain("source.organization_id =");
    expect(sql).toContain("target.organization_id =");
  });

  it("drops a session the org-scoped projection refuses, even when the evidence read returned it", async () => {
    // Simulates a batch-SQL regression that let another org's session through,
    // so the projection is the only org check left to catch it.
    const queryRaw = vi.fn().mockResolvedValue([
      pageRow({
        targetId: ARTIFACT,
        sessionArtifactId: FOREIGN_SESSION,
        kind: ProvenanceRelationshipKind.Contribution,
        occurredAt: at("2026-08-04T00:00:00.000Z"),
        total: 2n,
      }),
      pageRow({
        targetId: ARTIFACT,
        sessionArtifactId: CONTRIBUTOR,
        kind: ProvenanceRelationshipKind.Contribution,
        occurredAt: at("2026-08-02T09:00:00.000Z"),
        total: 2n,
      }),
    ]);
    const db = {
      $queryRaw: queryRaw,
      sessionDetail: { findMany: findTwoOrgProjection },
    };
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );

    const result = await listRelatedSessionsForArtifacts(ORG, [ARTIFACT]);

    expect(
      result[ARTIFACT].items.map((item) => item.sessionArtifactId)
    ).toEqual([CONTRIBUTOR]);
    expect(result[ARTIFACT].total).toBe(1);
    expect(JSON.stringify(result)).not.toContain(FOREIGN_SESSION);
  });
});

type PageRowInput = {
  targetId: string;
  sessionArtifactId: string;
  kind: ProvenanceRelationshipKind;
  occurredAt: Date;
  total: bigint;
};

function pageRow(input: PageRowInput) {
  return input;
}

function renderSql(call: unknown[] | undefined): string {
  const strings = call?.[0] as TemplateStringsArray | undefined;
  if (strings === undefined) {
    return "";
  }
  // A composed fragment arrives as one value; render its text in place.
  return [...strings].reduce((sql, part, index) => {
    const value = call?.[index] as { sql?: unknown } | undefined;
    const fragment =
      index > 0 && typeof value?.sql === "string" ? value.sql : "?";
    return index === 0 ? part : `${sql}${fragment}${part}`;
  }, "");
}

const FOREIGN_ORG = "org-b";
const FOREIGN_SESSION = "session-foreign";

const TWO_ORG_PROJECTION = [
  { organizationId: ORG, row: projectionRow(CONTRIBUTOR) },
  { organizationId: FOREIGN_ORG, row: projectionRow(FOREIGN_SESSION) },
];

type ProjectionWhere = {
  artifactId: { in: readonly string[] };
  artifact?: { is?: { organizationId?: string } };
};

/** Prisma semantics: an absent `where` key constrains nothing. */
function findTwoOrgProjection({ where }: { where: ProjectionWhere }) {
  const organizationId = where.artifact?.is?.organizationId;
  return Promise.resolve(
    TWO_ORG_PROJECTION.filter(
      (entry) =>
        where.artifactId.in.includes(entry.row.artifactId) &&
        (organizationId === undefined ||
          entry.organizationId === organizationId)
    ).map((entry) => entry.row)
  );
}
