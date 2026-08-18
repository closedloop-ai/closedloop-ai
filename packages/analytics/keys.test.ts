import { describe, expect, it } from "vitest";
import { isValidGaMeasurementId } from "./keys";

describe("isValidGaMeasurementId", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["G-placeholder-GAID", false],
    ["UA-12345", false],
    ["G-ABC123", true],
    ["g-lowercase123", true],
  ])("validates %s as %s", (value, expected) => {
    expect(isValidGaMeasurementId(value)).toBe(expected);
  });
});
