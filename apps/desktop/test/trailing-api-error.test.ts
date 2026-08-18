import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasTrailingUnrecoveredApiError } from "../src/main/database/trailing-api-error.js";

describe("hasTrailingUnrecoveredApiError", () => {
  it("returns false when no API errors (null lastApiErrorTs)", () => {
    assert.equal(
      hasTrailingUnrecoveredApiError(null, "2026-07-01T12:00:00.000Z"),
      false
    );
  });

  it("returns true when trailing error (after last assistant)", () => {
    assert.equal(
      hasTrailingUnrecoveredApiError(
        "2026-07-01T12:05:00.000Z",
        "2026-07-01T12:00:00.000Z"
      ),
      true
    );
  });

  it("returns false when recovered error (before last assistant)", () => {
    assert.equal(
      hasTrailingUnrecoveredApiError(
        "2026-07-01T12:00:00.000Z",
        "2026-07-01T12:05:00.000Z"
      ),
      false
    );
  });

  it("returns true when timestamps are equal (>= edge case)", () => {
    const ts = "2026-07-01T12:00:00.000Z";
    assert.equal(hasTrailingUnrecoveredApiError(ts, ts), true);
  });

  it("returns true when error exists but no assistant messages", () => {
    assert.equal(
      hasTrailingUnrecoveredApiError("2026-07-01T12:00:00.000Z", null),
      true
    );
  });

  it("returns false when both timestamps are null", () => {
    assert.equal(hasTrailingUnrecoveredApiError(null, null), false);
  });
});
