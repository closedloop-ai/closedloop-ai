/**
 * Unit tests for enumOptionsService.
 *
 * Tests:
 * - createEnumOption defaults, sortOrder assignment, and field ownership check
 * - reorderEnumOptions sorts each option by its index in the provided array
 *
 * checkOptionLimit limit enforcement is tested in utils.test.ts where the real
 * implementation can be exercised without interference from other mocks.
 */
import { type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

// Mock utils so createEnumOption tests are isolated from checkOptionLimit's DB calls.
vi.mock("../utils", () => ({
  checkOptionLimit: vi.fn().mockResolvedValue(undefined),
  computeDisplayValue: vi.fn().mockResolvedValue(""),
}));

import { withDb } from "@repo/database";
import { enumOptionsService } from "../enum-options-service";

const mockWithDb = withDb as unknown as Mock;

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_ORG_ID = "org-111";
const TEST_FIELD_ID = "field-abc";
const TEST_OPTION_ID = "opt-1";

const MOCK_ENUM_OPTION = {
  id: TEST_OPTION_ID,
  customFieldId: TEST_FIELD_ID,
  name: "High",
  color: "red",
  enabled: true,
  sortOrder: 0,
};

const MOCK_FIELD = {
  id: TEST_FIELD_ID,
  organizationId: TEST_ORG_ID,
  name: "Priority",
  fieldType: "ENUM",
  enumOptions: [MOCK_ENUM_OPTION],
};

// ---------------------------------------------------------------------------

describe("enumOptionsService.createEnumOption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an enum option with default color and enabled values when not provided", async () => {
    // Arrange — verifyFieldOwnership (findFirst) returns a valid field;
    //           the count query returns 2; the create returns the new option.
    const mockFindFirst = vi.fn().mockResolvedValue(MOCK_FIELD);
    const mockCount = vi.fn().mockResolvedValue(2);
    const mockCreate = vi.fn().mockResolvedValue({
      ...MOCK_ENUM_OPTION,
      id: "opt-new",
      name: "Low",
      color: "none",
      enabled: true,
      sortOrder: 2,
    });

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        customField: { findFirst: mockFindFirst },
        customFieldEnumOption: { count: mockCount, create: mockCreate },
      })
    );

    // Act
    const result = await enumOptionsService.createEnumOption(
      TEST_FIELD_ID,
      TEST_ORG_ID,
      { name: "Low" }
    );

    // Assert
    expect(result.name).toBe("Low");
    expect(result.color).toBe("none");
    expect(result.enabled).toBe(true);
    expect(result.sortOrder).toBe(2);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customFieldId: TEST_FIELD_ID,
          name: "Low",
          color: "none",
          enabled: true,
          sortOrder: 2,
        }),
      })
    );
  });

  it("assigns sortOrder equal to the current option count when sortOrder is not provided", async () => {
    // Arrange — current count is 5, so new option gets sortOrder: 5
    const mockFindFirst = vi.fn().mockResolvedValue(MOCK_FIELD);
    const mockCount = vi.fn().mockResolvedValue(5);
    const mockCreate = vi.fn().mockResolvedValue({
      ...MOCK_ENUM_OPTION,
      id: "opt-6",
      name: "Critical",
      color: "none",
      enabled: true,
      sortOrder: 5,
    });

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        customField: { findFirst: mockFindFirst },
        customFieldEnumOption: { count: mockCount, create: mockCreate },
      })
    );

    // Act
    await enumOptionsService.createEnumOption(TEST_FIELD_ID, TEST_ORG_ID, {
      name: "Critical",
    });

    // Assert
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sortOrder: 5 }),
      })
    );
  });

  it("throws when the field does not belong to the organization", async () => {
    // Arrange — findFirst returns null (org mismatch)
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        customField: { findFirst: vi.fn().mockResolvedValue(null) },
      })
    );

    // Act & Assert
    await expect(
      enumOptionsService.createEnumOption(TEST_FIELD_ID, "wrong-org", {
        name: "Medium",
      })
    ).rejects.toThrow(
      "Custom field not found or does not belong to organization"
    );
  });
});

// ---------------------------------------------------------------------------

describe("enumOptionsService.reorderEnumOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates sortOrder for each option ID according to its position in the provided array", async () => {
    // Arrange
    const fieldWith3Options = {
      ...MOCK_FIELD,
      enumOptions: [
        { ...MOCK_ENUM_OPTION, id: "opt-a" },
        { ...MOCK_ENUM_OPTION, id: "opt-b" },
        { ...MOCK_ENUM_OPTION, id: "opt-c" },
      ],
    };
    const mockFindFirst = vi.fn().mockResolvedValue(fieldWith3Options);
    const mockUpdate = vi.fn().mockResolvedValue({ id: "opt-c", sortOrder: 0 });

    (withDb as any).tx = vi.fn().mockImplementation((callback: any) =>
      callback({
        customFieldEnumOption: { update: mockUpdate },
      })
    );

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        customField: { findFirst: mockFindFirst },
      })
    );

    const orderedIds = ["opt-c", "opt-a", "opt-b"];

    // Act
    await enumOptionsService.reorderEnumOptions(
      TEST_FIELD_ID,
      TEST_ORG_ID,
      orderedIds
    );

    // Assert — each option updated with its index as sortOrder
    expect(mockUpdate).toHaveBeenCalledTimes(3);
    expect(mockUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: { sortOrder: 0 },
        where: { id: "opt-c", customFieldId: TEST_FIELD_ID },
      })
    );
    expect(mockUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: { sortOrder: 1 },
        where: { id: "opt-a", customFieldId: TEST_FIELD_ID },
      })
    );
    expect(mockUpdate).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: { sortOrder: 2 },
        where: { id: "opt-b", customFieldId: TEST_FIELD_ID },
      })
    );
  });
});
