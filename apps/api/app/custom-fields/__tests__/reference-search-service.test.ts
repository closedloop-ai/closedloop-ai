/**
 * Unit coverage for the reference search + batch resolution surface (ISS-7212).
 *
 * The two halves this file can prove without Postgres are the ones the database
 * cannot check for us: how many queries a page costs, and which requests are
 * refused before a query is built. Whether the emitted `where` actually selects
 * the right ROWS is a question only a real database answers, and it is pinned in
 * `reference-search.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  Prisma: { QueryMode: { insensitive: "insensitive" } },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
    SESSION: "SESSION",
  },
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
    DOC: "DOC",
    ISSUE: "ISSUE",
  },
}));

import {
  CustomFieldType,
  REFERENCE_SEARCH_DEFAULT_LIMIT,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import {
  DisallowedReferenceSourceError,
  ReferenceFieldNotFoundError,
  referenceSearchService,
} from "../reference-search-service";
import { referenceSourceScope } from "../reference-targets";

const mockWithDb = withDb as unknown as Mock;

const ORG_ID = "org-1";
const FIELD_ID = "field-1";

type DbMocks = {
  customField: { findFirst: Mock };
  artifact: { findMany: Mock };
};

function installDb(field: unknown, rows: unknown[] = []): DbMocks {
  const mocks: DbMocks = {
    customField: { findFirst: vi.fn().mockResolvedValue(field) },
    artifact: { findMany: vi.fn().mockResolvedValue(rows) },
  };
  mockWithDb.mockImplementation((fn: (db: DbMocks) => unknown) => fn(mocks));
  return mocks;
}

function referenceField(
  sources: ReferenceTargetSource[] = [ReferenceTargetSource.Issue],
  fieldType: CustomFieldType = CustomFieldType.ReferenceMulti
) {
  return {
    id: FIELD_ID,
    name: "Linked issues",
    fieldType,
    referenceTargetSources: sources,
  };
}

function artifactRow(index: number) {
  return {
    id: uuidForIndex(index),
    slug: `ISS-${index}`,
    name: `Issue ${index}`,
    type: ArtifactType.DOCUMENT,
    subtype: ArtifactSubtype.FEATURE,
    status: "TODO",
  };
}

/** A distinct well-formed artifact id per index. */
function uuidForIndex(index: number): string {
  return `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

/**
 * A uuid carrying hex LETTERS in every group, so the uppercase spelling below
 * is genuinely a different string. `uuidForIndex` cannot serve here: it is all
 * decimal digits and uppercases to itself.
 */
const CANONICAL_HEX_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const UPPERCASE_HEX_ID = CANONICAL_HEX_ID.toUpperCase();

/** The ids a page of `rows` rows x `perRow` targets would ask about. */
function pageOfTargetIds(rows: number, perRow: number): string[] {
  return Array.from({ length: rows * perRow }, (_, i) => uuidForIndex(i));
}

type TextClause = { OR: [{ slug: { contains: string } }, unknown] };

/**
 * The free-text disjunction, told apart from the source-scope disjunction that
 * shares the `AND` list and is also spelled with `OR`.
 */
function textClause(
  and: { OR?: { slug?: unknown }[] }[]
): TextClause | undefined {
  return and.find((entry) => entry.OR?.[0]?.slug !== undefined) as
    | TextClause
    | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveTargets query budget", () => {
  it("resolves a 25-row page of 4-target cells in exactly one query", async () => {
    const ids = pageOfTargetIds(25, 4);
    const db = installDb(
      null,
      ids.map((_, i) => artifactRow(i))
    );

    await referenceSearchService.resolveTargets(ids, ORG_ID);

    expect(db.artifact.findMany).toHaveBeenCalledTimes(1);
    // One call that asked about only some of the ids would still be "one
    // query" while silently dropping chips, so pin the predicate too.
    expect(db.artifact.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ids },
      organizationId: ORG_ID,
    });
  });

  it("still costs one query when the page and its cells both grow", async () => {
    const ids = pageOfTargetIds(50, 8);
    const db = installDb(
      null,
      ids.map((_, i) => artifactRow(i))
    );

    await referenceSearchService.resolveTargets(ids, ORG_ID);

    // The point of the second size: one call at 100 ids could be a coincidence
    // of the fixture, one call at 400 ids cannot be a per-id lookup.
    expect(db.artifact.findMany).toHaveBeenCalledTimes(1);
    expect(db.artifact.findMany.mock.calls[0][0].where.id.in).toHaveLength(400);
  });

  it("asks the database nothing when no ids are requested", async () => {
    const db = installDb(null);

    const result = await referenceSearchService.resolveTargets([], ORG_ID);

    expect(db.artifact.findMany).not.toHaveBeenCalled();
    expect(result).toEqual({ targets: [], unresolvable: [] });
  });

  it("collapses duplicate ids into a single predicate entry", async () => {
    const id = uuidForIndex(1);
    const db = installDb(null, [artifactRow(1)]);

    await referenceSearchService.resolveTargets([id, id, id], ORG_ID);

    expect(db.artifact.findMany.mock.calls[0][0].where.id.in).toEqual([id]);
  });
});

describe("resolveTargets unresolvable contract", () => {
  it("reports ids that produced no row instead of dropping them", async () => {
    const present = uuidForIndex(1);
    const missing = uuidForIndex(2);
    installDb(null, [artifactRow(1)]);

    const result = await referenceSearchService.resolveTargets(
      [present, missing],
      ORG_ID
    );

    expect(result.unresolvable).toEqual([missing]);
    expect(result.targets.map((t) => t.id)).toEqual([present]);
  });

  it("carries no data for an unresolvable id beyond the id itself", async () => {
    const missing = uuidForIndex(9);
    installDb(null, []);

    const result = await referenceSearchService.resolveTargets(
      [missing],
      ORG_ID
    );

    // The whole response, deep-compared: a leaked name or status for an
    // artifact the caller may not read would have to show up here.
    expect(result).toEqual({ targets: [], unresolvable: [missing] });
  });

  it("returns targets in the caller's order, not the database's", async () => {
    const first = uuidForIndex(1);
    const second = uuidForIndex(2);
    installDb(null, [artifactRow(2), artifactRow(1)]);

    const result = await referenceSearchService.resolveTargets(
      [first, second],
      ORG_ID
    );

    expect(result.targets.map((t) => t.id)).toEqual([first, second]);
  });

  it("resolves a target asked for in uppercase hex instead of calling it unresolvable", async () => {
    // The row is spelled the way Postgres renders a uuid — canonical lowercase
    // — whatever spelling the query asked for. Match the caller's raw id
    // against that and an EXISTING target is reported as unresolvable: a wrong
    // answer delivered with the same confidence as a right one.
    //
    // The guard below is the fixture's own contract: `uuidForIndex` produces an
    // all-digit uuid, which uppercases to itself and could not express this bug
    // at all.
    expect(UPPERCASE_HEX_ID).not.toBe(CANONICAL_HEX_ID);
    const db = installDb(null, [{ ...artifactRow(1), id: CANONICAL_HEX_ID }]);

    const result = await referenceSearchService.resolveTargets(
      [UPPERCASE_HEX_ID],
      ORG_ID
    );

    expect(result.unresolvable).toEqual([]);
    expect(result.targets.map((t) => t.id)).toEqual([CANONICAL_HEX_ID]);
    // Canonicalized before the query too, so the predicate carries one spelling.
    expect(db.artifact.findMany.mock.calls[0][0].where.id.in).toEqual([
      CANONICAL_HEX_ID,
    ]);
  });

  it("treats two spellings of one id as one requested target", async () => {
    const db = installDb(null, [{ ...artifactRow(1), id: CANONICAL_HEX_ID }]);

    const result = await referenceSearchService.resolveTargets(
      [CANONICAL_HEX_ID, UPPERCASE_HEX_ID],
      ORG_ID
    );

    // Without canonicalization the `Set` keeps both, the predicate names the
    // same row twice, and the uppercase copy comes back as unresolvable
    // alongside its own resolved self.
    expect(db.artifact.findMany.mock.calls[0][0].where.id.in).toEqual([
      CANONICAL_HEX_ID,
    ]);
    expect(result).toEqual({
      targets: [expect.objectContaining({ id: CANONICAL_HEX_ID })],
      unresolvable: [],
    });
  });
});

describe("searchTargets request rejection", () => {
  it("rejects a source the field does not permit rather than filtering it out", async () => {
    const db = installDb(referenceField([ReferenceTargetSource.Issue]));

    await expect(
      referenceSearchService.searchTargets({
        fieldId: FIELD_ID,
        organizationId: ORG_ID,
        sources: [ReferenceTargetSource.Session],
      })
    ).rejects.toBeInstanceOf(DisallowedReferenceSourceError);

    // Silently intersecting would have produced an empty 200 from a real query;
    // proving no query ran is what separates rejection from filtering.
    expect(db.artifact.findMany).not.toHaveBeenCalled();
  });

  it("accepts a source the field does permit", async () => {
    const db = installDb(referenceField([ReferenceTargetSource.Issue]), []);

    await expect(
      referenceSearchService.searchTargets({
        fieldId: FIELD_ID,
        organizationId: ORG_ID,
        sources: [ReferenceTargetSource.Issue],
      })
    ).resolves.toEqual({ targets: [], hasMore: false });

    expect(db.artifact.findMany).toHaveBeenCalledTimes(1);
  });

  it("accepts a narrowing on an ARTIFACT-sourced field", async () => {
    const db = installDb(referenceField([ReferenceTargetSource.Artifact]), []);

    // ARTIFACT is a superset: the write path accepts an issue target on this
    // field, so literal set membership (`["ARTIFACT"].includes("ISSUE")`) would
    // refuse to search a population the very next save allows.
    await expect(
      referenceSearchService.searchTargets({
        fieldId: FIELD_ID,
        organizationId: ORG_ID,
        sources: [ReferenceTargetSource.Issue],
      })
    ).resolves.toEqual({ targets: [], hasMore: false });

    expect(db.artifact.findMany).toHaveBeenCalledTimes(1);
    // ...and it must narrow to issues, not silently widen back to everything.
    expect(db.artifact.findMany.mock.calls[0][0].where.AND).toContainEqual({
      OR: [
        {
          type: ArtifactType.DOCUMENT,
          subtype: { in: [ArtifactSubtype.FEATURE, ArtifactSubtype.ISSUE] },
        },
      ],
    });
  });

  it("rejects the whole request when only one of several sources is disallowed", async () => {
    installDb(referenceField([ReferenceTargetSource.Issue]));

    await expect(
      referenceSearchService.searchTargets({
        fieldId: FIELD_ID,
        organizationId: ORG_ID,
        sources: [ReferenceTargetSource.Issue, ReferenceTargetSource.Branch],
      })
    ).rejects.toBeInstanceOf(DisallowedReferenceSourceError);
  });

  it("rejects a field that holds no references at all", async () => {
    const db = installDb(referenceField([], CustomFieldType.Text));

    await expect(
      referenceSearchService.searchTargets({
        fieldId: FIELD_ID,
        organizationId: ORG_ID,
      })
    ).rejects.toBeInstanceOf(DisallowedReferenceSourceError);
    expect(db.artifact.findMany).not.toHaveBeenCalled();
  });

  it("reports an unknown field id as not found", async () => {
    installDb(null);

    await expect(
      referenceSearchService.searchTargets({
        fieldId: FIELD_ID,
        organizationId: ORG_ID,
      })
    ).rejects.toBeInstanceOf(ReferenceFieldNotFoundError);
  });

  it("scopes the field lookup to the caller's organization", async () => {
    const db = installDb(referenceField(), []);

    await referenceSearchService.searchTargets({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
    });

    expect(db.customField.findFirst.mock.calls[0][0].where).toEqual({
      id: FIELD_ID,
      organizationId: ORG_ID,
    });
  });

  it("searches nothing for a field that declares no sources", async () => {
    const db = installDb(referenceField([]));

    const result = await referenceSearchService.searchTargets({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
    });

    // Fails CLOSED: an undeclared field must not fall through to an unfiltered
    // read of every artifact in the organization.
    expect(result).toEqual({ targets: [], hasMore: false });
    expect(db.artifact.findMany).not.toHaveBeenCalled();
  });
});

describe("searchTargets result bounding", () => {
  it("caps the page and reports that more remain", async () => {
    const limit = 2;
    const db = installDb(
      referenceField(),
      [0, 1, 2].map((i) => artifactRow(i))
    );

    const result = await referenceSearchService.searchTargets({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
      limit,
    });

    expect(db.artifact.findMany.mock.calls[0][0].take).toBe(limit + 1);
    expect(result.targets).toHaveLength(limit);
    expect(result.hasMore).toBe(true);
  });

  it("reports an exhausted list when the page is not full", async () => {
    installDb(referenceField(), [artifactRow(0), artifactRow(1)]);

    const result = await referenceSearchService.searchTargets({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
      limit: 2,
    });

    // The sibling of the case above: a full page and an exhausted one must not
    // both read as "more results exist", or the picker can never say it is done.
    expect(result.targets).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  it("defaults the page size when the caller names none", async () => {
    const db = installDb(referenceField(), []);

    await referenceSearchService.searchTargets({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
    });

    expect(db.artifact.findMany.mock.calls[0][0].take).toBe(
      REFERENCE_SEARCH_DEFAULT_LIMIT + 1
    );
  });

  it("breaks ties on a stable key so the page boundary cannot drift", async () => {
    const db = installDb(referenceField(), []);

    await referenceSearchService.searchTargets({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
    });

    expect(db.artifact.findMany.mock.calls[0][0].orderBy).toEqual([
      { updatedAt: "desc" },
      { id: "asc" },
    ]);
  });
});

describe("searchTargets predicate", () => {
  it("matches the typed text against slug and name", async () => {
    const db = installDb(referenceField(), []);

    await referenceSearchService.searchTargets({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
      query: "grid table",
    });

    expect(db.artifact.findMany.mock.calls[0][0].where.AND).toContainEqual({
      OR: [
        { slug: { contains: "grid table", mode: "insensitive" } },
        { name: { contains: "grid table", mode: "insensitive" } },
      ],
    });
  });

  it("escapes LIKE metacharacters so a typed wildcard stays literal", async () => {
    const db = installDb(referenceField(), []);

    await referenceSearchService.searchTargets({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
      query: "100%_done",
    });

    const clause = textClause(db.artifact.findMany.mock.calls[0][0].where.AND);
    expect(clause?.OR[0].slug.contains).toBe(String.raw`100\%\_done`);
  });

  it("adds no text predicate for a whitespace-only query", async () => {
    const db = installDb(referenceField(), []);

    await referenceSearchService.searchTargets({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
      query: "   ",
    });

    expect(
      textClause(db.artifact.findMany.mock.calls[0][0].where.AND)
    ).toBeUndefined();
  });

  it("excludes the entity being edited when one is named", async () => {
    const owner = uuidForIndex(7);
    const db = installDb(referenceField(), []);

    await referenceSearchService.searchTargets({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
      excludeEntityId: owner,
    });

    expect(db.artifact.findMany.mock.calls[0][0].where.AND).toContainEqual({
      id: { not: owner },
    });
  });

  it("adds no exclusion when no entity is named", async () => {
    const db = installDb(referenceField(), []);

    await referenceSearchService.searchTargets({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
    });

    const and = db.artifact.findMany.mock.calls[0][0].where.AND;
    expect(and.some((entry: { id?: unknown }) => Boolean(entry.id))).toBe(
      false
    );
  });

  it("scopes every candidate read to the caller's organization", async () => {
    const db = installDb(referenceField(), []);

    await referenceSearchService.searchTargets({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
      query: "anything",
    });

    expect(db.artifact.findMany.mock.calls[0][0].where.organizationId).toBe(
      ORG_ID
    );
  });
});

describe("referenceSourceScope", () => {
  it("projects ISSUE onto both persisted subtype spellings", () => {
    // Written out rather than derived from the source table: the duplication is
    // what would catch that table being edited by accident.
    expect(referenceSourceScope([ReferenceTargetSource.Issue])).toEqual({
      kind: "SHAPES",
      where: {
        OR: [
          {
            type: ArtifactType.DOCUMENT,
            subtype: {
              in: [ArtifactSubtype.FEATURE, ArtifactSubtype.ISSUE],
            },
          },
        ],
      },
    });
  });

  it("projects SESSION and BRANCH onto a bare artifact type", () => {
    expect(
      referenceSourceScope([
        ReferenceTargetSource.Session,
        ReferenceTargetSource.Branch,
      ])
    ).toEqual({
      kind: "SHAPES",
      where: {
        OR: [{ type: ArtifactType.SESSION }, { type: ArtifactType.BRANCH }],
      },
    });
  });

  it("widens to every artifact only when ARTIFACT is declared", () => {
    expect(
      referenceSourceScope([
        ReferenceTargetSource.Issue,
        ReferenceTargetSource.Artifact,
      ])
    ).toEqual({ kind: "ALL" });
  });

  it("reaches nothing when no source is declared", () => {
    // The sibling of the case above, and the reason the two are a union rather
    // than a nullable `where`: both mean "no clause", for opposite reasons.
    expect(referenceSourceScope([])).toEqual({ kind: "NONE" });
  });
});
