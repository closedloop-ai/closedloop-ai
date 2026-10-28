import { describe, expect, it } from "vitest";
import { statusBorderClass } from "../status-border-class";

describe("statusBorderClass", () => {
  it("returns the warning border when waiting, regardless of running", () => {
    expect(statusBorderClass(true, false)).toBe("border-l-2 border-l-warning");
    expect(statusBorderClass(true, true)).toBe("border-l-2 border-l-warning");
  });

  it("returns the success border when running and not waiting", () => {
    expect(statusBorderClass(false, true)).toBe("border-l-2 border-l-success");
  });

  it("returns the neutral card border when neither waiting nor running", () => {
    expect(statusBorderClass(false, false)).toBe("border-border/80");
  });

  it("prioritizes waiting over running (waiting wins the border)", () => {
    // Pinning main's precedence: a subject that is both waiting and running
    // renders as waiting, not running.
    expect(statusBorderClass(true, true)).toBe("border-l-2 border-l-warning");
  });
});
