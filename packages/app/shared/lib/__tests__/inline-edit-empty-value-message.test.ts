import { describe, expect, it } from "vitest";
import {
  InlineEditSubject,
  inlineEditEmptyValueMessage,
} from "../inline-edit-empty-value-message";

/**
 * ISS-9590. The sentences are written out rather than read back from the map,
 * for the reason `value-rejection-message.test.ts` gives: a fixture built from
 * the map agrees with a reworded or deleted entry, which is the drift the map
 * exists to stop.
 *
 * Two subjects, because one cannot tell a per-subject answer from a global one.
 */
describe("inlineEditEmptyValueMessage", () => {
  it("refuses each title in the words that field already shipped", () => {
    expect(inlineEditEmptyValueMessage(InlineEditSubject.DocumentTitle)).toBe(
      "Title cannot be empty"
    );
    expect(inlineEditEmptyValueMessage(InlineEditSubject.ProjectTitle)).toBe(
      "Project title cannot be empty"
    );
  });
});
