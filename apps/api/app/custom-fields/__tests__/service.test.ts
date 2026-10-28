/**
 * Unit tests for customFieldsService.
 *
 * Covers multi-tenant scoping on every read and write, the in-transaction field
 * limit and reserved-name guards, inline enum-option creation, and the explicit
 * delete cascade that stands in for the DB-level one relationMode=prisma omits.
 *
 * `../utils` is deliberately NOT mocked: the reserved-name guard is one of the
 * behaviors under test, and a partial module mock would leave it undefined —
 * green whether or not the service ever calls it.
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

const { mockWithDb, mockWithDbTx } = vi.hoisted(() => {
  const tx =
    vi.fn<
      (callback: (client: unknown) => unknown, options?: unknown) => unknown
    >();
  return {
    mockWithDb: Object.assign(
      vi.fn<(callback: (client: unknown) => unknown) => unknown>(),
      { tx }
    ),
    mockWithDbTx: tx,
  };
});

vi.mock("@repo/database", () => ({
  withDb: mockWithDb,
  Prisma: {
    // Capture tagged-template parts so the set-based displayValue rewrite is
    // assertable — `values` holds the bound parameters in source order.
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (parts: unknown[]) => ({ __join: parts }),
  },
}));

import {
  CustomFieldEntityType,
  CustomFieldType,
  MAX_CUSTOM_FIELDS_PER_ORG,
  NumberFormat,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { CustomFieldFilterOperator } from "@repo/api/src/types/custom-field-list-query";
import {
  customFieldsService,
  DELETE_FIELD_TX_OPTIONS,
  DuplicateNameError,
  IncompatibleNumberFormatError,
  IncompatibleReferenceSourcesError,
} from "../service";
import { ReservedNameError } from "../utils";

/** Top-level regex for the duplicate name check — avoids lint/performance/useTopLevelRegex. */
const BUDGET_NAME_REGEX = /Budget/;

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_ORG_ID = "org-111";
const TEST_FIELD_ID = "field-abc";
const OTHER_ORG_ID = "org-999";

const MOCK_FIELD_ROW = {
  id: TEST_FIELD_ID,
  organizationId: TEST_ORG_ID,
  name: "Priority",
  description: null,
  fieldType: CustomFieldType.Enum,
  createdById: "user-1",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-02"),
  precision: null,
  numberFormat: null,
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  isGlobalToOrg: false,
  enumOptions: [],
};

// ---------------------------------------------------------------------------

describe("customFieldsService.findById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when the field belongs to a different organization", async () => {
    // Arrange — Prisma findFirst returns null because org mismatch is enforced in WHERE
    mockWithDb.mockImplementation((callback) =>
      callback({
        customField: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );

    // Act
    const result = await customFieldsService.findById(
      TEST_FIELD_ID,
      OTHER_ORG_ID
    );

    // Assert
    expect(result).toBeNull();
  });

  it("returns the field when organizationId matches", async () => {
    // Arrange
    mockWithDb.mockImplementation((callback) =>
      callback({
        customField: {
          findFirst: vi.fn().mockResolvedValue(MOCK_FIELD_ROW),
        },
      })
    );

    // Act
    const result = await customFieldsService.findById(
      TEST_FIELD_ID,
      TEST_ORG_ID
    );

    // Assert
    expect(result).not.toBeNull();
    expect(result?.id).toBe(TEST_FIELD_ID);
    expect(result?.organizationId).toBe(TEST_ORG_ID);
  });

  it("scopes the WHERE clause to the provided organizationId", async () => {
    // Arrange
    const mockFindFirst = vi.fn().mockResolvedValue(null);
    mockWithDb.mockImplementation((callback) =>
      callback({ customField: { findFirst: mockFindFirst } })
    );

    // Act
    await customFieldsService.findById(TEST_FIELD_ID, OTHER_ORG_ID);

    // Assert — the query must include both id and organizationId in WHERE
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TEST_FIELD_ID, organizationId: OTHER_ORG_ID },
      })
    );
  });
});

// ---------------------------------------------------------------------------

