/**
 * Unit tests for the customFieldValuesService VALUE lane —
 * setValueForEntity, getValuesForEntity, and clearValue.
 *
 * The settings lane (attach/detach/list) is covered in
 * values-service-settings.test.ts; both drive the shared db harness in
 * `@/__tests__/support/custom-fields/values-service.test-fixtures`.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
  },
}));

import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { withDb } from "@repo/database";
import {
  buildFieldRow,
  buildOption,
  buildValueRow,
  type DbMocks,
  installDb,
  TEST_ENTITY_ID,
  TEST_FIELD_ID,
  TEST_OPTION_ID,
  TEST_ORG_ID,
  upsertCreateArg,
} from "@/__tests__/support/custom-fields/values-service.test-fixtures";
import {
  EntityNotFoundError,
  FieldNotFoundError,
} from "../custom-field-errors";
import { InvalidFieldValueError } from "../utils";
import { customFieldValuesService } from "../values-service";

const mockWithDb = withDb as unknown as Mock;

/** Installs the shared db harness against this file's mocked `withDb`. */
function install(overrides: Partial<DbMocks> = {}): DbMocks {
  return installDb(mockWithDb, overrides);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// setValueForEntity — ENUM validation
// ---------------------------------------------------------------------------

describe("customFieldValuesService.setValueForEntity — ENUM validation", () => {
  it("throws when the enum option does not belong to the specified customFieldId (cross-field injection)", async () => {
    // The option row is looked up with customFieldId in the WHERE, so an option
    // borrowed from another field comes back null.
    install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(buildFieldRow({ fieldType: CustomFieldType.Enum })),
      enumOptionFindFirst: vi.fn().mockResolvedValue(null),
    });

    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        "opt-belongs-to-other-field"
      )
    ).rejects.toThrow(
      `Enum option "opt-belongs-to-other-field" not found for field "${TEST_FIELD_ID}"`
    );
  });

  it("throws when the enum option is disabled", async () => {
    install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(buildFieldRow({ fieldType: CustomFieldType.Enum })),
      enumOptionFindFirst: vi
        .fn()
        .mockResolvedValue(buildOption(TEST_OPTION_ID, { enabled: false })),
    });

    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        TEST_OPTION_ID
      )
    ).rejects.toThrow(
      `Enum option "${TEST_OPTION_ID}" is disabled and cannot be set`
    );
  });

  it("stores an enabled option id in the enum column", async () => {
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(buildFieldRow({ fieldType: CustomFieldType.Enum })),
      enumOptionFindFirst: vi
        .fn()
        .mockResolvedValue(buildOption(TEST_OPTION_ID)),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      TEST_OPTION_ID
    );

    expect(upsertCreateArg(mocks.valueUpsert).enumValueId).toBe(TEST_OPTION_ID);
  });
});

// ---------------------------------------------------------------------------
// setValueForEntity — typed column payloads
// ---------------------------------------------------------------------------

describe("customFieldValuesService.setValueForEntity — column payloads", () => {
  it("writes a TEXT value to textValue and leaves the other columns empty", async () => {
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(buildFieldRow({ fieldType: CustomFieldType.Text })),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      "hello"
    );

    expect(upsertCreateArg(mocks.valueUpsert)).toMatchObject({
      textValue: "hello",
      numberValue: null,
      dateValue: null,
      enumValueId: null,
      multiEnumValueIds: [],
      peopleValueIds: [],
    });
  });

  it("writes a NUMBER value to numberValue as a number, not a string", async () => {
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(
          buildFieldRow({ fieldType: CustomFieldType.Number })
        ),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      "42.5"
    );

    expect(upsertCreateArg(mocks.valueUpsert).numberValue).toBe(42.5);
  });

  it("refuses a NUMBER value that overflows to Infinity and writes nothing", async () => {
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(
          buildFieldRow({ fieldType: CustomFieldType.Number })
        ),
    });

    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        "1e400"
      )
    ).rejects.toThrow(InvalidFieldValueError);

    expect(mocks.valueUpsert).not.toHaveBeenCalled();
  });

  it("writes a negative NUMBER value unchanged", async () => {
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(
          buildFieldRow({ fieldType: CustomFieldType.Number })
        ),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      "-3"
    );

    expect(upsertCreateArg(mocks.valueUpsert).numberValue).toBe(-3);
  });

  it("writes a DATE value to dateValue as a Date instance", async () => {
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(buildFieldRow({ fieldType: CustomFieldType.Date })),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      "2026-08-07"
    );

    const dateValue = upsertCreateArg(mocks.valueUpsert).dateValue;
    expect(dateValue).toBeInstanceOf(Date);
    expect((dateValue as Date).toISOString()).toBe("2026-08-07T00:00:00.000Z");
  });

  it("clears every value column when the raw value is null", async () => {
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(buildFieldRow({ fieldType: CustomFieldType.Text })),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      null
    );

    expect(upsertCreateArg(mocks.valueUpsert)).toMatchObject({
      textValue: null,
      numberValue: null,
      dateValue: null,
      enumValueId: null,
      multiEnumValueIds: [],
      peopleValueIds: [],
      displayValue: "",
    });
  });

  it("keys the upsert on the field/entity pair and stamps the organization on create", async () => {
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(buildFieldRow({ fieldType: CustomFieldType.Text })),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      "hello"
    );

    const args = mocks.valueUpsert.mock.calls[0][0];
    expect(args.where).toEqual({
      customFieldId_entityType_entityId: {
        customFieldId: TEST_FIELD_ID,
        entityType: CustomFieldEntityType.Document,
        entityId: TEST_ENTITY_ID,
      },
    });
    expect(args.create.organizationId).toBe(TEST_ORG_ID);
    // The update arm must not try to move an existing row between organizations.
    expect(args.update).not.toHaveProperty("organizationId");
  });
});

