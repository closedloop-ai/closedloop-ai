/**
 * ISS-7210 — the DURATION round trip through the real write path.
 *
 * The editor expresses a duration as human text and stores the canonical
 * milliseconds; this asserts that what comes back out is the string that went
 * in, and that the write boundary refuses a span the column must never hold.
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
    SESSION: "SESSION",
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
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { withDb } from "@repo/database";
import {
  buildFieldRow,
  buildValueRow,
  installDb,
  TEST_ENTITY_ID,
  TEST_FIELD_ID,
  TEST_ORG_ID,
  upsertCreateArg,
} from "@/__tests__/support/custom-fields/values-service.test-fixtures";
import { customFieldValuesService } from "../values-service";

const mockWithDb = withDb as unknown as Mock;

/** Matches the DURATION-specific validation message. */
const DURATION_ERROR_RE = /DURATION/;

const DURATION_FIELD_ROW = buildFieldRow({
  fieldType: CustomFieldType.Number,
  numberFormat: NumberFormat.Duration,
  precision: 2,
  name: "Cycle time",
});

/** Installs the db harness with the field under test already resolved. */
function installDurationField() {
  return installDb(mockWithDb, {
    customFieldFindFirst: vi.fn().mockResolvedValue(DURATION_FIELD_ROW),
    valueUpsert: vi.fn().mockResolvedValue(
      buildValueRow({
        customField: {
          id: TEST_FIELD_ID,
          name: "Cycle time",
          fieldType: CustomFieldType.Number,
          showInTable: true,
          enumOptions: [],
        },
      })
    ),
  });
}

/**
 * Writes a duration through the real service entry point and returns the row it
 * built. The human string goes in RAW — parsing happens inside the service, not
 * here, so this exercises the production normalization rather than re-doing it
 * in the test and proving nothing.
 */
async function writeDuration(input: string | number) {
  const mocks = installDurationField();
  await customFieldValuesService.setValueForEntity(
    TEST_FIELD_ID,
    CustomFieldEntityType.Document,
    TEST_ENTITY_ID,
    TEST_ORG_ID,
    input
  );
  return upsertCreateArg(mocks.valueUpsert);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setValueForEntity — DURATION round trip", () => {
  it('writes "1h 12m" and reads back the same rendered string', async () => {
    const stored = await writeDuration("1h 12m");

    expect(stored.numberValue).toBe(4_320_000);
    expect(stored.displayValue).toBe("1h 12m");
  });

  it("stores the span in milliseconds, not seconds", async () => {
    // The canonical unit is a contract, not a formatting detail: 18 minutes is
    // 1_080_000, and a seconds-based store would land on 1080.
    const stored = await writeDuration("18m");

    expect(stored.numberValue).toBe(1_080_000);
  });

  it("accepts raw milliseconds too, so a machine-populated column needs no spelling", async () => {
    const stored = await writeDuration(4_320_000);

    expect(stored.numberValue).toBe(4_320_000);
    expect(stored.displayValue).toBe("1h 12m");
  });

  it("rejects a string that is not a duration instead of storing NaN", async () => {
    const mocks = installDurationField();

    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        "sometime next week"
      )
    ).rejects.toThrow(DURATION_ERROR_RE);

    expect(mocks.valueUpsert).not.toHaveBeenCalled();
  });

  it("keeps a measured zero visible and an unset value empty", async () => {
    const zero = await writeDuration("0");
    expect(zero.numberValue).toBe(0);
    expect(zero.displayValue).toBe("0s");

    const mocks = installDurationField();
    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      null
    );
    const cleared = upsertCreateArg(mocks.valueUpsert);
    expect(cleared.numberValue).toBeNull();
    expect(cleared.displayValue).toBe("");
  });

  it("refuses a negative span before it reaches the column", async () => {
    const mocks = installDurationField();

    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        -5000
      )
    ).rejects.toThrow(DURATION_ERROR_RE);

    expect(mocks.valueUpsert).not.toHaveBeenCalled();
  });
});