describe("customFieldsService.createField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws DuplicateNameError when Prisma returns a P2002 unique violation", async () => {
    // Arrange — withDb.tx must be stubbed to simulate the transaction throwing P2002
    const p2002Error = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    });

    mockWithDbTx.mockRejectedValue(p2002Error);

    // Act & Assert
    await expect(
      customFieldsService.createField(TEST_ORG_ID, "user-1", {
        name: "Priority",
        fieldType: CustomFieldType.Enum,
      })
    ).rejects.toThrow(DuplicateNameError);
  });

  it("throws DuplicateNameError with the conflicting field name in the message", async () => {
    // Arrange
    const p2002Error = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    });

    mockWithDbTx.mockRejectedValue(p2002Error);

    // Act & Assert
    await expect(
      customFieldsService.createField(TEST_ORG_ID, "user-1", {
        name: "Budget",
        fieldType: CustomFieldType.Number,
      })
    ).rejects.toThrow(BUDGET_NAME_REGEX);
  });

  it("re-throws non-P2002 errors unchanged", async () => {
    // Arrange
    const dbError = new Error("Connection timeout");
    mockWithDbTx.mockRejectedValue(dbError);

    // Act & Assert
    await expect(
      customFieldsService.createField(TEST_ORG_ID, "user-1", {
        name: "Status",
        fieldType: CustomFieldType.Enum,
      })
    ).rejects.toThrow("Connection timeout");
  });
});

// ---------------------------------------------------------------------------
// createField — limit, reserved names, inline enum options
// ---------------------------------------------------------------------------

/** Installs a `withDb.tx` double and returns the tx delegate mocks. */
function installTx(count: number, created: Record<string, unknown>) {
  const txCount = vi.fn().mockResolvedValue(count);
  const txCreate = vi.fn().mockResolvedValue(created);
  mockWithDbTx.mockImplementation((callback) =>
    callback({
      customField: { count: txCount, create: txCreate },
    })
  );
  return { txCount, txCreate };
}

/** Builds the Prisma row shape createField/updateField return. */
function buildCreatedRow(overrides: Record<string, unknown> = {}) {
  return {
    ...MOCK_FIELD_ROW,
    showInTable: true,
    isSearchable: false,
    isSortable: false,
    entityTypes: [],
    ...overrides,
  };
}

