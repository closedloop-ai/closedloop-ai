import { describe, expect, it } from "vitest";
import { SessionSortKey } from "../session-sort-group";

describe("SessionSortKey", () => {
  it("keeps Branch out of the shared sortable session keys", () => {
    expect(Object.values(SessionSortKey)).toContain(SessionSortKey.Cost);
    expect(Object.values(SessionSortKey)).not.toContain("branch");
    expect("Branch" in SessionSortKey).toBe(false);
  });
});
