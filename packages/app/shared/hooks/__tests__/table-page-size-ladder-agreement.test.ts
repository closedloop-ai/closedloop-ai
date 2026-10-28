import {
  BRANCH_LIST_SERVER_PAGE_SIZE_MAX,
  BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS,
} from "@repo/api/src/types/branch-list-contract";
import { TABLE_PAGE_SIZE_MAX } from "@repo/api/src/types/table-page-size-limits";
import {
  TABLE_PAGE_SIZE_OPTIONS,
  TABLE_PAGE_SIZE_OPTIONS_EXTENDED,
} from "@repo/design-system/components/ui/table-page-size-select";
import { describe, expect, it } from "vitest";

/**
 * ISS-9692 — the ladder the UI OFFERS never outruns what the servers ACCEPT.
 *
 * The two cannot be one declaration: `@repo/design-system` is a
 * project-agnostic product and is gated from importing `@repo/api`, and
 * `@repo/api` cannot import a React package back without dragging it into the
 * API server's build graph. This package imports both, so this is where the
 * agreement is held.
 *
 * It is the half of the guard that lives outside `apps/api` — the sibling
 * `apps/api/__tests__/unit/list-page-size-caps.test.ts` drives each real
 * validator at `TABLE_PAGE_SIZE_MAX`; this file is what makes that value the
 * largest rung a reader is actually offered, rather than a number chosen to
 * match the test.
 */
describe("shared rows-per-page ladder", () => {
  it("offers nothing larger than every list endpoint's cap", () => {
    expect(Math.max(...TABLE_PAGE_SIZE_OPTIONS_EXTENDED)).toBe(
      TABLE_PAGE_SIZE_MAX
    );
  });

  it("keeps the base ladder a prefix of the extended one", () => {
    // The flag adds rungs, it never moves or removes one — a reader who turns
    // the flag off must land back on exactly the ladder that shipped.
    expect(
      TABLE_PAGE_SIZE_OPTIONS_EXTENDED.slice(0, TABLE_PAGE_SIZE_OPTIONS.length)
    ).toEqual([...TABLE_PAGE_SIZE_OPTIONS]);
  });

  it("offers the two rungs this ticket exists to add", () => {
    expect(TABLE_PAGE_SIZE_OPTIONS_EXTENDED).toContain(250);
    expect(TABLE_PAGE_SIZE_OPTIONS_EXTENDED).toContain(500);
  });

  it("keeps every offered rung inside the Branches wire contract", () => {
    // Branches validates its `limit` by MEMBERSHIP, not by a ceiling, so a rung
    // the ladder offers and this list omits is rejected outright even though it
    // is under the cap.
    const accepted = new Set<number>(BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS);
    const unaccepted = TABLE_PAGE_SIZE_OPTIONS_EXTENDED.filter(
      (option) => !accepted.has(option)
    );

    expect(unaccepted).toEqual([]);
  });

  it("keeps the Branches cap derived from a set that covers the ladder", () => {
    expect(BRANCH_LIST_SERVER_PAGE_SIZE_MAX).toBe(TABLE_PAGE_SIZE_MAX);
  });
});
