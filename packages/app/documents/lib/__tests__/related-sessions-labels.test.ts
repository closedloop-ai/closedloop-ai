import { describe, expect, it } from "vitest";
import {
  RELATED_SESSIONS_EMPTY_MESSAGE,
  RELATED_SESSIONS_SECTION_TITLE,
} from "../related-sessions-labels";

describe("related-sessions-labels", () => {
  it("pins the section title", () => {
    expect(RELATED_SESSIONS_SECTION_TITLE).toBe("Related Sessions");
  });

  it("has a non-empty empty-state message that names the field's contents", () => {
    expect(typeof RELATED_SESSIONS_EMPTY_MESSAGE).toBe("string");
    expect(RELATED_SESSIONS_EMPTY_MESSAGE.length).toBeGreaterThan(0);
    expect(RELATED_SESSIONS_EMPTY_MESSAGE).toContain("sessions");
  });

  it("renders the empty message as a full sentence, not a bare dash", () => {
    expect(RELATED_SESSIONS_EMPTY_MESSAGE).toBe(
      "No sessions have contributed to this artifact yet."
    );
    expect(RELATED_SESSIONS_EMPTY_MESSAGE.endsWith(".")).toBe(true);
  });
});