describe("customFieldsService.createField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to create past the per-org field cap and never issues the insert", async () => {
    const { txCreate } = installTx(
      MAX_CUSTOM_FIELDS_PER_ORG,
      buildCreatedRow()
    );

    await expect(
      customFieldsService.createField(TEST_ORG_ID, "user-1", {
        name: "Overflow",
        fieldType: CustomFieldType.Text,
      })
    ).rejects.toThrow(
      `maximum of ${MAX_CUSTOM_FIELDS_PER_ORG} custom field definitions`
    );

    expect(txCreate).not.toHaveBeenCalled();
  });

  it("issues the cap count before the insert, on the transaction client handed to the callback", async () => {
    // Scope, deliberately: this proves ordering on one transaction client, and
    // nothing more. It is NOT evidence the cap is race-free — withDb.tx runs at
    // the database default (READ COMMITTED) with no schema constraint behind the
    // guard, so two requests at the boundary can both count and both insert. A
    // single mocked transaction cannot express two concurrent ones, so this test
    // could never fail on that race. Serializing the check, and the concurrent
    // DB test that would cover it, are tracked in ISS-6389.
    const { txCount, txCreate } = installTx(0, buildCreatedRow());

    await customFieldsService.createField(TEST_ORG_ID, "user-1", {
      name: "Budget",
      fieldType: CustomFieldType.Number,
    });

    expect(txCount).toHaveBeenCalledWith({
      where: { organizationId: TEST_ORG_ID },
    });
    expect(txCount).toHaveBeenCalledBefore(txCreate);
  });

  it("stamps the organization and author onto the created row", async () => {
    const { txCreate } = installTx(0, buildCreatedRow());

    await customFieldsService.createField(TEST_ORG_ID, "user-42", {
      name: "Budget",
      fieldType: CustomFieldType.Number,
    });

    expect(txCreate.mock.calls[0][0].data).toMatchObject({
      organizationId: TEST_ORG_ID,
      createdById: "user-42",
      name: "Budget",
    });
  });

  it("creates enum options inline, defaulting color, enabled, and sortOrder", async () => {
    const { txCreate } = installTx(0, buildCreatedRow());

    await customFieldsService.createField(TEST_ORG_ID, "user-1", {
      name: "Stage",
      fieldType: CustomFieldType.Enum,
      // Two options omit sortOrder so the default is the option's own index,
      // not a constant that a zeroth-position fixture could not tell apart.
      enumOptions: [
        { name: "Draft" },
        { name: "Review" },
        { name: "Live", sortOrder: 9 },
      ],
    });

    expect(txCreate.mock.calls[0][0].data.enumOptions.create).toEqual([
      { name: "Draft", color: "none", enabled: true, sortOrder: 0 },
      { name: "Review", color: "none", enabled: true, sortOrder: 1 },
      { name: "Live", color: "none", enabled: true, sortOrder: 9 },
    ]);
  });

  it("omits the enumOptions relation entirely when none were supplied", async () => {
    const { txCreate } = installTx(0, buildCreatedRow());

    await customFieldsService.createField(TEST_ORG_ID, "user-1", {
      name: "Notes",
      fieldType: CustomFieldType.Text,
      enumOptions: [],
    });

    expect(txCreate.mock.calls[0][0].data).not.toHaveProperty("enumOptions");
  });

  it("rejects a name that collides with a built-in property of a target entity", async () => {
    const { txCreate } = installTx(0, buildCreatedRow());

    await expect(
      customFieldsService.createField(TEST_ORG_ID, "user-1", {
        name: "Priority",
        fieldType: CustomFieldType.Text,
        entityTypes: [CustomFieldEntityType.Project],
      })
    ).rejects.toThrow(ReservedNameError);

    expect(txCreate).not.toHaveBeenCalled();
  });

  it("allows a reserved name when the field targets no entity type", async () => {
    const { txCreate } = installTx(0, buildCreatedRow());

    await customFieldsService.createField(TEST_ORG_ID, "user-1", {
      name: "Priority",
      fieldType: CustomFieldType.Text,
      entityTypes: [],
    });

    expect(txCreate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// findByOrg
// ---------------------------------------------------------------------------

describe("customFieldsService.findByOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scopes to the organization and returns fields oldest-first", async () => {
    const findMany = vi.fn().mockResolvedValue([buildCreatedRow()]);
    mockWithDb.mockImplementation((callback) =>
      callback({ customField: { findMany } })
    );

    const result = await customFieldsService.findByOrg(TEST_ORG_ID);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: TEST_ORG_ID },
        orderBy: { createdAt: "asc" },
      })
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(TEST_FIELD_ID);
  });

  it("publishes the filter operators this server serves on each field (ISS-9481)", async () => {
    // Listed here rather than derived from the capability table, which would
    // agree with the response however wrong the table became.
    const findMany = vi.fn().mockResolvedValue([buildCreatedRow()]);
    mockWithDb.mockImplementation((callback) =>
      callback({ customField: { findMany } })
    );

    const [field] = await customFieldsService.findByOrg(TEST_ORG_ID);

    expect([...(field.filterOperators ?? [])].sort()).toEqual([
      CustomFieldFilterOperator.IsAnyOf,
      CustomFieldFilterOperator.IsEmpty,
      CustomFieldFilterOperator.IsNotEmpty,
    ]);
  });
});

// ---------------------------------------------------------------------------
// updateField
// ---------------------------------------------------------------------------

