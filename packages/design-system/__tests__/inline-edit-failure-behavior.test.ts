import {
  assertInlineEditFailureBehavior,
  BLANK_INLINE_EDIT_SAVE_ERROR_MESSAGE,
} from "@closedloop-ai/design-system/components/ui/inline-edit-failure-behavior";
import { describe, expect, it } from "vitest";

/**
 * PRD-722: retaining a refused draft is an opt-in that must always come with
 * the host's message beside it. `string` cannot exclude a blank, so the guard
 * refuses one at runtime; the compatibility policy (no opt-in) needs no message
 * and must never throw.
 */

const MESSAGE = "Sample save failure.";

describe("assertInlineEditFailureBehavior", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", " \t\n"],
  ])("refuses a retained policy with a %s message", (_case, message) => {
    expect(() => assertInlineEditFailureBehavior(true, message)).toThrow(
      BLANK_INLINE_EDIT_SAVE_ERROR_MESSAGE
    );
  });

  it("accepts a retained policy with a message", () => {
    expect(() => assertInlineEditFailureBehavior(true, MESSAGE)).not.toThrow();
  });

  it.each([
    ["omitted", undefined],
    ["false", false],
  ] as const)(
    "accepts the compatibility policy when the opt-in is %s",
    (_case, retain) => {
      expect(() =>
        assertInlineEditFailureBehavior(retain, undefined)
      ).not.toThrow();
      expect(() => assertInlineEditFailureBehavior(retain, "")).not.toThrow();
      expect(() =>
        assertInlineEditFailureBehavior(retain, MESSAGE)
      ).not.toThrow();
    }
  );
});