// ---------------------------------------------------------------------------
// setValueForEntity — MULTI_ENUM validation
// ---------------------------------------------------------------------------

describe("customFieldValuesService.setValueForEntity — MULTI_ENUM validation", () => {
  function installMultiEnum(found: ReturnType<typeof buildOption>[]) {
    return install({
      customFieldFindFirst: vi.fn().mockResolvedValue(
        buildFieldRow({
          fieldType: CustomFieldType.MultiEnum,
          enumOptions: found,
        })
      ),
      enumOptionFindMany: vi.fn().mockResolvedValue(found),
    });
  }

  it("stores every requested option id when all exist and are enabled", async () => {
    const mocks = installMultiEnum([
      buildOption("opt-a"),
      buildOption("opt-b"),
    ]);

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      ["opt-a", "opt-b"]
    );

    expect(upsertCreateArg(mocks.valueUpsert).multiEnumValueIds).toEqual([
      "opt-a",
      "opt-b",
    ]);
  });

  it("names the missing option ids when one of them does not exist for the field", async () => {
    installMultiEnum([buildOption("opt-a")]);

    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        ["opt-a", "opt-ghost"]
      )
    ).rejects.toThrow(`Enum option(s) "opt-ghost" not found`);
  });

  it("rejects a disabled option and names which one", async () => {
    installMultiEnum([
      buildOption("opt-a"),
      buildOption("opt-off", { enabled: false }),
    ]);

    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        ["opt-a", "opt-off"]
      )
    ).rejects.toThrow(`Enum option "opt-off" is disabled and cannot be set`);
  });

  it("accepts a repeated option id and stores it once", async () => {
    // A repeated id is the only input for which the request array's length and
    // the `id: { in: ... }` row count legitimately disagree. Comparing those two
    // lengths directly made this valid request fail — and fail naming nothing,
    // because the set difference that builds the message is empty.
    const mocks = installMultiEnum([buildOption("opt-a")]);

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      ["opt-a", "opt-a"]
    );

    expect(upsertCreateArg(mocks.valueUpsert).multiEnumValueIds).toEqual([
      "opt-a",
    ]);
    expect(mocks.enumOptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["opt-a"] }, customFieldId: TEST_FIELD_ID },
      })
    );
  });

  it("derives the stored displayValue from the deduped ids, not the repeated request", async () => {
    // The stored ids and the display string are computed on separate paths, so
    // deduping only the ids left the row self-contradicting: one id alongside a
    // displayValue naming that option once per repeat.
    const mocks = installMultiEnum([buildOption("opt-a")]);

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      ["opt-a", "opt-a"]
    );

    const created = upsertCreateArg(mocks.valueUpsert);
    expect(created.displayValue).toBe("OPT-A");
    expect(mocks.valueUpsert.mock.calls[0][0].update.displayValue).toBe(
      "OPT-A"
    );
  });
});

// ---------------------------------------------------------------------------
// setValueForEntity — PEOPLE validation
// ---------------------------------------------------------------------------

