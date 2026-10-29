/**
 * Branch coverage for `computeDisplayValue` and `validateValueType` cases that
 * `utils.test.ts` does not exercise: the REFERENCE/REFERENCE_MULTI switch
 * arms, the PEOPLE array-coercion and empty-ids paths, the
 * REFERENCE/REFERENCE_MULTI shape guards, a non-string DATE input, and the
 * REFERENCE/REFERENCE_MULTI shape guards' error messages.
 *
 * Kept in a separate file (not appended to `utils.test.ts`) per the lane split
 * for ISS-10513; the sibling file is read-only for this change.
 *
 * No "unknown CustomFieldType" / "unknown CustomFieldEntityType" cases here:
 * both are native Postgres enums (`schema.prisma`), so a DB row — and every
 * caller of `computeDisplayValue`, `validateValueType`, and
 * `validateFieldNameNotReserved`, all of which pass a Prisma-typed value —
 * cannot carry a value outside the enum. Reaching the default/fallback arms
 * for those types requires an in-process `as` cast the real call sites never
 * perform, which is exactly the type-forbidden input the repo's test-practice
 * rule says not to test. Likewise no "MULTI_ENUM array with a non-string
 * element" case: the one write-path caller (`prepareValueWrite` in
 * `values-service.ts`) only ever receives a value already validated by
 * `z.array(z.string())` (`custom-field-values-handlers.ts`), and the
 * underlying `multi_enum_value_ids` column is a native Postgres `text[]`, not
 * JSON — so a non-string element can reach neither the wire boundary nor a
 * persisted row.
 */

import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidReferenceTargetError } from "./reference-targets";

// `computeDisplayValue`'s empty-ids PEOPLE branch returns "" before ever
// reaching `resolvePeopleMap`. Both `resolvePeopleMap` (empty-ids short
// circuit) and `orderRowsByIdFrom` (empty `orderedIds` loop) ALSO produce ""
// for an empty ids array, so the early return and "no early return" paths are
// output-equivalent — the mock below is what makes the early return itself
// (never touching the resolver) an observable, killable behavior.
const peopleResolutionMocks = vi.hoisted(() => ({
  resolvePeopleMap: vi.fn(async () => new Map<string, BasicUser>()),
}));

vi.mock("./people-resolution", () => ({
  resolvePeopleMap: peopleResolutionMocks.resolvePeopleMap,
}));

import { computeDisplayValue, validateValueType } from "./utils";

const REFERENCE_ERROR = /REFERENCE field/;
const REFERENCE_GOT_ARRAY_ERROR = /got an array/;
const REFERENCE_GOT_NUMBER_ERROR = /got number/;
const REFERENCE_MULTI_ERROR = /REFERENCE_MULTI field/;
const DATE_TYPE_ERROR = /expected an ISO 8601 date string, got number/;

const BASE_FIELD: CustomFieldWithOptions = {
  id: "cf-1",
  organizationId: "org-1",
  name: "Test Field",
  description: null,
  fieldType: CustomFieldType.Text,
  createdById: null,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  precision: null,
  numberFormat: null,
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  isGlobalToOrg: false,
  entityTypes: [],
  referenceTargetSources: [],
  showInTable: false,
  isSearchable: false,
  isSortable: false,
  enumOptions: [],
};

function field(
  overrides: Partial<CustomFieldWithOptions> & {
    fieldType: CustomFieldWithOptions["fieldType"];
  }
): CustomFieldWithOptions {
  return { ...BASE_FIELD, ...overrides };
}

describe("computeDisplayValue — REFERENCE and REFERENCE_MULTI", () => {
  it("renders REFERENCE as empty; the display string is resolved on read, never stored", async () => {
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.Reference }),
        "artifact-1"
      )
    ).toBe("");
  });

  it("renders REFERENCE_MULTI as empty for the same reason", async () => {
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.ReferenceMulti }),
        ["artifact-1", "artifact-2"]
      )
    ).toBe("");
  });
});

describe("computeDisplayValue — PEOPLE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders an empty string for an empty ids array without resolving any people", async () => {
    const result = await computeDisplayValue(
      field({ fieldType: CustomFieldType.People }),
      []
    );

    expect(result).toBe("");
    // The output alone cannot distinguish the early return from falling
    // through to `resolvePeopleMap([], …)`, since that call also short-
    // circuits to an empty map for zero ids — see the comment on the mock
    // above. Asserting the collaborator was never reached is what pins the
    // early return itself.
    expect(peopleResolutionMocks.resolvePeopleMap).not.toHaveBeenCalled();
  });

  it("coerces a scalar PEOPLE value into a single-id array and resolves it from the supplied map", async () => {
    const ada: BasicUser = {
      id: "u1",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
    };

    const result = await computeDisplayValue(
      field({ fieldType: CustomFieldType.People }),
      "u1",
      undefined,
      new Map([["u1", ada]])
    );

    expect(result).toBe("Ada L.");
  });
});

describe("validateValueType — REFERENCE and REFERENCE_MULTI", () => {
  it("accepts a REFERENCE value that is a single string id", () => {
    expect(() =>
      validateValueType(CustomFieldType.Reference, "artifact-1")
    ).not.toThrow();
  });

  it("rejects a REFERENCE value that is an array, naming it as such", () => {
    expect(() =>
      validateValueType(CustomFieldType.Reference, ["artifact-1"])
    ).toThrow(REFERENCE_ERROR);
    expect(() =>
      validateValueType(CustomFieldType.Reference, ["artifact-1"])
    ).toThrow(REFERENCE_GOT_ARRAY_ERROR);
  });

  it("rejects a REFERENCE value that is neither a string nor an array, naming its typeof", () => {
    expect(() => validateValueType(CustomFieldType.Reference, 5)).toThrow(
      InvalidReferenceTargetError
    );
    expect(() => validateValueType(CustomFieldType.Reference, 5)).toThrow(
      REFERENCE_GOT_NUMBER_ERROR
    );
  });

  it("accepts a REFERENCE_MULTI value that is an array of string ids", () => {
    expect(() =>
      validateValueType(CustomFieldType.ReferenceMulti, [
        "artifact-1",
        "artifact-2",
      ])
    ).not.toThrow();
  });

  it("rejects a REFERENCE_MULTI value that is not an array", () => {
    expect(() =>
      validateValueType(CustomFieldType.ReferenceMulti, "artifact-1")
    ).toThrow(REFERENCE_MULTI_ERROR);
    expect(() =>
      validateValueType(CustomFieldType.ReferenceMulti, "artifact-1")
    ).toThrow(InvalidReferenceTargetError);
  });
});

describe("validateValueType — DATE typing", () => {
  it("rejects a non-string DATE value before it ever reaches Date parsing", () => {
    expect(() => validateValueType(CustomFieldType.Date, 20_260_807)).toThrow(
      DATE_TYPE_ERROR
    );
  });
});
