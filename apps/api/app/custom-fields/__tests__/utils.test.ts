/**
 * Unit tests for custom field utility functions.
 *
 * Tests:
 * (f) checkFieldLimit throws at 500
 * (h) computeDisplayValue: currency precision 2 produces "$50,000.00"; ENUM produces option name
 *
 * This file does NOT mock ../utils so the real implementations are exercised.
 */
import { type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { withDb } from "@repo/database";
import {
  checkFieldLimit,
  checkOptionLimit,
  computeDisplayValue,
  MAX_CUSTOM_FIELDS_PER_ORG,
  MAX_ENUM_OPTIONS_PER_FIELD,
  ReservedNameError,
  validateFieldNameNotReserved,
} from "../utils";

const mockWithDb = withDb as unknown as Mock;

const TEST_ORG_ID = "org-111";
const TEST_FIELD_ID = "field-abc";
const TEST_OPTION_ID = "opt-1";

// ---------------------------------------------------------------------------
// Shared field fixture builder
// ---------------------------------------------------------------------------

function buildField(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_FIELD_ID,
    organizationId: TEST_ORG_ID,
    name: "Priority",
    description: null,
    fieldType: CustomFieldType.Text,
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkFieldLimit
// ---------------------------------------------------------------------------

describe("checkFieldLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when the organization already has 500 custom fields", async () => {
    // Arrange
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        customField: {
          count: vi.fn().mockResolvedValue(MAX_CUSTOM_FIELDS_PER_ORG),
        },
      })
    );

    // Act & Assert
    await expect(checkFieldLimit(TEST_ORG_ID)).rejects.toThrow(
      `maximum of ${MAX_CUSTOM_FIELDS_PER_ORG} custom field definitions`
    );
  });

  it("does not throw when the organization has fewer than 500 custom fields", async () => {
    // Arrange
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        customField: {
          count: vi.fn().mockResolvedValue(MAX_CUSTOM_FIELDS_PER_ORG - 1),
        },
      })
    );

    // Act & Assert
    await expect(checkFieldLimit(TEST_ORG_ID)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkOptionLimit
// ---------------------------------------------------------------------------

describe("checkOptionLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when the custom field already has 100 enum options", async () => {
    // Arrange
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        customFieldEnumOption: {
          count: vi.fn().mockResolvedValue(MAX_ENUM_OPTIONS_PER_FIELD),
        },
      })
    );

    // Act & Assert
    await expect(checkOptionLimit(TEST_FIELD_ID)).rejects.toThrow(
      `maximum of ${MAX_ENUM_OPTIONS_PER_FIELD} enum options`
    );
  });

  it("does not throw when the field has fewer than 100 enum options", async () => {
    // Arrange
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        customFieldEnumOption: {
          count: vi.fn().mockResolvedValue(MAX_ENUM_OPTIONS_PER_FIELD - 1),
        },
      })
    );

    // Act & Assert
    await expect(checkOptionLimit(TEST_FIELD_ID)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeDisplayValue
// ---------------------------------------------------------------------------

describe("computeDisplayValue", () => {
  it("formats a currency NUMBER field with precision 2 as $50,000.00", async () => {
    // Arrange
    const field = buildField({
      fieldType: CustomFieldType.Number,
      numberFormat: NumberFormat.Currency,
      currencyCode: "USD",
      precision: 2,
    });

    // Act
    const result = await computeDisplayValue(field as any, 50_000);

    // Assert
    expect(result).toBe("$50,000.00");
  });

  it("returns the matching option name for an ENUM field", async () => {
    // Arrange
    const enumOption = {
      id: TEST_OPTION_ID,
      customFieldId: TEST_FIELD_ID,
      name: "High",
      color: "red",
      enabled: true,
      sortOrder: 0,
    };
    const field = buildField({
      fieldType: CustomFieldType.Enum,
      enumOptions: [enumOption],
    });

    // Act
    const result = await computeDisplayValue(field as any, TEST_OPTION_ID);

    // Assert
    expect(result).toBe("High");
  });

  it("returns empty string for an ENUM field when the option ID is not found", async () => {
    // Arrange
    const field = buildField({
      fieldType: CustomFieldType.Enum,
      enumOptions: [],
    });

    // Act
    const result = await computeDisplayValue(field as any, "nonexistent-opt");

    // Assert
    expect(result).toBe("");
  });

  it("returns empty string for a null rawValue regardless of field type", async () => {
    // Arrange
    const field = buildField({ fieldType: CustomFieldType.Text });

    // Act
    const result = await computeDisplayValue(field as any, null);

    // Assert
    expect(result).toBe("");
  });

  it("formats a percentage NUMBER field with precision 1 as 75.0%", async () => {
    // Arrange — 75 / 100 = 0.75 formatted as percent
    const field = buildField({
      fieldType: CustomFieldType.Number,
      numberFormat: NumberFormat.Percentage,
      precision: 1,
    });

    // Act
    const result = await computeDisplayValue(field as any, 75);

    // Assert
    expect(result).toBe("75.0%");
  });

  it("joins multiple MULTI_ENUM option names with a comma", async () => {
    // Arrange
    const options = [
      {
        id: "opt-a",
        customFieldId: TEST_FIELD_ID,
        name: "Alpha",
        color: "blue",
        enabled: true,
        sortOrder: 0,
      },
      {
        id: "opt-b",
        customFieldId: TEST_FIELD_ID,
        name: "Beta",
        color: "green",
        enabled: true,
        sortOrder: 1,
      },
    ];
    const field = buildField({
      fieldType: CustomFieldType.MultiEnum,
      enumOptions: options,
    });

    // Act
    const result = await computeDisplayValue(field as any, ["opt-a", "opt-b"]);

    // Assert
    expect(result).toBe("Alpha, Beta");
  });
});

// ---------------------------------------------------------------------------
// validateFieldNameNotReserved
// ---------------------------------------------------------------------------

describe("validateFieldNameNotReserved", () => {
  it("throws ReservedNameError for 'Priority' on PROJECT entity type", () => {
    expect(() =>
      validateFieldNameNotReserved("Priority", [CustomFieldEntityType.Project])
    ).toThrow(ReservedNameError);
  });

  it("is case-insensitive", () => {
    expect(() =>
      validateFieldNameNotReserved("priority", [CustomFieldEntityType.Project])
    ).toThrow(ReservedNameError);

    expect(() =>
      validateFieldNameNotReserved("PRIORITY", [CustomFieldEntityType.Project])
    ).toThrow(ReservedNameError);
  });

  it("throws for 'Status' on ISSUE entity type", () => {
    expect(() =>
      validateFieldNameNotReserved("Status", [CustomFieldEntityType.Issue])
    ).toThrow(ReservedNameError);
  });

  it("throws for 'Assignee' on ARTIFACT entity type", () => {
    expect(() =>
      validateFieldNameNotReserved("Assignee", [CustomFieldEntityType.Artifact])
    ).toThrow(ReservedNameError);
  });

  it("does not throw for a non-reserved name", () => {
    expect(() =>
      validateFieldNameNotReserved("Sprint Points", [
        CustomFieldEntityType.Project,
        CustomFieldEntityType.Issue,
      ])
    ).not.toThrow();
  });

  it("does not throw when entityTypes is empty", () => {
    expect(() => validateFieldNameNotReserved("Priority", [])).not.toThrow();
  });

  it("throws when name is reserved on any one of multiple entity types", () => {
    expect(() =>
      validateFieldNameNotReserved("Approver", [
        CustomFieldEntityType.Issue,
        CustomFieldEntityType.Artifact,
      ])
    ).toThrow(ReservedNameError);
  });

  it("includes friendly entity type label in error message", () => {
    expect(() =>
      validateFieldNameNotReserved("Priority", [CustomFieldEntityType.Project])
    ).toThrow("Project");
  });
});
