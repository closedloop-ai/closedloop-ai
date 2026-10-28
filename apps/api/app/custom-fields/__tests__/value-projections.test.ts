/**
 * `toValueDetail` is the PRODUCTION caller of the display-value resolver — every
 * read path funnels through `getValuesForEntity` into it.
 *
 * Covered here rather than only through the resolver's own unit suite because
 * the wiring is the part that can rot: dropping the `peopleValues` argument at
 * the call site would leave `display-value.test.ts` entirely green while every
 * PEOPLE cell in the product went blank.
 */
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ArtifactType: { DOCUMENT: "DOCUMENT", BRANCH: "BRANCH", SESSION: "SESSION" },
  ArtifactSubtype: { FEATURE: "FEATURE", ISSUE: "ISSUE" },
}));

import type { ValueFromDb } from "../value-projections";
import { toValueDetail } from "../value-projections";

const ADA: BasicUser = {
  id: "u1",
  email: "u1@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: null,
};

const ALAN: BasicUser = {
  id: "u2",
  email: "u2@example.com",
  firstName: "Alan",
  lastName: "Turing",
  avatarUrl: null,
};

function peopleRow(
  peopleValueIds: string[],
  storedDisplayValue: string
): ValueFromDb {
  return {
    id: "v-1",
    customFieldId: "cf-1",
    entityId: "e-1",
    textValue: null,
    numberValue: null,
    dateValue: null,
    enumValueId: null,
    enumValue: null,
    multiEnumValueIds: [],
    peopleValueIds,
    displayValue: storedDisplayValue,
    references: [],
    customField: {
      id: "cf-1",
      name: "Owner",
      fieldType: CustomFieldType.People,
      showInTable: true,
      enumOptions: [],
    },
  } as unknown as ValueFromDb;
}

describe("toValueDetail — PEOPLE resolves on read (ISS-7215)", () => {
  it("renders the CURRENT users, not the string cached at write time", () => {
    const detail = toValueDetail(
      peopleRow(["u1"], "Ada B."),
      new Map([["u1", ADA]])
    );

    expect(detail.displayValue).toBe("Ada L.");
  });

  it("orders the display string by the STORED ids, not by map insertion", () => {
    // The map is built from a `findMany`, whose order Postgres chooses. If the
    // projection read the map's own order the label could disagree with the
    // cached sort key for the very same row.
    const detail = toValueDetail(
      peopleRow(["u2", "u1"], ""),
      new Map([
        ["u1", ADA],
        ["u2", ALAN],
      ])
    );

    expect(detail.displayValue).toBe("Alan T., Ada L.");
    expect(detail.peopleValues.map((p) => p.id)).toEqual(["u2", "u1"]);
  });

  it("projects the same users it derived the display string from", () => {
    const detail = toValueDetail(
      peopleRow(["u1", "u2"], "STALE"),
      new Map([
        ["u1", ADA],
        ["u2", ALAN],
      ])
    );

    expect(detail.displayValue).toBe("Ada L., Alan T.");
    expect(detail.peopleValues.map((p) => p.id)).toEqual(["u1", "u2"]);
  });

  it("reads as absent, not stale, when the named user no longer resolves", () => {
    const detail = toValueDetail(peopleRow(["u1"], "Ada L."), new Map());

    expect(detail.displayValue).toBe("");
    expect(detail.peopleValues).toEqual([]);
  });

  it("still returns the cached string for a CachedOnWrite type", () => {
    const row = peopleRow([], "hello");
    (row.customField as { fieldType: string }).fieldType = CustomFieldType.Text;
    (row as { textValue: string | null }).textValue = "hello";

    expect(toValueDetail(row, new Map()).displayValue).toBe("hello");
  });
});

/**
 * ISS-8884 — the ingest ceiling is write-only. A row that already holds a
 * year-10000 date must still project on read, with both the raw instant and
 * the cached display string forwarded, or the "ceiling does not touch stored
 * rows" guarantee is false-green.
 */
describe("toValueDetail — DATE read path keeps a stored out-of-range year (ISS-8884)", () => {
  it("forwards dateValue and displayValue for a year-10000 row", () => {
    const stored = new Date("+010000-01-01T00:00:00.000Z");
    const row = peopleRow([], "Jan 1, 10000");
    (row.customField as { fieldType: string }).fieldType = CustomFieldType.Date;
    (row as { dateValue: Date | null }).dateValue = stored;

    const detail = toValueDetail(row, new Map());

    expect(detail.dateValue).toBe(stored);
    expect(detail.displayValue).toBe("Jan 1, 10000");
  });
});
