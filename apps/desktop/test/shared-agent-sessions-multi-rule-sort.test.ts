import assert from "node:assert/strict";
import { formatSessionSortRule } from "@repo/api/src/types/agent-session-sort";
import { describe, test } from "vitest";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { LocalSessionSortColumn } from "../src/main/session/session-sort-columns.js";
import { sessionSortKeyForQuery } from "../src/main/session/session-working-set-sort.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  SharedAgentSessionsInputError,
  sanitizeQuery,
} from "../src/main/session/shared-agent-sessions-query.js";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../src/shared/session-date-window-contract.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * ISS-8679: the desktop-local session source applies ONE sort rule, so it must
 * REFUSE the ISS-8335 multi-rule `sorts` list rather than order by the lead rule
 * and drop the rest.
 *
 * Every fixture below shares one harness, so the PRIMARY rule (`harness`) TIES
 * across all three rows and decides nothing — the assertions can only be
 * satisfied by behaviour that reads the SECOND rule. A fixture whose primary key
 * was distinct would pass on the primary alone and prove nothing, which is the
 * vacuity the ISS-8335 lane hit.
 */

const TIED_HARNESS = "claude";
const REPO_ALPHA = "closedloop-ai/alpha";
const REPO_MARISOL = "closedloop-ai/marisol";
const REPO_ZULU = "closedloop-ai/zulu";
/** Incoming (cursor) order — deliberately NOT the repo-ascending order. */
const INCOMING_ORDER = ["row-zulu", "row-alpha", "row-marisol"];
const REPO_ASCENDING_ORDER = ["row-alpha", "row-marisol", "row-zulu"];
const MULTI_RULE_REFUSAL_PATTERN = /ordered rules/;
const MALFORMED_RULE_PATTERN = /not a <column>:<dir> rule/;
const BAD_DIRECTION_PATTERN = /direction that is not asc or desc/;
const OVERSIZED_LIST_PATTERN = /carries more than \d+ entries/;
const NOT_A_LIST_PATTERN = /sorts is not a list/;
const UNSUPPORTED_COLUMN_PATTERN = /column the local session source cannot/;
/**
 * A real v2 toolbar sort key (`SessionSortKey.Autonomy`) with no case in the
 * desktop `sessionSortKey` switch. Spelled here rather than imported: the main
 * process cannot reach `@repo/app` (it is absent from the packaged
 * `WORKSPACE_INLINE` set), which is precisely why the two vocabularies need
 * pinning by test rather than by type.
 */
const UNSUPPORTED_COLUMN = "autonomy";
/** Distinct from the fixture's `startedAt`, so the two keys can be told apart. */
const DRIFT_LAST_ACTIVITY = "2026-01-01T03:00:00.000Z";