describe("customFieldsService.updateField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Installs a tx double for the update path and returns its delegate mocks. */
  function installUpdateTx(existing: Record<string, unknown> | null) {
    const txFindFirst = vi.fn().mockResolvedValue(existing);
    const txUpdate = vi.fn().mockResolvedValue(buildCreatedRow());
    mockWithDbTx.mockImplementation((callback) =>
      callback({
        customField: { findFirst: txFindFirst, update: txUpdate },
      })
    );
    return { txFindFirst, txUpdate };
  }

  it("scopes the update to the organization", async () => {
    const { txUpdate } = installUpdateTx(null);

    await customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
      showInTable: true,
    });

    expect(txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TEST_FIELD_ID, organizationId: TEST_ORG_ID },
      })
    );
  });

  /**
   * Installs a tx double for a `numberFormat` transition on a NUMBER field.
   *
   * `findMany` returns REAL rows on purpose: an empty result would let the
   * rewrite no-op and every assertion below would pass without the production
   * loop ever running.
   */
  function installFormatTransitionTx(
    storedNumbers: number[],
    nextFormat: NumberFormat
  ) {
    const txFindFirst = vi.fn().mockResolvedValue({
      name: "Elapsed",
      entityTypes: [],
      numberFormat: NumberFormat.None,
    });
    const txUpdate = vi.fn().mockResolvedValue(
      buildCreatedRow({
        fieldType: CustomFieldType.Number,
        numberFormat: nextFormat,
      })
    );
    const valueFindMany = vi
      .fn()
      .mockResolvedValue(storedNumbers.map((numberValue) => ({ numberValue })));
    const valueUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const executeRaw = vi.fn().mockResolvedValue(storedNumbers.length);
    mockWithDbTx.mockImplementation((callback) =>
      callback({
        customField: { findFirst: txFindFirst, update: txUpdate },
        customFieldValue: {
          findMany: valueFindMany,
          updateMany: valueUpdateMany,
        },
        $executeRaw: executeRaw,
      })
    );
    return { txUpdate, valueFindMany, valueUpdateMany, executeRaw };
  }

  /**
   * Bound parameters of the rewrite statement, in the order the tagged template
   * binds them: the `@updatedAt` stamp, the two `unnest` arrays, then the
   * field and org ids of the WHERE clause.
   */
  function readRewriteParams(executeRaw: Mock) {
    const [statement] = executeRaw.mock.calls[0];
    const [updatedAt, numbers, displayValues, customFieldId, organizationId] =
      statement.values as [Date, number[], string[], string, string];
    return { updatedAt, numbers, displayValues, customFieldId, organizationId };
  }

  it("rewrites the cached displayValue of stored rows when the number format changes", async () => {
    const { executeRaw } = installFormatTransitionTx(
      [3_600_000],
      NumberFormat.Duration
    );

    await customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
      numberFormat: NumberFormat.Duration,
    });

    // 3_600_000 ms is one hour: proves the row was re-rendered under the NEW
    // format, not left carrying the old plain-number string.
    const { numbers, displayValues } = readRewriteParams(executeRaw);
    expect(numbers).toEqual([3_600_000]);
    expect(displayValues[0]).toContain("1h");
  });

  it("keeps the org and field predicates on the set-based rewrite", async () => {
    const { executeRaw } = installFormatTransitionTx(
      [60_000],
      NumberFormat.Duration
    );

    await customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
      numberFormat: NumberFormat.Duration,
    });

    // A rewrite that lost its org predicate would restyle another tenant's
    // rows, which the shared `custom_field_values` table cannot otherwise stop.
    const { customFieldId, organizationId } = readRewriteParams(executeRaw);
    expect(customFieldId).toBe(TEST_FIELD_ID);
    expect(organizationId).toBe(TEST_ORG_ID);
  });

  it("rewrites a large population in one statement, not one per distinct value", async () => {
    // DURATION values are elapsed spans, so `distinct` barely dedupes and the
    // distinct count tracks the row count. 500 near-unique values stands in for
    // that population: under the previous per-value `updateMany` loop this is
    // 500 awaited round trips serialized on the transaction's single pinned
    // connection, which is what blew the 30s budget with a P2028.
    const storedNumbers = Array.from(
      { length: 500 },
      (_unused, index) => 191_000 + index * 1000
    );
    const { executeRaw, valueUpdateMany } = installFormatTransitionTx(
      storedNumbers,
      NumberFormat.Duration
    );

    await customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
      numberFormat: NumberFormat.Duration,
    });

    // The count is what this test exists for: it must not scale with the
    // population. The old loop shape scores 0 raw statements and 500 updateMany
    // calls here, so it fails both assertions.
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(valueUpdateMany).not.toHaveBeenCalled();

    // ...and the single statement still carries every value, so bounding the
    // statement count did not buy itself a truncated rewrite.
    const { numbers, displayValues } = readRewriteParams(executeRaw);
    expect(numbers).toEqual(storedNumbers);
    expect(displayValues).toHaveLength(storedNumbers.length);
    expect(new Set(displayValues).size).toBe(storedNumbers.length);
  });

  it("rejects a DURATION transition when a stored value is illegal under it, and writes nothing", async () => {
    const { valueUpdateMany, executeRaw } = installFormatTransitionTx(
      [60_000, -5],
      NumberFormat.Duration
    );

    await expect(
      customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
        numberFormat: NumberFormat.Duration,
      })
    ).rejects.toThrow(IncompatibleNumberFormatError);

    // The whole population is validated before any write, so the legal row is
    // not rewritten either — the transition is all-or-nothing.
    expect(valueUpdateMany).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it.each([[Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])(
    "rejects a plain format transition when a stored value is %p, and writes nothing",
    async (poison) => {
      // A legacy row holding a non-finite number predates ISS-8735's write
      // guard; the transition refuses it until it is corrected or cleared.
      const { valueUpdateMany, executeRaw } = installFormatTransitionTx(
        [1000, poison],
        NumberFormat.Currency
      );

      await expect(
        customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
          numberFormat: NumberFormat.Currency,
        })
      ).rejects.toThrow(IncompatibleNumberFormatError);

      expect(valueUpdateMany).not.toHaveBeenCalled();
      expect(executeRaw).not.toHaveBeenCalled();
    }
  );

  it("emits no rewrite statement when the field has no stored values", async () => {
    // An empty `unnest` array would be a no-op statement, but emitting it at
    // all costs a round trip inside the transaction for nothing.
    const { executeRaw } = installFormatTransitionTx([], NumberFormat.Duration);

    await customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
      numberFormat: NumberFormat.Duration,
    });

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("leaves stored values alone when the number format did not change", async () => {
    const { valueFindMany } = installFormatTransitionTx(
      [60_000],
      NumberFormat.None
    );

    await customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
      numberFormat: NumberFormat.None,
    });

    expect(valueFindMany).not.toHaveBeenCalled();
  });

  it("skips the reserved-name read when neither name nor entityTypes changes", async () => {
    const { txFindFirst, txUpdate } = installUpdateTx(null);

    await customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
      showInTable: false,
    });

    expect(txFindFirst).not.toHaveBeenCalled();
    expect(txUpdate).toHaveBeenCalledOnce();
  });

  /**
   * `fieldType` is immutable, so it is absent from the update payload and the
   * update validator cannot run the cross-field check its create sibling does.
   * Without this guard a PUT of `referenceTargetSources` to a TEXT field is
   * persisted — sources on a field that can never have a reference target.
   */
  it("refuses reference target sources on a non-reference field", async () => {
    const { txUpdate } = installUpdateTx({
      name: "Notes",
      entityTypes: [CustomFieldEntityType.Document],
      numberFormat: null,
      fieldType: CustomFieldType.Text,
    });

    await expect(
      customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
        referenceTargetSources: [ReferenceTargetSource.Issue],
      })
    ).rejects.toThrow(IncompatibleReferenceSourcesError);

    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("persists reference target sources on a REFERENCE field", async () => {
    const { txUpdate } = installUpdateTx({
      name: "Parent issue",
      entityTypes: [CustomFieldEntityType.Document],
      numberFormat: null,
      fieldType: CustomFieldType.Reference,
    });

    await customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
      referenceTargetSources: [ReferenceTargetSource.Issue],
    });

    expect(txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          referenceTargetSources: [ReferenceTargetSource.Issue],
        }),
      })
    );
  });

  it("reads the stored row when only referenceTargetSources changes", async () => {
    // The guard is only possible against the stored `fieldType`, so an update
    // carrying sources must not take the skip-the-read fast path.
    const { txFindFirst } = installUpdateTx({
      name: "Parent issue",
      entityTypes: [CustomFieldEntityType.Document],
      numberFormat: null,
      fieldType: CustomFieldType.Reference,
    });

    await customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
      referenceTargetSources: [ReferenceTargetSource.Branch],
    });

    expect(txFindFirst).toHaveBeenCalledOnce();
  });

  it("validates a new name against the entity types already stored on the field", async () => {
    // Only the name is changing, so the stored entityTypes decide whether the
    // new name is reserved — reading them is what makes this check correct.
    const { txUpdate } = installUpdateTx({
      name: "Old name",
      entityTypes: [CustomFieldEntityType.Project],
    });

    await expect(
      customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
        name: "Priority",
      })
    ).rejects.toThrow(ReservedNameError);

    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("validates newly added entity types against the name already stored", async () => {
    const { txUpdate } = installUpdateTx({
      name: "Priority",
      entityTypes: [],
    });

    await expect(
      customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
        entityTypes: [CustomFieldEntityType.Project],
      })
    ).rejects.toThrow(ReservedNameError);

    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("proceeds to the update when the field no longer exists in this org", async () => {
    // The row read comes back null for a cross-org id; the scoped update below
    // is what rejects it, so the guard must not swallow the request first.
    const { txUpdate } = installUpdateTx(null);

    await customFieldsService.updateField(TEST_FIELD_ID, OTHER_ORG_ID, {
      name: "Anything",
    });

    expect(txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TEST_FIELD_ID, organizationId: OTHER_ORG_ID },
      })
    );
  });

  it("maps a P2002 collision to DuplicateNameError naming the requested name", async () => {
    const p2002Error = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    });
    mockWithDbTx.mockRejectedValue(p2002Error);

    await expect(
      customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
        name: "Budget",
      })
    ).rejects.toThrow(BUDGET_NAME_REGEX);
  });

  it("re-throws a non-P2002 failure unchanged", async () => {
    mockWithDbTx.mockRejectedValue(new Error("Deadlock"));

    await expect(
      customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
        name: "Budget",
      })
    ).rejects.toThrow("Deadlock");
  });
});

