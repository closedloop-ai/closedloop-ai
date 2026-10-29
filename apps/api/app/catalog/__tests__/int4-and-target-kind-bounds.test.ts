/**
 * ISS-8880 §3 — the admin-writable fields that reached an int4 or a btree
 * column with no ceiling.
 *
 * `sortOrder` is five separate schemas writing three Prisma `Int` columns.
 * `z.number().int()` has no ceiling in Zod, and `Number.isInteger(1e21)` is
 * `true`, so `2147483648` and `1e21` both parsed and Prisma rejected them
 * uncaught as a 500.
 *
 * Every bound is covered at-and-over. `POSTGRES_INT4_MAX` is asserted against
 * the imported constant rather than a literal, so a fourth spelling of the int4
 * ceiling cannot pass this file.
 */

import {
  POSTGRES_INT4_MAX,
  POSTGRES_INT4_MIN,
} from "@closedloop-ai/loops-api/column-limits";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { describe, expect, it } from "vitest";
import { createEnumOptionValidator } from "@/app/custom-fields/enum-options-validators";
import { createCustomFieldValidator } from "@/app/custom-fields/validators";
import { updateOrganizationValidator } from "@/app/organizations/validators";
import {
  CatalogTargetKind,
  createCatalogItemBodySchema,
  updateCatalogItemBodySchema,
} from "../validators";

const OVER_INT4 = POSTGRES_INT4_MAX + 1;

function catalogBody(overrides: Record<string, unknown> = {}) {
  return {
    targetKind: CatalogTargetKind.Skill,
    name: "a skill",
    ...overrides,
  };
}

describe("§3b sortOrder is bounded at both ends on every writer", () => {
  const atBound = [0, POSTGRES_INT4_MAX];
  // Out of the COLUMN's range at one end or the other. `1e21` is in the set
  // because `Number.isInteger(1e21)` is `true`, so `z.number().int()` alone let
  // it through to a 22003 at the driver.
  const outOfInt4Range = [OVER_INT4, 1e21, POSTGRES_INT4_MIN - 1, -1e21];

  it.each(atBound)("catalog create accepts %d", (sortOrder) => {
    expect(
      createCatalogItemBodySchema.safeParse(catalogBody({ sortOrder })).success
    ).toBe(true);
  });

  it.each(outOfInt4Range)("catalog create refuses %d", (sortOrder) => {
    expect(
      createCatalogItemBodySchema.safeParse(catalogBody({ sortOrder })).success
    ).toBe(false);
  });

  it.each(outOfInt4Range)("catalog update refuses %d", (sortOrder) => {
    expect(updateCatalogItemBodySchema.safeParse({ sortOrder }).success).toBe(
      false
    );
  });

  it("catalog update still accepts a value at the ceiling", () => {
    expect(
      updateCatalogItemBodySchema.safeParse({ sortOrder: POSTGRES_INT4_MAX })
        .success
    ).toBe(true);
  });

  it.each(atBound)("enum-option create accepts %d", (sortOrder) => {
    expect(
      createEnumOptionValidator.safeParse({ name: "o", sortOrder }).success
    ).toBe(true);
  });

  it.each(outOfInt4Range)("enum-option create refuses %d", (sortOrder) => {
    expect(
      createEnumOptionValidator.safeParse({ name: "o", sortOrder }).success
    ).toBe(false);
  });

  it("the catalog `.min(0)` is PRE-EXISTING and stays; the writers this ticket bounded do not copy it", () => {
    // `-1` is a legal int4 that stores fine, so refusing it on a writer that
    // accepts it today would be a behaviour change on VALID input — the one
    // thing ISS-8880's governing constraint forbids. The writers this ticket
    // bounded therefore floor at the COLUMN, not at zero.
    //
    // Catalog is the counterfactual half: its `.min(0)` predates this ticket
    // and is left alone, so this pair also proves the two floors are a
    // deliberate difference rather than drift.
    //
    // The two remaining writers (`attachCustomFieldSettingValidator`,
    // promote's `promoteSchema`) are module-private and are covered through
    // their routes instead — `custom-fields/__tests__/custom-field-settings-handlers`
    // and `agent-components/__tests__/promote-target-kind-bound`.
    expect(
      createCatalogItemBodySchema.safeParse(catalogBody({ sortOrder: -1 }))
        .success
    ).toBe(false);

    expect(
      createEnumOptionValidator.safeParse({ name: "o", sortOrder: -1 }).success
    ).toBe(true);
    expect(
      createCustomFieldValidator.safeParse({
        enumOptions: [{ name: "o", sortOrder: -1 }],
        fieldType: CustomFieldType.Enum,
        name: "f",
      }).success
    ).toBe(true);
  });

  it("the ceiling IS the canonical int4 constant, not a copy", () => {
    // A fourth spelling of 2147483647 would still pass an at-bound test written
    // against a literal. This is what stops one drifting in.
    expect(
      createCatalogItemBodySchema.safeParse(
        catalogBody({ sortOrder: POSTGRES_INT4_MAX })
      ).success
    ).toBe(true);
    expect(
      createCatalogItemBodySchema.safeParse(
        catalogBody({ sortOrder: POSTGRES_INT4_MAX + 1 })
      ).success
    ).toBe(false);
  });
});

describe("§3a catalog targetKind stays the closed catalog enum", () => {
  it.each(Object.values(CatalogTargetKind))("accepts %s", (targetKind) => {
    expect(
      createCatalogItemBodySchema.safeParse(catalogBody({ targetKind })).success
    ).toBe(true);
  });

  it("refuses a kind outside the catalog set", () => {
    // The catalog route's own contract is unchanged by this ticket — only the
    // promote route, which writes the same column from a wider domain, moved.
    expect(
      createCatalogItemBodySchema.safeParse(
        catalogBody({ targetKind: "subagent" })
      ).success
    ).toBe(false);
  });
});

describe("§3c organization name", () => {
  it("accepts a name at the bound", () => {
    expect(
      updateOrganizationValidator.safeParse({ name: "n".repeat(255) }).success
    ).toBe(true);
  });

  it("refuses one character over", () => {
    // `updateOrganizationLocally` writes the DB BEFORE pushing to Clerk and
    // swallows a Clerk rejection into a log, so an oversized name left the two
    // divergent while the route answered 200.
    expect(
      updateOrganizationValidator.safeParse({ name: "n".repeat(256) }).success
    ).toBe(false);
  });

  it("leaves the existing floor intact", () => {
    expect(updateOrganizationValidator.safeParse({ name: "" }).success).toBe(
      false
    );
    expect(updateOrganizationValidator.safeParse({ name: "n" }).success).toBe(
      true
    );
  });
});
