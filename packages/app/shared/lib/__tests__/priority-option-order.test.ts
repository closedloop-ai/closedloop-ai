import { Priority } from "@repo/api/src/types/common";
import { describe, expect, it } from "vitest";
import { PRIORITY_OPTIONS_HIGHEST_FIRST } from "../priority-constants";

describe("priority option order", () => {
  // The design system spells its vocabulary literally because it may not
  // import `@repo/api`, so nothing in the type system catches the two sets
  // diverging — and a value ranked but not persisted becomes selectable in
  // every priority menu. `packages/design-system/__tests__/priority-order.test.ts`
  // owns the order itself; this is the binding it cannot assert.
  it("ranks exactly the values the persisted enum declares", () => {
    expect([...PRIORITY_OPTIONS_HIGHEST_FIRST].sort()).toEqual(
      Object.values(Priority).sort()
    );
  });
});
