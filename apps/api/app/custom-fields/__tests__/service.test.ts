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

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { withDb } from "@repo/database";
import { customFieldsService, DuplicateNameError } from "../service";
import { MAX_CUSTOM_FIELDS_PER_ORG, ReservedNameError } from "../utils";

const mockWithDb = withDb as unknown as Mock;

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
    mockWithDb.mockImplementation((callback: any) =>
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
    mockWithDb.mockImplementation((callback: any) =>
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
    mockWithDb.mockImplementation((callback: any) =>
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

    (withDb as any).tx = vi.fn().mockRejectedValue(p2002Error);

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

    (withDb as any).tx = vi.fn().mockRejectedValue(p2002Error);

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
    (withDb as any).tx = vi.fn().mockRejectedValue(dbError);

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
  (withDb as any).tx = vi.fn().mockImplementation((callback: any) =>
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
    mockWithDb.mockImplementation((callback: any) =>
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
    (withDb as any).tx = vi.fn().mockImplementation((callback: any) =>
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

  it("skips the reserved-name read when neither name nor entityTypes changes", async () => {
    const { txFindFirst, txUpdate } = installUpdateTx(null);

    await customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
      showInTable: false,
    });

    expect(txFindFirst).not.toHaveBeenCalled();
    expect(txUpdate).toHaveBeenCalledOnce();
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
    (withDb as any).tx = vi.fn().mockRejectedValue(p2002Error);

    await expect(
      customFieldsService.updateField(TEST_FIELD_ID, TEST_ORG_ID, {
        name: "Budget",
      })
    ).rejects.toThrow(BUDGET_NAME_REGEX);
  });

  it("re-throws a non-P2002 failure unchanged", async () => {
    (withDb as any).tx = vi.fn().mockRejectedValue(new Error("Deadlock"));

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
    const valueDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const settingDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const optionDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const fieldDelete = vi.fn().mockResolvedValue(buildCreatedRow());

    (withDb as any).tx = vi.fn().mockImplementation((callback: any) =>
      callback({
        customFieldValue: { deleteMany: valueDeleteMany },
        customFieldSetting: { deleteMany: settingDeleteMany },
        customFieldEnumOption: { deleteMany: optionDeleteMany },
        customField: { delete: fieldDelete },
      })
    );

    await customFieldsService.deleteField(TEST_FIELD_ID, TEST_ORG_ID);

    // relationMode=prisma has no DB-level cascade, so the order is the contract:
    // every dependent must go before the row they reference.
    expect(valueDeleteMany).toHaveBeenCalledBefore(fieldDelete);
    expect(settingDeleteMany).toHaveBeenCalledBefore(fieldDelete);
    expect(optionDeleteMany).toHaveBeenCalledBefore(fieldDelete);

    expect(fieldDelete).toHaveBeenCalledWith({
      where: { id: TEST_FIELD_ID, organizationId: TEST_ORG_ID },
    });
  });

  it("rolls the whole cascade back when the field belongs to another org", async () => {
    // The dependent deletes are not org-scoped on their own; the scoped delete
    // at the end failing inside the transaction is what protects the other org.
    const notFound = Object.assign(new Error("Record to delete not found"), {
      code: "P2025",
    });
    const valueDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const settingDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const optionDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const fieldDelete = vi.fn().mockRejectedValue(notFound);

    (withDb as any).tx = vi.fn().mockImplementation((callback: any) =>
      callback({
        customFieldValue: { deleteMany: valueDeleteMany },
        customFieldSetting: { deleteMany: settingDeleteMany },
        customFieldEnumOption: { deleteMany: optionDeleteMany },
        customField: { delete: fieldDelete },
      })
    );

    await expect(
      customFieldsService.deleteField(TEST_FIELD_ID, OTHER_ORG_ID)
    ).rejects.toThrow("Record to delete not found");

    // The dependent deletes did run and only the org-scoped delete rejected,
    // so the transaction rollback is the whole of the other org's protection.
    expect(valueDeleteMany).toHaveBeenCalledOnce();
    expect(settingDeleteMany).toHaveBeenCalledOnce();
    expect(optionDeleteMany).toHaveBeenCalledOnce();
    expect(fieldDelete).toHaveBeenCalledWith({
      where: { id: TEST_FIELD_ID, organizationId: OTHER_ORG_ID },
    });
  });
});
