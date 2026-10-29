import { describe, expect, it } from "vitest";
import { isGenericArtifactStatusKey } from "../../generic-artifact-status";
import { ArtifactKind, isArtifactKind } from "../fixtures";

// The four statuses ISS-6251 rules off the status axis, deleted from the const
// by ISS-9303. A bookmarked list URL still carries them as plain strings, so
// the guard has to reject them by VALUE — the type they used to belong to no
// longer exists at runtime to do it.
const RETIRED_STATUS_QUERY_VALUES = [
  "Needs you",
  "Archived",
  "Deprecated",
  "Ready for review",
];

describe("isGenericArtifactStatusKey", () => {
  it.each(RETIRED_STATUS_QUERY_VALUES)("rejects the retired %s", (value) => {
    expect(isGenericArtifactStatusKey(value)).toBe(false);
  });

  it.each(["todo", "in_progress", "in_review", "done", "canceled"])(
    "accepts the canonical root %s",
    (value) => {
      expect(isGenericArtifactStatusKey(value)).toBe(true);
    }
  );
});

describe("isArtifactKind", () => {
  it("rejects a value outside the kind vocabulary", () => {
    expect(isArtifactKind("Epic")).toBe(false);
  });

  it.each(Object.values(ArtifactKind))("accepts the live %s", (value) => {
    expect(isArtifactKind(value)).toBe(true);
  });
});