describe("customFieldValuesService.setValueForEntity — PEOPLE validation", () => {
  const KNOWN_USER = {
    id: "user-known",
    email: "a@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    avatarUrl: null,
  };

  it("throws when one or more peopleValueIds do not belong to the organization", async () => {
    install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(
          buildFieldRow({ fieldType: CustomFieldType.People })
        ),
      userFindMany: vi.fn().mockResolvedValue([KNOWN_USER]),
    });

    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        ["user-known", "user-unknown"]
      )
    ).rejects.toThrow(
      "One or more user IDs are invalid or do not belong to this organization"
    );
  });

  it("accepts a repeated user id and stores it once", async () => {
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(
          buildFieldRow({ fieldType: CustomFieldType.People })
        ),
      userFindMany: vi.fn().mockResolvedValue([KNOWN_USER]),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      ["user-known", "user-known"]
    );

    expect(upsertCreateArg(mocks.valueUpsert).peopleValueIds).toEqual([
      "user-known",
    ]);
  });

  it("derives the stored displayValue from the deduped ids, not the repeated request", async () => {
    // ISS-7215 made `normalizeIdListValue`'s PEOPLE arm load-bearing: both the
    // cached sort key and the rendered string now walk the stored id array
    // through a keyed lookup, so a repeat left in place caches "Ada L., Ada L."
    // beside ONE stored id. The sibling case above asserts peopleValueIds only,
    // which stays green through exactly that mutation (marisolashgrove review, cid
    // 3911851210) — this is the assertion that kills it.
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(
          buildFieldRow({ fieldType: CustomFieldType.People })
        ),
      userFindMany: vi.fn().mockResolvedValue([KNOWN_USER]),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      ["user-known", "user-known"]
    );

    expect(upsertCreateArg(mocks.valueUpsert).displayValue).toBe("Ada L.");
    expect(mocks.valueUpsert.mock.calls[0][0].update.displayValue).toBe(
      "Ada L."
    );
  });

  it("scopes the people lookup to the organization", async () => {
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(
          buildFieldRow({ fieldType: CustomFieldType.People })
        ),
      userFindMany: vi.fn().mockResolvedValue([KNOWN_USER]),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      ["user-known"]
    );

    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["user-known"] }, organizationId: TEST_ORG_ID },
      })
    );
  });

  /**
   * A rename that commits BETWEEN validation and the upsert must not make the
   * write's own response report a name already superseded when it returned.
   *
   * `prepareValueWrite` resolves these users to validate them, and reusing that
   * map for the response is one query cheaper — but it is read before the
   * upsert, so the PUT echoed the pre-rename label while the very next GET,
   * live since ISS-7215, showed the new one, with no concurrent event between
   * the two to explain the disagreement (whitlockk review cid 3911294127).
   *
   * The two assertions are deliberately opposed, because passing both is what
   * distinguishes the fix from "the column got refreshed": the RESPONSE carries
   * the post-write name, and the CACHED column still carries the pre-write one.
   * Asserting only the first would also pass if the write had re-derived the
   * column, which is not what this does — the column stays the sort key.
   */
  it("renders the response from a people map re-read after the write, while the cached column keeps the pre-write string", async () => {
    const RENAMED_USER = { ...KNOWN_USER, lastName: "Byron" };
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(
          buildFieldRow({ fieldType: CustomFieldType.People })
        ),
      // Validation sees "Lovelace"; the post-write resolve sees the rename.
      userFindMany: vi
        .fn()
        .mockResolvedValueOnce([KNOWN_USER])
        .mockResolvedValue([RENAMED_USER]),
      valueUpsert: vi.fn().mockResolvedValue(
        buildValueRow({
          peopleValueIds: ["user-known"],
          displayValue: "Ada L.",
          customField: {
            id: TEST_FIELD_ID,
            name: "Owner",
            fieldType: CustomFieldType.People,
            showInTable: true,
            enumOptions: [],
          },
        })
      ),
    });

    const detail = await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      ["user-known"]
    );

    expect(detail.displayValue).toBe("Ada B.");
    expect(detail.peopleValues).toEqual([RENAMED_USER]);
    expect(upsertCreateArg(mocks.valueUpsert).displayValue).toBe("Ada L.");
  });
});

// ---------------------------------------------------------------------------
// setValueForEntity — entity and field org scoping
// ---------------------------------------------------------------------------

