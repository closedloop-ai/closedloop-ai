import { describe, expect, it } from "vitest";
import {
  resolveSessionNotificationTitle,
  UNTITLED_SESSION_LABEL,
} from "../shared/notification-labels";

const SAMPLE_UUID = "f9bdb32c-bebc-4d2a-a416-4f07a7a6b85e";

describe("resolveSessionNotificationTitle", () => {
  it("returns a real human-readable title unchanged", () => {
    expect(resolveSessionNotificationTitle("Fix the login flow")).toBe(
      "Fix the login flow"
    );
  });

  it("trims surrounding whitespace from a real title", () => {
    expect(resolveSessionNotificationTitle("  Refactor parser  ")).toBe(
      "Refactor parser"
    );
  });

  it("falls back to the readable label when the title is a raw UUID (FEA-3969)", () => {
    const label = resolveSessionNotificationTitle(SAMPLE_UUID);
    expect(label).toBe(UNTITLED_SESSION_LABEL);
    expect(label).not.toContain(SAMPLE_UUID);
  });

  it("treats an uppercase UUID as a raw id, not a title", () => {
    expect(resolveSessionNotificationTitle(SAMPLE_UUID.toUpperCase())).toBe(
      UNTITLED_SESSION_LABEL
    );
  });

  it("falls back when the title is missing", () => {
    expect(resolveSessionNotificationTitle(undefined)).toBe(
      UNTITLED_SESSION_LABEL
    );
    expect(resolveSessionNotificationTitle(null)).toBe(UNTITLED_SESSION_LABEL);
  });

  it("falls back when the title is blank or whitespace-only", () => {
    expect(resolveSessionNotificationTitle("")).toBe(UNTITLED_SESSION_LABEL);
    expect(resolveSessionNotificationTitle("   ")).toBe(UNTITLED_SESSION_LABEL);
  });

  it("falls back when the title is a non-string value", () => {
    expect(resolveSessionNotificationTitle(42)).toBe(UNTITLED_SESSION_LABEL);
    expect(resolveSessionNotificationTitle({})).toBe(UNTITLED_SESSION_LABEL);
  });

  it("keeps a title that merely contains a UUID (not a bare id)", () => {
    const title = `Session ${SAMPLE_UUID} follow-up`;
    expect(resolveSessionNotificationTitle(title)).toBe(title);
  });

  it("falls back for the legacy synthetic `Session <uuid>` name (FEA-3969)", () => {
    const label = resolveSessionNotificationTitle(`Session ${SAMPLE_UUID}`);
    expect(label).toBe(UNTITLED_SESSION_LABEL);
    expect(label).not.toContain(SAMPLE_UUID);
  });

  it("falls back for the legacy `Session <uuid>` name with an uppercase id", () => {
    expect(
      resolveSessionNotificationTitle(`Session ${SAMPLE_UUID.toUpperCase()}`)
    ).toBe(UNTITLED_SESSION_LABEL);
  });
});
