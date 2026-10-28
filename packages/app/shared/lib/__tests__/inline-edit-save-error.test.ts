import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import { describe, expect, it } from "vitest";

describe("inline edit feedback copy", () => {
  it("keeps the ISS-10792 save-refusal wording", () => {
    expect(INLINE_EDIT_SAVE_ERROR_MESSAGE).toBe(
      "Couldn't save that change. Try again."
    );
  });
});