describe("customFieldValuesService.setValueForEntity — org scoping", () => {
  it("throws EntityNotFoundError and writes nothing when the document is in another org", async () => {
    const mocks = install({
      artifactFindFirst: vi.fn().mockResolvedValue(null),
    });

    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        "hello"
      )
    ).rejects.toThrow(EntityNotFoundError);

    expect(mocks.valueUpsert).not.toHaveBeenCalled();
  });

  it("throws FieldNotFoundError and writes nothing when the field is in another org", async () => {
    const mocks = install({
      customFieldFindFirst: vi.fn().mockResolvedValue(null),
    });

    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        "hello"
      )
    ).rejects.toThrow(FieldNotFoundError);

    expect(mocks.valueUpsert).not.toHaveBeenCalled();
  });

  it("resolves a Project entity against the project table, scoped to the org", async () => {
    const mocks = install({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(buildFieldRow({ fieldType: CustomFieldType.Text })),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Project,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      "hello"
    );

    expect(mocks.projectFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TEST_ENTITY_ID, organizationId: TEST_ORG_ID },
      })
    );
    expect(mocks.artifactFindFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getValuesForEntity
// ---------------------------------------------------------------------------

describe("customFieldValuesService.getValuesForEntity", () => {
  it("queries one entity id directly and a batch with an IN filter", async () => {
    const mocks = install();

    await customFieldValuesService.getValuesForEntity(
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID
    );
    expect(mocks.valueFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          entityType: CustomFieldEntityType.Document,
          entityId: TEST_ENTITY_ID,
          organizationId: TEST_ORG_ID,
          // FEA-4222 (davetho review cid 3884188153): the predicate widened
          // DELIBERATELY. The read now also requires the DEFINITION to declare
          // this entity type, so a value stored against an inapplicable field
          // before that guard existed stays quarantined instead of surfacing
          // the moment an admin attaches the field. Empty `entityTypes` is the
          // legacy "unscoped field" case and is still readable — the same
          // carve-out `assertFieldAppliesToEntityType` makes on the write side.
          customField: {
            OR: [
              { entityTypes: { has: CustomFieldEntityType.Document } },
              { entityTypes: { isEmpty: true } },
            ],
          },
        },
      })
    );

    await customFieldValuesService.getValuesForEntity(
      CustomFieldEntityType.Document,
      ["doc-1", "doc-2"],
      TEST_ORG_ID
    );
    expect(mocks.valueFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          entityType: CustomFieldEntityType.Document,
          entityId: { in: ["doc-1", "doc-2"] },
          organizationId: TEST_ORG_ID,
          // FEA-4222 (davetho review cid 3884188153): the predicate widened
          // DELIBERATELY. The read now also requires the DEFINITION to declare
          // this entity type, so a value stored against an inapplicable field
          // before that guard existed stays quarantined instead of surfacing
          // the moment an admin attaches the field. Empty `entityTypes` is the
          // legacy "unscoped field" case and is still readable — the same
          // carve-out `assertFieldAppliesToEntityType` makes on the write side.
          customField: {
            OR: [
              { entityTypes: { has: CustomFieldEntityType.Document } },
              { entityTypes: { isEmpty: true } },
            ],
          },
        },
      })
    );
  });

  it("batch-fetches the union of people ids across rows in a single query", async () => {
    const mocks = install({
      valueFindMany: vi
        .fn()
        .mockResolvedValue([
          buildValueRow({ id: "cfv-1", peopleValueIds: ["u1", "u2"] }),
          buildValueRow({ id: "cfv-2", peopleValueIds: ["u2", "u3"] }),
        ]),
      userFindMany: vi.fn().mockResolvedValue([]),
    });

    await customFieldValuesService.getValuesForEntity(
      CustomFieldEntityType.Document,
      ["doc-1", "doc-2"],
      TEST_ORG_ID
    );

    expect(mocks.userFindMany).toHaveBeenCalledOnce();
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["u1", "u2", "u3"] }, organizationId: TEST_ORG_ID },
      })
    );
  });

  it("skips the people query entirely when no row carries a people value", async () => {
    const mocks = install({
      valueFindMany: vi.fn().mockResolvedValue([buildValueRow()]),
    });

    await customFieldValuesService.getValuesForEntity(
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID
    );

    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it("resolves multiEnumValues from the field's options and drops ids the field no longer defines", async () => {
    install({
      valueFindMany: vi.fn().mockResolvedValue([
        buildValueRow({
          multiEnumValueIds: ["opt-a", "opt-deleted"],
          customField: {
            id: TEST_FIELD_ID,
            name: "Tags",
            fieldType: CustomFieldType.MultiEnum,
            showInTable: true,
            enumOptions: [buildOption("opt-a"), buildOption("opt-unselected")],
          },
        }),
      ]),
    });

    const [detail] = await customFieldValuesService.getValuesForEntity(
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID
    );

    expect(detail.multiEnumValues.map((option) => option.id)).toEqual([
      "opt-a",
    ]);
  });
});

// ---------------------------------------------------------------------------
// clearValue
// ---------------------------------------------------------------------------

describe("customFieldValuesService.clearValue", () => {
  it("scopes the delete to the organization", async () => {
    const mocks = install();

    await customFieldValuesService.clearValue(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID
    );

    expect(mocks.valueDeleteMany).toHaveBeenCalledWith({
      where: {
        customFieldId: TEST_FIELD_ID,
        entityType: CustomFieldEntityType.Document,
        entityId: TEST_ENTITY_ID,
        organizationId: TEST_ORG_ID,
      },
    });
  });
});
