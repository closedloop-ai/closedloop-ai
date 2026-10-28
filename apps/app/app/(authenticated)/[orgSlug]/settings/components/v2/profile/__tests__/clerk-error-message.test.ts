import { describe, expect, it } from "vitest";
import { describeClerkError } from "../clerk-error-message";

const GENERIC_MESSAGE = "An unexpected error occurred";

describe("describeClerkError", () => {
  it("prefers the Clerk long message, which is the sentence written for a user", () => {
    const message = describeClerkError({
      errors: [
        {
          longMessage:
            "You cannot delete your last sign-in method. Add another one first.",
          message: "Cannot delete",
        },
      ],
    });

    expect(message).toBe(
      "You cannot delete your last sign-in method. Add another one first."
    );
  });

  it("falls back to the short Clerk message when there is no long one", () => {
    expect(describeClerkError({ errors: [{ message: "Cannot delete" }] })).toBe(
      "Cannot delete"
    );
  });

  it("ignores a blank long message rather than rendering an empty sentence", () => {
    expect(
      describeClerkError({
        errors: [{ longMessage: "", message: "Cannot delete" }],
      })
    ).toBe("Cannot delete");
  });

  it("delegates a plain Error to the canonical message helper", () => {
    expect(describeClerkError(new Error("network down"))).toBe("network down");
  });

  it("delegates an error whose errors array is empty", () => {
    expect(describeClerkError({ errors: [] })).toBe(GENERIC_MESSAGE);
  });

  it("delegates a non-object throwable instead of reading properties off it", () => {
    expect(describeClerkError("boom")).toBe(GENERIC_MESSAGE);
    expect(describeClerkError(null)).toBe(GENERIC_MESSAGE);
  });
});
