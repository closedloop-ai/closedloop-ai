/**
 * Unit tests for customFieldsService.
 *
 * Tests multi-tenant security (findById org mismatch) and duplicate name error
 * handling (P2002 → DuplicateNameError).
 *
 * checkFieldLimit limit enforcement is tested in utils.test.ts where the real
 * implementation can be exercised without interference from other mocks.
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

// utils is mocked here so createField tests are isolated from checkFieldLimit's DB calls.
vi.mock("../utils", () => ({
  checkFieldLimit: vi.fn().mockResolvedValue(undefined),
}));

import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { withDb } from "@repo/database";
import { customFieldsService, DuplicateNameError } from "../service";

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
