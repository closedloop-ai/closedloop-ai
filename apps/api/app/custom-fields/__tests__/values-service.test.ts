/**
 * Unit tests for customFieldValuesService.
 *
 * Tests:
 * (c) setValueForEntity rejects enumValueId not belonging to the specific customFieldId (cross-field injection)
 * (d) setValueForEntity rejects a disabled enum option
 * (e) setValueForEntity rejects peopleValueIds not in org (returned count < input count)
 * (g) attachField to a Project cascades settings to child Workstreams and Features with skipDuplicates: true
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
import { customFieldValuesService } from "../values-service";

const mockWithDb = withDb as unknown as Mock;

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_ORG_ID = "org-111";
const TEST_FIELD_ID = "field-abc";
const TEST_ENTITY_ID = "feature-xyz";
const TEST_OPTION_ID = "opt-1";

/** Builds the Prisma field record (with enumOptions relation) returned from withDb. */
function buildFieldRow(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// setValueForEntity — ENUM cross-field injection (case c) and disabled option (case d)
// ---------------------------------------------------------------------------

describe("customFieldValuesService.setValueForEntity — ENUM validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Sets up withDb so that:
   * - verifyEntityExists → db.feature.findFirst returns a record (entity exists)
   * - field lookup → db.customField.findFirst returns fieldRow
   * - validateEnumOptionExists → db.customFieldEnumOption.findFirst returns enumOptionRow
   */
  function setupEntityAndField(
    fieldRow: Record<string, unknown>,
    enumOptionRow: Record<string, unknown> | null
  ) {
    mockWithDb.mockImplementation((callback: any) => {
      const db = {
        feature: {
          findFirst: vi.fn().mockResolvedValue({ id: TEST_ENTITY_ID }),
        },
        customField: {
          findFirst: vi.fn().mockResolvedValue(fieldRow),
        },
        customFieldEnumOption: {
          findFirst: vi.fn().mockResolvedValue(enumOptionRow),
        },
        customFieldValue: {
          upsert: vi.fn().mockResolvedValue({
            id: "cfv-1",
            customFieldId: TEST_FIELD_ID,
            organizationId: TEST_ORG_ID,
            entityType: CustomFieldEntityType.Feature,
            entityId: TEST_ENTITY_ID,
            textValue: null,
            numberValue: null,
            dateValue: null,
            enumValueId: TEST_OPTION_ID,
            multiEnumValueIds: [],
            peopleValueIds: [],
            displayValue: "High",
            enumValue: null,
            customField: {
              name: "Priority",
              fieldType: CustomFieldType.Enum,
            },
          }),
          findMany: vi.fn().mockResolvedValue([]),
        },
        user: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      return callback(db);
    });
  }

  it("throws when the enum option does not belong to the specified customFieldId (cross-field injection)", async () => {
    // Arrange — enum option exists but belongs to a different field (findFirst returns null
    // because the WHERE clause includes customFieldId: TEST_FIELD_ID)
    const fieldRow = buildFieldRow({
      fieldType: CustomFieldType.Enum,
      enumOptions: [],
    });
    setupEntityAndField(fieldRow, null); // null = option not found for this field

    // Act & Assert
    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Feature,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        "opt-belongs-to-other-field"
      )
    ).rejects.toThrow(
      `Enum option "opt-belongs-to-other-field" not found for field "${TEST_FIELD_ID}"`
    );
  });

  it("throws when the enum option is disabled", async () => {
    // Arrange — option exists but enabled = false
    const fieldRow = buildFieldRow({
      fieldType: CustomFieldType.Enum,
      enumOptions: [],
    });
    const disabledOption = {
      id: TEST_OPTION_ID,
      customFieldId: TEST_FIELD_ID,
      name: "Archived",
      color: "gray",
      enabled: false,
      sortOrder: 5,
    };
    setupEntityAndField(fieldRow, disabledOption);

    // Act & Assert
    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Feature,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        TEST_OPTION_ID
      )
    ).rejects.toThrow(
      `Enum option "${TEST_OPTION_ID}" is disabled and cannot be set`
    );
  });
});

// ---------------------------------------------------------------------------
// setValueForEntity — PEOPLE validation (case e)
// ---------------------------------------------------------------------------

describe("customFieldValuesService.setValueForEntity — PEOPLE validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when one or more peopleValueIds do not belong to the organization", async () => {
    // Arrange — entity exists, field is PEOPLE type, user lookup returns fewer rows than input
    const fieldRow = buildFieldRow({
      fieldType: CustomFieldType.People,
      enumOptions: [],
    });

    mockWithDb.mockImplementation((callback: any) => {
      const db = {
        feature: {
          findFirst: vi.fn().mockResolvedValue({ id: TEST_ENTITY_ID }),
        },
        customField: {
          findFirst: vi.fn().mockResolvedValue(fieldRow),
        },
        user: {
          // Only 1 of the 2 requested users exists in the org
          findMany: vi.fn().mockResolvedValue([{ id: "user-known" }]),
        },
      };
      return callback(db);
    });

    // Act & Assert
    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Feature,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        ["user-known", "user-unknown"]
      )
    ).rejects.toThrow(
      "One or more user IDs are invalid or do not belong to this organization"
    );
  });
});

