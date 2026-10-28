/**
 * `display-value.ts` must import nothing from `@repo/database`.
 *
 * Same hazard as `reference-targets-import-contract.test.ts`: this module is
 * pulled in by `utils.ts` and `value-projections.ts`, which a wide set of suites
 * import while mocking `@repo/database` with `withDb` alone. A module that
 * dereferences a generated Prisma enum at import time makes those suites die at
 * COLLECTION, with an error naming none of the files involved.
 *
 * NOTE THE ABSENT `vi.mock`. That is the assertion: this file registers no mock
 * at all, so if `display-value.ts` ever grows a `@repo/database` edge that
 * touches the generated client, importing it here fails.
 */
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { describe, expect, it } from "vitest";

describe("display-value.ts import contract", () => {
  it("loads and resolves a value with no @repo/database mock present", async () => {
    const module = await import("../display-value");

    expect(
      module.resolveDisplayValue(CustomFieldType.Text, "cached", [], [])
    ).toBe("cached");
    expect(module.MULTI_VALUE_DISPLAY_SEPARATOR).toBe(", ");
  });
});
