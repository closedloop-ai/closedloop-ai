import { CustomFieldValueRejection } from "@repo/lib/custom-fields/custom-field-editor";
import { describe, expect, it } from "vitest";
import { customFieldValueRejectionMessage } from "../value-rejection-message";

/**
 * ISS-9590. The strings are written out rather than imported from the constants
 * the map reads: a fixture built from those constants agrees with a reworded or
 * deleted one, which is exactly the drift this map exists to stop.
 */
describe("customFieldValueRejectionMessage", () => {
  it("refuses a number and a date in the words each editor already shipped", () => {
    expect(
      customFieldValueRejectionMessage(
        CustomFieldValueRejection.InvalidNumber,
        "12e"
      )
    ).toBe("Enter a valid number");
    expect(
      customFieldValueRejectionMessage(
        CustomFieldValueRejection.InvalidDate,
        "0"
      )
    ).toBe("Enter a valid date");
  });

  it("quotes the draft back when a duration cannot be parsed", () => {
    expect(
      customFieldValueRejectionMessage(
        CustomFieldValueRejection.InvalidDuration,
        "  soon  "
      )
    ).toBe('"soon" isn\'t a duration — try "1h 12m" or "90s".');
  });
});