// ---------------------------------------------------------------------------
// attachField — Project cascade to Workstreams and Issues (case g)
// ---------------------------------------------------------------------------

describe("customFieldValuesService.attachField — Project cascade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cascades settings to child Workstreams and Features with skipDuplicates: true when attaching to a Project", async () => {
    // Arrange
    const TEST_PROJECT_ID = "project-1";

    const MOCK_CREATED_SETTING = {
      id: "setting-1",
      customFieldId: TEST_FIELD_ID,
      organizationId: TEST_ORG_ID,
      entityType: CustomFieldEntityType.Project,
      entityId: TEST_PROJECT_ID,
      isImportant: false,
      isRequired: false,
      sortOrder: 0,
      createdAt: new Date("2024-01-01"),
      customField: {
        id: TEST_FIELD_ID,
        organizationId: TEST_ORG_ID,
        name: "Budget",
        description: null,
        fieldType: CustomFieldType.Number,
        createdById: "user-1",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
        precision: 2,
        numberFormat: NumberFormat.Currency,
        currencyCode: "USD",
        customLabel: null,
        customLabelPosition: null,
        isGlobalToOrg: false,
        enumOptions: [],
      },
    };

    const mockCreate = vi.fn().mockResolvedValue(MOCK_CREATED_SETTING);
    const mockCreateMany = vi.fn().mockResolvedValue({ count: 3 });

    // verifyEntityExists → project.findFirst
    // verifyFieldBelongsToOrg → customField.findFirst
    mockWithDb.mockImplementation((callback: any) => {
      const db = {
        project: {
          findFirst: vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID }),
        },
        customField: {
          findFirst: vi.fn().mockResolvedValue({ id: TEST_FIELD_ID }),
        },
      };
      return callback(db);
    });

    (withDb as any).tx = vi.fn().mockImplementation((callback: any) => {
      const tx = {
        customFieldSetting: {
          create: mockCreate,
          createMany: mockCreateMany,
        },
        workstream: {
          findMany: vi.fn().mockResolvedValue([{ id: "ws-1" }, { id: "ws-2" }]),
        },
        feature: {
          findMany: vi.fn().mockResolvedValue([{ id: "iss-1" }]),
        },
      };
      return callback(tx);
    });

    // Act
    await customFieldValuesService.attachField(
      TEST_FIELD_ID,
      CustomFieldEntityType.Project,
      TEST_PROJECT_ID,
      TEST_ORG_ID,
      { customFieldId: TEST_FIELD_ID }
    );

    // Assert — createMany called with skipDuplicates: true
    expect(mockCreateMany).toHaveBeenCalledOnce();
    expect(mockCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    );

    const createManyArgs = mockCreateMany.mock.calls[0][0];

    // 2 workstreams + 1 feature = 3 child setting records
    expect(createManyArgs.data).toHaveLength(3);

    const workstreamRecords = createManyArgs.data.filter(
      (d: any) => d.entityType === CustomFieldEntityType.Workstream
    );
    const featureRecords = createManyArgs.data.filter(
      (d: any) => d.entityType === CustomFieldEntityType.Feature
    );

    expect(workstreamRecords).toHaveLength(2);
    expect(workstreamRecords.map((r: any) => r.entityId)).toEqual(
      expect.arrayContaining(["ws-1", "ws-2"])
    );
    expect(featureRecords).toHaveLength(1);
    expect(featureRecords[0].entityId).toBe("iss-1");
  });

  it("does not call createMany when the Project has no child Workstreams or Features", async () => {
    // Arrange
    const TEST_PROJECT_ID = "project-empty";

    const MOCK_CREATED_SETTING = {
      id: "setting-2",
      customFieldId: TEST_FIELD_ID,
      organizationId: TEST_ORG_ID,
      entityType: CustomFieldEntityType.Project,
      entityId: TEST_PROJECT_ID,
      isImportant: false,
      isRequired: false,
      sortOrder: 0,
      createdAt: new Date("2024-01-01"),
      customField: {
        id: TEST_FIELD_ID,
        organizationId: TEST_ORG_ID,
        name: "Budget",
        description: null,
        fieldType: CustomFieldType.Number,
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
      },
    };

    const mockCreate = vi.fn().mockResolvedValue(MOCK_CREATED_SETTING);
    const mockCreateMany = vi.fn();

    mockWithDb.mockImplementation((callback: any) => {
      const db = {
        project: {
          findFirst: vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID }),
        },
        customField: {
          findFirst: vi.fn().mockResolvedValue({ id: TEST_FIELD_ID }),
        },
      };
      return callback(db);
    });

    (withDb as any).tx = vi.fn().mockImplementation((callback: any) => {
      const tx = {
        customFieldSetting: {
          create: mockCreate,
          createMany: mockCreateMany,
        },
        workstream: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        feature: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      return callback(tx);
    });

    // Act
    await customFieldValuesService.attachField(
      TEST_FIELD_ID,
      CustomFieldEntityType.Project,
      TEST_PROJECT_ID,
      TEST_ORG_ID,
      { customFieldId: TEST_FIELD_ID }
    );

    // Assert — no createMany call when no children exist
    expect(mockCreateMany).not.toHaveBeenCalled();
  });
});