// ---------------------------------------------------------------------------
// deleteField
// ---------------------------------------------------------------------------

describe("customFieldsService.deleteField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes dependents before the field itself, and scopes the field delete to the org", async () => {
    const cascade = mockDeleteCascadeDb({});

    await customFieldsService.deleteField(TEST_FIELD_ID, TEST_ORG_ID);

    // The dependent tables also carry ON DELETE CASCADE foreign keys, but the
    // explicit order is what this service states: every dependent goes before
    // the row they reference.
    expect(cascade.valueDeleteMany).toHaveBeenCalledBefore(cascade.fieldDelete);
    expect(cascade.settingDeleteMany).toHaveBeenCalledBefore(
      cascade.fieldDelete
    );
    expect(cascade.optionDeleteMany).toHaveBeenCalledBefore(
      cascade.fieldDelete
    );

    expect(cascade.valueDeleteMany).toHaveBeenCalledWith({
      where: { customFieldId: TEST_FIELD_ID },
    });
    expect(cascade.fieldDelete).toHaveBeenCalledWith({
      where: { id: TEST_FIELD_ID, organizationId: TEST_ORG_ID },
    });
  });

  it("runs the cascade under the raised transaction bounds, not Prisma's defaults", async () => {
    mockDeleteCascadeDb({});

    await customFieldsService.deleteField(TEST_FIELD_ID, TEST_ORG_ID);

    // Without the raised timeout the whole cascade rolls back with P2028 on a
    // tenant with a large value/setting population, so the field could never
    // be deleted there; without the raised maxWait a contended caller fails
    // with P2024 before it starts.
    expect(mockWithDbTx).toHaveBeenCalledWith(
      expect.any(Function),
      DELETE_FIELD_TX_OPTIONS
    );
    expect(DELETE_FIELD_TX_OPTIONS.timeout).toBeGreaterThan(5000);
    expect(DELETE_FIELD_TX_OPTIONS.maxWait).toBeGreaterThan(2000);
  });

  it("rolls the whole cascade back when the field belongs to another org", async () => {
    // The dependent deletes are not org-scoped on their own; the scoped delete
    // at the end failing inside the transaction is what protects the other org.
    const notFound = Object.assign(new Error("Record to delete not found"), {
      code: "P2025",
    });
    const cascade = mockDeleteCascadeDb({ fieldDeleteError: notFound });

    await expect(
      customFieldsService.deleteField(TEST_FIELD_ID, OTHER_ORG_ID)
    ).rejects.toThrow("Record to delete not found");

    // The dependent deletes did run and only the org-scoped delete rejected,
    // so the transaction rollback is the whole of the other org's protection.
    expect(cascade.valueDeleteMany).toHaveBeenCalledOnce();
    expect(cascade.settingDeleteMany).toHaveBeenCalledOnce();
    expect(cascade.optionDeleteMany).toHaveBeenCalledOnce();
    expect(cascade.fieldDelete).toHaveBeenCalledWith({
      where: { id: TEST_FIELD_ID, organizationId: OTHER_ORG_ID },
    });
  });
});

/** Wires `withDb.tx` for a deleteField run and returns the delegate spies. */
function mockDeleteCascadeDb({
  fieldDeleteError,
}: {
  fieldDeleteError?: Error;
}) {
  const valueDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
  const settingDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const optionDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
  const fieldDelete = fieldDeleteError
    ? vi.fn().mockRejectedValue(fieldDeleteError)
    : vi.fn().mockResolvedValue(buildCreatedRow());

  mockWithDbTx.mockImplementation((callback) =>
    callback({
      customFieldValue: { deleteMany: valueDeleteMany },
      customFieldSetting: { deleteMany: settingDeleteMany },
      customFieldEnumOption: { deleteMany: optionDeleteMany },
      customField: { delete: fieldDelete },
    })
  );

  return {
    valueDeleteMany,
    settingDeleteMany,
    optionDeleteMany,
    fieldDelete,
  };
}