describe("desktop-local sessions source, multi-rule sorts", () => {
  test("refuses a two-rule sort instead of ordering by the primary rule alone", async () => {
    // The tie is what makes this assertion non-vacuous: ordering by `harness`
    // alone cannot move a row, so the primary-only answer IS the incoming order
    // and it differs from what the second rule asks for.
    const primaryOnly = await getSharedAgentSessions(tiedHarnessSource(), {
      sortBy: "harness",
      sortDir: "asc",
    });
    assert.deepEqual(ids(primaryOnly.items), INCOMING_ORDER);

    const secondRuleAlone = await getSharedAgentSessions(tiedHarnessSource(), {
      sortBy: "repo",
      sortDir: "asc",
    });
    assert.deepEqual(ids(secondRuleAlone.items), REPO_ASCENDING_ORDER);
    // Both orders are OBSERVED, not restated constants: the second rule really
    // does move these rows, so a refusal cannot be mistaken for the primary-only
    // answer happening to be right.
    assert.notDeepEqual(ids(secondRuleAlone.items), ids(primaryOnly.items));

    // The same read with the second rule stacked on: refused, not silently
    // answered with the primary-only order asserted above.
    await assert.rejects(
      () =>
        getSharedAgentSessions(tiedHarnessSource(), {
          // The back-compat echo of the lead rule the v2 host sends alongside
          // `sorts`. Reading it while ignoring `sorts` is the defect.
          sortBy: "harness",
          sortDir: "asc",
          sorts: [
            formatSessionSortRule("harness", "asc"),
            formatSessionSortRule("repo", "asc"),
          ],
        }),
      (error: unknown) =>
        error instanceof SharedAgentSessionsInputError &&
        MULTI_RULE_REFUSAL_PATTERN.test(error.message)
    );
  });

  test("applies a single-rule sorts list rather than dropping it for the scalar pair", async () => {
    // No `sortBy` echo at all, so a source that only reads the scalar pair
    // orders by nothing and answers in the incoming order.
    const response = await getSharedAgentSessions(tiedHarnessSource(), {
      sorts: [formatSessionSortRule("repo", "asc")],
    });

    assert.deepEqual(ids(response.items), REPO_ASCENDING_ORDER);
  });

  test("collapses a repeated column the way the cloud does instead of refusing it", async () => {
    // Two entries, ONE column: `resolveSessionSortRules` de-duplicates by column
    // and applies the first, so desktop must not call this a two-rule request.
    const response = await getSharedAgentSessions(tiedHarnessSource(), {
      sorts: [
        formatSessionSortRule("repo", "asc"),
        formatSessionSortRule("repo", "desc"),
      ],
    });

    assert.deepEqual(ids(response.items), REPO_ASCENDING_ORDER);
  });

  test("refuses a malformed sorts entry instead of ordering by what parsed", async () => {
    await assert.rejects(
      () =>
        getSharedAgentSessions(tiedHarnessSource(), {
          sorts: [formatSessionSortRule("repo", "asc"), "repo"],
        }),
      (error: unknown) =>
        error instanceof SharedAgentSessionsInputError &&
        MALFORMED_RULE_PATTERN.test(error.message)
    );
  });

  // Every other array on this query is coerced with `coerceStringArray`, which
  // DROPS an empty or non-string entry. Doing that here would answer a two-rule
  // request with one rule and no error — the silent drop under another name.
  test("refuses an empty or non-string sorts entry rather than filtering it out", async () => {
    for (const junk of ["", "   ", 42, null]) {
      await assert.rejects(
        () =>
          getSharedAgentSessions(tiedHarnessSource(), {
            sorts: [formatSessionSortRule("repo", "asc"), junk] as string[],
          }),
        (error: unknown) =>
          error instanceof SharedAgentSessionsInputError &&
          MALFORMED_RULE_PATTERN.test(error.message),
        `a sorts entry of ${JSON.stringify(junk)} was not refused`
      );
    }
  });

  test("refuses a sorts value that is not a list at all", async () => {
    await assert.rejects(
      () =>
        getSharedAgentSessions(tiedHarnessSource(), {
          sorts: formatSessionSortRule("repo", "asc") as unknown as string[],
        }),
      (error: unknown) =>
        error instanceof SharedAgentSessionsInputError &&
        NOT_A_LIST_PATTERN.test(error.message)
    );
  });

  // The dedup fold scans what it has accumulated, so an unbounded caller list
  // would be walked quadratically on the single-threaded main process before
  // the one-rule refusal could fire. The bound is checked first.
  test("refuses an oversized sorts list before parsing its entries", async () => {
    const entries = Array.from({ length: 64 }, (_, index) =>
      formatSessionSortRule(`column-${index}`, "asc")
    );

    await assert.rejects(
      () => getSharedAgentSessions(tiedHarnessSource(), { sorts: entries }),
      (error: unknown) =>
        error instanceof SharedAgentSessionsInputError &&
        OVERSIZED_LIST_PATTERN.test(error.message)
    );
  });

  // `parseSessionSortRule` splits the entry and nothing more, so an
  // unrecognized direction parses cleanly. Folding it to `desc` would answer a
  // rule nobody asked for — the same silent substitution as dropping it — and
  // the cloud validator rejects it outright.
  test("refuses a sorts entry whose direction is neither asc nor desc", async () => {
    await assert.rejects(
      () =>
        getSharedAgentSessions(tiedHarnessSource(), {
          sorts: [formatSessionSortRule("repo", "ASC")],
        }),
      (error: unknown) =>
        error instanceof SharedAgentSessionsInputError &&
        BAD_DIRECTION_PATTERN.test(error.message)
    );
  });

  // An entry is unreadable when its COLUMN is one this source cannot order by,
  // not only when its shape or direction is wrong. `autonomy` is a real v2
  // toolbar sort key with no case in `sessionSortKey`, so accepting it served
  // the `default` arm's started order under the autonomy column's name.
  test("refuses a sorts entry naming a column this source cannot order by", async () => {
    await assert.rejects(
      () =>
        getSharedAgentSessions(tiedHarnessSource(), {
          sorts: [formatSessionSortRule(UNSUPPORTED_COLUMN, "asc")],
        }),
      (error: unknown) =>
        error instanceof SharedAgentSessionsInputError &&
        UNSUPPORTED_COLUMN_PATTERN.test(error.message)
    );
  });

  // The other end of that refusal: narrowing the column must not start refusing
  // one the comparator does implement, so every member of the closed set is
  // asserted to resolve to ITSELF rather than merely "not throw".
  test("accepts every column in the closed set", () => {
    for (const column of Object.values(LocalSessionSortColumn)) {
      const sanitized = sanitizeQuery(
        { sorts: [formatSessionSortRule(column, "asc")] },
        SESSIONS_SURFACE_DATE_WINDOW_FIELD
      );

      assert.deepEqual(
        { sortBy: sanitized.sortBy, sortDir: sanitized.sortDir },
        { sortBy: column, sortDir: "asc" }
      );
    }
  });

  // `LocalSessionSortColumn` and the `sessionSortKey` switch are one vocabulary
  // in two files, and the test above cannot tell them apart on its own — it
  // walks the set, so a member the comparator does NOT implement passes it.
  // This pins the two against the switch's `default` (started) arm, the arm that
  // made an unrecognized column indistinguishable from a real one and therefore
  // the whole reason a column outside the set is refused. A member with no case
  // of its own collapses onto the started key; a non-member the comparator is
  // newly taught stops collapsing onto it. Either drift turns this red.
  test("pins the closed set to the columns the comparator implements", () => {
    const row = session({
      id: "row-drift",
      lastActivityAt: DRIFT_LAST_ACTIVITY,
      repositoryFullName: REPO_ALPHA,
    });
    const startedKey = sessionSortKeyForQuery(
      row,
      sortedBy(LocalSessionSortColumn.Started)
    );

    for (const column of Object.values(LocalSessionSortColumn)) {
      if (column !== LocalSessionSortColumn.Started) {
        assert.notDeepEqual(
          sessionSortKeyForQuery(row, sortedBy(column)),
          startedKey,
          `${column} is in the closed set, but the comparator answers it with the started key`
        );
      }
    }

    assert.deepEqual(
      sessionSortKeyForQuery(row, sortedBy(UNSUPPORTED_COLUMN)),
      startedKey
    );
  });
});

/** A `SanitizedQuery` carrying nothing but the sort under test. */
function sortedBy(column: string) {
  return sanitizeQuery({ sortBy: column }, SESSIONS_SURFACE_DATE_WINDOW_FIELD);
}

function ids(items: readonly { id: string }[]): string[] {
  return items.map((item) => item.id);
}

/**
 * Three rows sharing {@link TIED_HARNESS} — the primary sort key ties — whose
 * repositories order them differently from the cursor order they arrive in.
 */
function tiedHarnessSource(): AgentSessionSyncSource {
  return createFakeSource({
    cursorRows: INCOMING_ORDER.map((id) => cursor(id)),
    sessions: {
      "row-zulu": session({
        id: "row-zulu",
        harness: TIED_HARNESS,
        repositoryFullName: REPO_ZULU,
      }),
      "row-alpha": session({
        id: "row-alpha",
        harness: TIED_HARNESS,
        repositoryFullName: REPO_ALPHA,
      }),
      "row-marisol": session({
        id: "row-marisol",
        harness: TIED_HARNESS,
        repositoryFullName: REPO_MARISOL,
      }),
    },
  });
}
