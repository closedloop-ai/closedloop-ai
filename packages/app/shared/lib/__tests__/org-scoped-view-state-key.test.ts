import { describe, expect, it } from "vitest";
import {
  orgScopedViewStateKey,
  VIEW_STATE_KEY_SEPARATOR,
} from "../org-scoped-view-state-key";

const BASE_KEY = "table:filters:my-tasks";
const USER = "user_a";
const ORG = "org_a";

describe("orgScopedViewStateKey", () => {
  it("appends the signed-in identity to the base key", () => {
    // Pinned as an independent literal, not rebuilt from the separator const:
    // deriving the expectation from the value under test would keep this green
    // through a separator change that splits every reader's stored view.
    expect(orgScopedViewStateKey(BASE_KEY, USER, ORG)).toBe(
      "table:filters:my-tasks::id:user_a:org_a"
    );
  });

  it("gives two organizations two different keys for the same user", () => {
    expect(orgScopedViewStateKey(BASE_KEY, USER, "org_a")).not.toBe(
      orgScopedViewStateKey(BASE_KEY, USER, "org_b")
    );
  });

  it("gives two users two different keys for the same organization", () => {
    // Two accounts sharing one browser profile and one organization must not
    // share persisted filters — those name teammates by UUID.
    expect(orgScopedViewStateKey(BASE_KEY, "user_a", ORG)).not.toBe(
      orgScopedViewStateKey(BASE_KEY, "user_b", ORG)
    );
  });

  it("never returns the un-namespaced key, so a namespaced read cannot alias the legacy one", () => {
    expect(orgScopedViewStateKey(BASE_KEY, USER, ORG)).not.toBe(BASE_KEY);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ])(
    "returns null for a %s organization rather than a shared bucket",
    (_label, organizationId) => {
      expect(orgScopedViewStateKey(BASE_KEY, USER, organizationId)).toBeNull();
    }
  );

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ])(
    "returns null for a %s user rather than a shared bucket",
    (_label, userId) => {
      expect(orgScopedViewStateKey(BASE_KEY, userId, ORG)).toBeNull();
    }
  );

  it("keeps a base key that already carries an entity id distinguishable from the identity suffix", () => {
    // `table:sort:project-artifacts:<projectId>` already ends in a `:`-joined
    // id. A bare `:` separator would make this key and a base whose last
    // segment happened to be that identity the same string.
    expect(
      orgScopedViewStateKey("table:sort:project-artifacts:proj_1", USER, ORG)
    ).toBe("table:sort:project-artifacts:proj_1::id:user_a:org_a");
    expect(VIEW_STATE_KEY_SEPARATOR).not.toBe(":");
  });
});
