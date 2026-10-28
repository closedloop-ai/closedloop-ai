import { describe, expect, it } from "vitest";
import { appliedTagMessage } from "./bulk-tag-labels";

describe("appliedTagMessage", () => {
  it("uses the host's count noun in the existing tag-result sentence", () => {
    const noun = { one: "artifact", other: "artifacts" };

    expect(appliedTagMessage("Urgent", 1, noun)).toBe(
      'Applied "Urgent" to 1 artifact'
    );
    expect(appliedTagMessage("Urgent", 2, noun)).toBe(
      'Applied "Urgent" to 2 artifacts'
    );
  });
});
