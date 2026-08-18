import { describe, expect, it } from "vitest";
import { desktopSessionDetailHref } from "../session-hrefs";

describe("desktopSessionDetailHref", () => {
  it("builds an unprefixed session-detail path the port Link resolves", () => {
    // Unprefixed (no leading `#`): the desktop port Link matches this through
    // the route table on left-click and hash-prefixes the rendered anchor
    // itself (FEA-4051). A `#`-prefixed href would make left-clicks a no-op.
    expect(desktopSessionDetailHref({ id: "s-1" })).toBe("/sessions/s-1");
  });

  it("encodes ids containing path separators", () => {
    expect(desktopSessionDetailHref({ id: "owner/repo::run/x" })).toBe(
      "/sessions/owner%2Frepo%3A%3Arun%2Fx"
    );
  });
});
