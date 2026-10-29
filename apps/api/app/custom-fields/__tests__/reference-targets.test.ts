/**
 * Unit coverage for the reference-target contract (ISS-7208) and the
 * per-field-type display-value rule (ISS-7214).
 *
 * The source → artifact predicate table and the caching rule are both declared
 * once and consumed by the write and read paths; these tests pin the decisions
 * those tables encode. Behaviour that only Postgres can enforce (the FK cascade)
 * is covered in `reference-values.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
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
  DISPLAY_VALUE_STRATEGY,
  DisplayValueStrategy,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import {
  InvalidReferenceTargetError,
  isReferenceFieldType,
  MAX_REFERENCE_TARGETS,
  normalizeReferenceIds,
  replaceReferenceRows,
  resolveAndValidateReferenceTargets,
  toReferenceTargets,
} from "../reference-targets";

const mockWithDb = withDb as unknown as Mock;

const ORG_ID = "org-1";
const OWNER_ID = "owner-1";

/** Well-formed uuids, so id-format rejection can never stand in for the check under test. */
const TARGET_A = "11111111-1111-4111-8111-111111111111";
const TARGET_B = "22222222-2222-4222-8222-222222222222";

/** Distinguishes the cardinality/cap rejections from the id-format one. */
const CARDINALITY_ERROR_RE = /expected a single target/;
const CAP_ERROR_RE = /exceeds the maximum/;

