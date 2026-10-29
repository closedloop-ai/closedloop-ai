import { describe, expect, it } from "vitest";
import { signalReadingOf, unrecordedSignal } from "./claude-code-telemetry";

describe("unrecordedSignal", () => {
  it("is not recorded with a null count", () => {
    expect(unrecordedSignal()).toEqual({ recorded: false, count: null });
  });
});

describe("signalReadingOf", () => {
  it.each([null, undefined])("maps a %s count to never recorded", (count) => {
    expect(signalReadingOf(count)).toEqual({ recorded: false, count: null });
  });

  it("keeps a stored zero as a recorded zero, not as never recorded", () => {
    expect(signalReadingOf(0)).toEqual({ recorded: true, count: 0 });
  });

  it("carries a positive count through as recorded", () => {
    expect(signalReadingOf(7)).toEqual({ recorded: true, count: 7 });
  });
});
