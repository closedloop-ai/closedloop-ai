import { describe, expect, it } from "vitest";
import { SessionSortKey, toSessionSortRuleParams } from "../session-sort-group";

describe("SessionSortKey", () => {
  it("keeps Branch out of the shared sortable session keys", () => {
    expect(Object.values(SessionSortKey)).toContain(SessionSortKey.Cost);
    expect(Object.values(SessionSortKey)).toContain(SessionSortKey.Autonomy);
    expect(Object.values(SessionSortKey)).not.toContain("branch");
    expect("Branch" in SessionSortKey).toBe(false);
  });
});

/**
 * ISS-8725: `toSessionSortRuleParams` is the client half of the ordered `sorts`
 * wire contract. Its parameter is declared `fieldId: string`, so the Owner
 * `owner` -> `user` translation is part of THIS helper's own contract and is
 * what these cases pin.
 *
 * SCOPE, because the ticket reads wider than the code: the one production
 * caller (`apps/app/.../sessions/page.tsx`) is fed by `toHostSortRules`
 * (`sessions-list-view-adapter.ts`), which already applies
 * `columnIdToSessionSortKey` and then filters with `isSessionSortKey` — so a
 * literal `owner` cannot arrive from it today and the translation here is a
 * second, idempotent application. These cases therefore guard the helper's
 * declared contract against a future caller, NOT a live mistranslation. The
 * reachable risk on that path is a `fieldId` outside `AGENT_SESSION_SORT_COLUMNS`
 * reaching the route's closed enum, which `toHostSortRules` is the guard for and
 * its own suite owns.
 *
 * Inputs and expectations are INDEPENDENT literals on both sides. Spelling
 * either from `OWNER_COLUMN_ID` / `SessionSortKey` would make the assertion
 * move with the constants it is guarding, and a translation that stopped
 * happening could not fail it.
 */
describe("toSessionSortRuleParams", () => {
  it("translates the Owner column id to the server sort key and passes the rest through", () => {
    expect(
      toSessionSortRuleParams([{ fieldId: "owner", direction: "asc" }])
    ).toEqual(["user:asc"]);
    // The positive half: translation is Owner-ONLY, not a blanket rewrite, so a
    // mapper that rewrote every id would fail here rather than pass the case
    // above on a coincidence.
    expect(
      toSessionSortRuleParams([{ fieldId: "cost", direction: "desc" }])
    ).toEqual(["cost:desc"]);
  });

  it("keeps rule order and translates Owner in a secondary slot too", () => {
    expect(
      toSessionSortRuleParams([
        { fieldId: "status", direction: "desc" },
        { fieldId: "owner", direction: "asc" },
        { fieldId: "cost", direction: "asc" },
      ])
    ).toEqual(["status:desc", "user:asc", "cost:asc"]);
  });

  it("sends nothing for an empty rule list", () => {
    expect(toSessionSortRuleParams([])).toEqual([]);
  });
});