/** A distinct well-formed uuid per index, for bulk cardinality fixtures. */
function uuidForIndex(index: number): string {
  return `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

type ArtifactRow = {
  id: string;
  slug: string | null;
  name: string;
  type: ArtifactType;
  subtype: ArtifactSubtype | null;
  status: string;
};

function artifactRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "target-1",
    slug: "ISS-1",
    name: "An issue",
    type: ArtifactType.DOCUMENT,
    subtype: ArtifactSubtype.FEATURE,
    status: "TODO",
    ...overrides,
  };
}

/**
 * Installs a `withDb` whose `findMany` applies Prisma's own `where` semantics
 * against `rows`.
 *
 * It filters on what the service actually put in the `where` — NOT on an
 * `organizationId` argument handed to the fake. A fake that returned `rows`
 * regardless of the query would stay green after the org predicate was deleted
 * from production, which is the false-green `apps/api/AGENTS.md` names.
 */
function installArtifacts(rows: ArtifactRow[], seededOrgId = ORG_ID) {
  lastFindManyArgs = null;
  mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      artifact: {
        findMany: (args: FindManyArgs) => {
          lastFindManyArgs = args;
          const where = args?.where ?? {};
          const ids = where.id?.in;
          return Promise.resolve(
            rows.filter((row) => {
              // An absent key constrains nothing — Prisma's semantics.
              const idOk = ids === undefined || ids.includes(row.id);
              const orgOk =
                where.organizationId === undefined ||
                where.organizationId === seededOrgId;
              return idOk && orgOk;
            })
          );
        },
      },
    })
  );
}

type FindManyArgs = {
  where?: { id?: { in?: string[] }; organizationId?: string };
};

let lastFindManyArgs: FindManyArgs | null = null;

function field(sources: ReferenceTargetSource[]) {
  return {
    id: "field-1",
    name: "Parent artifact",
    fieldType: CustomFieldType.Reference,
    referenceTargetSources: sources,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isReferenceFieldType", () => {
  it("classifies exactly the two reference types", () => {
    expect(isReferenceFieldType(CustomFieldType.Reference)).toBe(true);
    expect(isReferenceFieldType(CustomFieldType.ReferenceMulti)).toBe(true);
    expect(isReferenceFieldType(CustomFieldType.Text)).toBe(false);
    expect(isReferenceFieldType(CustomFieldType.People)).toBe(false);
  });
});

describe("normalizeReferenceIds — cardinality", () => {
  it("accepts one target on a REFERENCE field", () => {
    expect(normalizeReferenceIds(CustomFieldType.Reference, TARGET_A)).toEqual([
      TARGET_A,
    ]);
  });

  it("rejects two targets on a REFERENCE field", () => {
    expect(() =>
      normalizeReferenceIds(CustomFieldType.Reference, [TARGET_A, TARGET_B])
    ).toThrow(CARDINALITY_ERROR_RE);
  });

  it("accepts many targets on a REFERENCE_MULTI field", () => {
    expect(
      normalizeReferenceIds(CustomFieldType.ReferenceMulti, [
        TARGET_A,
        TARGET_B,
      ])
    ).toEqual([TARGET_A, TARGET_B]);
  });

  it("de-duplicates repeated targets rather than storing the pair twice", () => {
    expect(
      normalizeReferenceIds(CustomFieldType.ReferenceMulti, [
        TARGET_A,
        TARGET_A,
        TARGET_B,
      ])
    ).toEqual([TARGET_A, TARGET_B]);
  });

  it("rejects more targets than the cap", () => {
    // Every id here is a WELL-FORMED uuid, so the cap is the only thing that
    // can reject this list. Built from `id-${i}` it would throw on the id
    // format instead and pass without the cap ever being consulted.
    const tooMany = Array.from({ length: MAX_REFERENCE_TARGETS + 1 }, (_, i) =>
      uuidForIndex(i)
    );
    expect(() =>
      normalizeReferenceIds(CustomFieldType.ReferenceMulti, tooMany)
    ).toThrow(CAP_ERROR_RE);
  });

  it("stays under the cap at exactly the maximum", () => {
    const atCap = Array.from({ length: MAX_REFERENCE_TARGETS }, (_, i) =>
      uuidForIndex(i)
    );
    expect(
      normalizeReferenceIds(CustomFieldType.ReferenceMulti, atCap)
    ).toHaveLength(MAX_REFERENCE_TARGETS);
  });

  it("rejects a blank target id", () => {
    expect(() =>
      normalizeReferenceIds(CustomFieldType.ReferenceMulti, ["  "])
    ).toThrow(InvalidReferenceTargetError);
  });

  // `artifacts.id` is a Postgres `uuid` column: a malformed literal fails in
  // the driver, so an unchecked id reaches the route as a 500 rather than the
  // declared 400. Rejecting it here is what keeps it a caller error.
  it.each(["not-a-uuid", "12345", `${TARGET_A}-extra`, "'; DROP TABLE --"])(
    "rejects the non-uuid target id %j before any query runs",
    (badId) => {
      expect(() =>
        normalizeReferenceIds(CustomFieldType.ReferenceMulti, [badId])
      ).toThrow(InvalidReferenceTargetError);
      expect(mockWithDb).not.toHaveBeenCalled();
    }
  );

  it("still accepts an upper-case uuid", () => {
    const upper = TARGET_A.toUpperCase();
    expect(normalizeReferenceIds(CustomFieldType.Reference, upper)).toEqual([
      upper,
    ]);
  });
});

describe("resolveAndValidateReferenceTargets — the source contract", () => {
  it("accepts a FEATURE-subtyped document for an Issues-sourced field", async () => {
    installArtifacts([artifactRow()]);
    await expect(
      resolveAndValidateReferenceTargets(
        field([ReferenceTargetSource.Issue]),
        ["target-1"],
        ORG_ID,
        OWNER_ID
      )
    ).resolves.toHaveLength(1);
  });

  it("accepts an ISSUE-subtyped document for an Issues-sourced field", async () => {
    // The DB enum accepts ISSUE from a skewed newer client (FEA-3956); a
    // predicate that matched only FEATURE would reject a legitimate target.
    installArtifacts([artifactRow({ subtype: ArtifactSubtype.ISSUE })]);
    await expect(
      resolveAndValidateReferenceTargets(
        field([ReferenceTargetSource.Issue]),
        ["target-1"],
        ORG_ID,
        OWNER_ID
      )
    ).resolves.toHaveLength(1);
  });

  it("rejects a SESSION for an Issues-sourced field", async () => {
    installArtifacts([
      artifactRow({ type: ArtifactType.SESSION, subtype: null }),
    ]);
    await expect(
      resolveAndValidateReferenceTargets(
        field([ReferenceTargetSource.Issue]),
        ["target-1"],
        ORG_ID,
        OWNER_ID
      )
    ).rejects.toBeInstanceOf(InvalidReferenceTargetError);
  });

  it("rejects a PRD for an Issues-sourced field", async () => {
    installArtifacts([artifactRow({ subtype: ArtifactSubtype.PRD })]);
    await expect(
      resolveAndValidateReferenceTargets(
        field([ReferenceTargetSource.Issue]),
        ["target-1"],
        ORG_ID,
        OWNER_ID
      )
    ).rejects.toBeInstanceOf(InvalidReferenceTargetError);
  });

  it("accepts a SESSION for a Sessions-sourced field", async () => {
    installArtifacts([
      artifactRow({ type: ArtifactType.SESSION, subtype: null }),
    ]);
    await expect(
      resolveAndValidateReferenceTargets(
        field([ReferenceTargetSource.Session]),
        ["target-1"],
        ORG_ID,
        OWNER_ID
      )
    ).resolves.toHaveLength(1);
  });

  it("accepts a BRANCH for a Branches-sourced field", async () => {
    installArtifacts([
      artifactRow({ type: ArtifactType.BRANCH, subtype: null }),
    ]);
    await expect(
      resolveAndValidateReferenceTargets(
        field([ReferenceTargetSource.Branch]),
        ["target-1"],
        ORG_ID,
        OWNER_ID
      )
    ).resolves.toHaveLength(1);
  });

  it("accepts any artifact kind for an Artifacts-sourced field", async () => {
    installArtifacts([
      artifactRow({ type: ArtifactType.DEPLOYMENT, subtype: null }),
    ]);
    await expect(
      resolveAndValidateReferenceTargets(
        field([ReferenceTargetSource.Artifact]),
        ["target-1"],
        ORG_ID,
        OWNER_ID
      )
    ).resolves.toHaveLength(1);
  });

  it("rejects an id that matches no artifact at all", async () => {
    installArtifacts([]);
    await expect(
      resolveAndValidateReferenceTargets(
        field([ReferenceTargetSource.Artifact]),
        ["target-1"],
        ORG_ID,
        OWNER_ID
      )
    ).rejects.toBeInstanceOf(InvalidReferenceTargetError);
  });

  it("rejects an artifact that exists only in another organization", async () => {
    // The row exists, but under a different org. This fails ONLY because the
    // service put `organizationId` in the `where` — delete that predicate from
    // production and the fake returns the row and this test goes red.
    installArtifacts([artifactRow()], "other-org");

    await expect(
      resolveAndValidateReferenceTargets(
        field([ReferenceTargetSource.Artifact]),
        ["target-1"],
        ORG_ID,
        OWNER_ID
      )
    ).rejects.toBeInstanceOf(InvalidReferenceTargetError);
  });

  it("scopes the target lookup to the caller's organization", async () => {
    installArtifacts([artifactRow()]);
    await resolveAndValidateReferenceTargets(
      field([ReferenceTargetSource.Artifact]),
      ["target-1"],
      ORG_ID,
      OWNER_ID
    );
    expect(lastFindManyArgs?.where?.organizationId).toBe(ORG_ID);
  });

  it("rejects every target when the field declares no sources", async () => {
    // Fail-closed: a sourceless reference field must not accept everything.
    installArtifacts([artifactRow()]);
    await expect(
      resolveAndValidateReferenceTargets(
        field([]),
        ["target-1"],
        ORG_ID,
        OWNER_ID
      )
    ).rejects.toBeInstanceOf(InvalidReferenceTargetError);
  });

  it("rejects a target equal to the entity that owns the value", async () => {
    installArtifacts([artifactRow({ id: OWNER_ID })]);
    await expect(
      resolveAndValidateReferenceTargets(
        field([ReferenceTargetSource.Artifact]),
        [OWNER_ID],
        ORG_ID,
        OWNER_ID
      )
    ).rejects.toBeInstanceOf(InvalidReferenceTargetError);
  });

  it("returns targets in the caller's order so sortOrder can be persisted", async () => {
    installArtifacts([
      artifactRow({ id: "b", slug: "ISS-B" }),
      artifactRow({ id: "a", slug: "ISS-A" }),
    ]);
    const resolved = await resolveAndValidateReferenceTargets(
      field([ReferenceTargetSource.Artifact]),
      ["a", "b"],
      ORG_ID,
      OWNER_ID
    );
    expect(resolved.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("DISPLAY_VALUE_STRATEGY — the caching rule (ISS-7214)", () => {
  it("resolves reference types on read and caches every other type", () => {
    expect(DISPLAY_VALUE_STRATEGY[CustomFieldType.Reference]).toBe(
      DisplayValueStrategy.ResolvedOnRead
    );
    expect(DISPLAY_VALUE_STRATEGY[CustomFieldType.ReferenceMulti]).toBe(
      DisplayValueStrategy.ResolvedOnRead
    );
    for (const cached of [
      CustomFieldType.Text,
      CustomFieldType.Number,
      CustomFieldType.Enum,
      CustomFieldType.MultiEnum,
      CustomFieldType.Date,
    ]) {
      expect(DISPLAY_VALUE_STRATEGY[cached]).toBe(
        DisplayValueStrategy.CachedOnWrite
      );
    }
  });

  it("resolves PEOPLE on read too, since ISS-7215 flipped it", () => {
    // ISS-7214 pinned this as CachedOnWrite and named ISS-7215 as the owner of
    // flipping it, so that widening the reference fix into PEOPLE could not
    // happen silently. ISS-7215 is that change; the assertion is inverted, not
    // dropped, so flipping it BACK still cannot happen silently either.
    //
    // Unlike the reference types, PEOPLE still WRITES `display_value` — the
    // column is its sort key. `display-value.test.ts` pins that distinction.
    expect(DISPLAY_VALUE_STRATEGY[CustomFieldType.People]).toBe(
      DisplayValueStrategy.ResolvedOnRead
    );
  });
});

describe("toReferenceTargets", () => {
  it("folds a persisted ISSUE subtype to the API's FEATURE spelling", () => {
    expect(
      toReferenceTargets([artifactRow({ subtype: ArtifactSubtype.ISSUE })])[0]
        .subtype
    ).toBe("FEATURE");
  });

  it("carries the fields a reference chip needs beyond a display string", () => {
    expect(toReferenceTargets([artifactRow()])[0]).toEqual({
      id: "target-1",
      slug: "ISS-1",
      name: "An issue",
      artifactType: ArtifactType.DOCUMENT,
      subtype: ArtifactSubtype.FEATURE,
      status: "TODO",
    });
  });
});

/**
 * The write path validates its targets with a `findMany` inside the same
 * transaction as the insert, but at READ COMMITTED that read takes no share
 * lock, so a DELETE of a target artifact can commit in between and the foreign
 * key rejects the insert with P2003. Unmapped, that reaches the route as a raw
 * 500 for what is a caller naming a target that no longer exists.
 */
describe("replaceReferenceRows — the check-to-insert race", () => {
  function fakeTx(createManyImpl: () => Promise<unknown>) {
    return {
      customFieldValueReference: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn(createManyImpl),
      },
    };
  }

  function prismaError(code: string): Error & { code: string } {
    return Object.assign(new Error(`Prisma error ${code}`), { code });
  }

  it("reports a target deleted mid-write as a caller error, not a server fault", async () => {
    const tx = fakeTx(() => Promise.reject(prismaError("P2003")));

    await expect(
      replaceReferenceRows(tx, "value-1", [TARGET_A])
    ).rejects.toBeInstanceOf(InvalidReferenceTargetError);
  });

  it("does not disguise an unrelated Prisma failure as a caller error", async () => {
    // P2024 is a connection-pool timeout — a server fault. Mapping every
    // failure here would turn a real outage into a 400 the caller cannot act on.
    const poolTimeout = prismaError("P2024");
    const tx = fakeTx(() => Promise.reject(poolTimeout));

    await expect(replaceReferenceRows(tx, "value-1", [TARGET_A])).rejects.toBe(
      poolTimeout
    );
  });

  it("clears the previous rows and writes the new ones in order", async () => {
    const tx = fakeTx(() => Promise.resolve({ count: 2 }));

    await replaceReferenceRows(tx, "value-1", [TARGET_B, TARGET_A]);

    expect(tx.customFieldValueReference.deleteMany).toHaveBeenCalledWith({
      where: { customFieldValueId: "value-1" },
    });
    expect(tx.customFieldValueReference.createMany).toHaveBeenCalledWith({
      data: [
        {
          customFieldValueId: "value-1",
          targetArtifactId: TARGET_B,
          sortOrder: 0,
        },
        {
          customFieldValueId: "value-1",
          targetArtifactId: TARGET_A,
          sortOrder: 1,
        },
      ],
    });
  });

  it("clears without inserting when the value is emptied", async () => {
    const tx = fakeTx(() => Promise.resolve({ count: 0 }));

    await replaceReferenceRows(tx, "value-1", []);

    expect(tx.customFieldValueReference.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.customFieldValueReference.createMany).not.toHaveBeenCalled();
  });
});
