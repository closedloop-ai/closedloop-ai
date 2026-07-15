import { describe, expect, it } from "vitest";
import { detailTitleKey, resolveDetailTitle } from "../detail-title-context";

describe("detailTitleKey", () => {
  it("namespaces ids by kind so a session and branch id never collide", () => {
    expect(detailTitleKey("session", "x")).toBe("session:x");
    expect(detailTitleKey("branch", "x")).toBe("branch:x");
    expect(detailTitleKey("session", "x")).not.toBe(
      detailTitleKey("branch", "x")
    );
  });
});

describe("resolveDetailTitle", () => {
  const sessionKey = detailTitleKey("session", "s-1");
  const branchKey = detailTitleKey("branch", "b-1");

  it("returns the published title when its key matches the active detail", () => {
    expect(
      resolveDetailTitle({ key: sessionKey, title: "Session One" }, sessionKey)
    ).toBe("Session One");
  });

  it("returns null when the published key belongs to a different detail", () => {
    // The reported transient: the route already shows branch b-1 but the
    // publishing effect still holds the previous session's title for one commit.
    // Falling back to null keeps the new list's fallback ("Branch") instead of
    // flashing the stale session name.
    expect(
      resolveDetailTitle({ key: sessionKey, title: "Session One" }, branchKey)
    ).toBeNull();
  });

  it("returns null on a list page (no active detail key)", () => {
    expect(
      resolveDetailTitle({ key: sessionKey, title: "Session One" }, null)
    ).toBeNull();
  });

  it("returns null while the matching detail is still loading its name", () => {
    expect(
      resolveDetailTitle({ key: sessionKey, title: null }, sessionKey)
    ).toBeNull();
  });
});
