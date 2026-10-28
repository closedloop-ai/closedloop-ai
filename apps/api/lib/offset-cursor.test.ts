import { describe, expect, it } from "vitest";
import { nextOffsetCursor } from "./offset-cursor";

const MAX_OFFSET = 10_000;

describe("nextOffsetCursor", () => {
  it("mints the next offset while rows remain below the ceiling", () => {
    expect(nextOffsetCursor(50, 500, MAX_OFFSET)).toBe("50");
  });

  it("withholds the cursor once the page has consumed the population", () => {
    expect(nextOffsetCursor(500, 500, MAX_OFFSET)).toBeNull();
  });

  it("still mints the cursor when the next offset lands exactly on the ceiling", () => {
    expect(nextOffsetCursor(MAX_OFFSET, MAX_OFFSET + 5, MAX_OFFSET)).toBe(
      String(MAX_OFFSET)
    );
  });

  it("withholds the cursor one past the ceiling even though rows remain", () => {
    // The schema bounds `cursor` by the same ceiling, so minting this token
    // would make the endpoint answer 400 to a cursor it issued itself.
    expect(nextOffsetCursor(MAX_OFFSET + 1, MAX_OFFSET + 500, MAX_OFFSET)).toBe(
      null
    );
  });

  it("withholds the cursor far past the ceiling", () => {
    expect(
      nextOffsetCursor(MAX_OFFSET * 3, MAX_OFFSET * 4, MAX_OFFSET)
    ).toBeNull();
  });
});
