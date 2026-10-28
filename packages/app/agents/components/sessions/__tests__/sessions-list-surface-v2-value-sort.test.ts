import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { Priority } from "@repo/api/src/types/common";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { TableGroupOrder } from "@repo/design-system/components/ui/table-toolbar-model";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentSessionToSessionTableRow } from "../../../lib/session-table-row";
import {
  SESSIONS_AUTONOMY_COLUMN_ID,
  SESSIONS_COLUMN_SPECS,
  SESSIONS_PRIORITY_COLUMN_ID,
  SESSIONS_UPDATED_COLUMN_ID,
} from "../../../lib/sessions-table-columns";
import {
  createAgentSessionListItemFixture,
  createSessionTableRowFixture,
  HOUR_MS,
  MINUTE_MS,
  SESSION_FIXTURE_NOW_MS,
} from "../session-list-fixtures";
import {
  buildGroups,
  isSortableSpec,
  SESSIONS_SORTABLE_IDS_WITHOUT_SORT_RULE,
  sortRows,
} from "../sessions-list-surface-rows";
import type { SessionsListSortField } from "../sessions-list-view-state";

/**
 * ISS-8013: Cost, Duration, Started, Updated and Last active are `sortable: true`
 * and used to sort on the string their cell renders — `$1,234.00` ranked below
 * `$9.50`, `2h 40m` below `5m`. This pins each of them to its UNDERLYING value.
 *
 * The fixture is the whole test. Every column here is built so the
 * lexicographic order of the LABELS and the true order of the VALUES DISAGREE —
 * `expectsLexicographicDisagreement` proves that per column rather than
 * asserting it from memory, because against any other fixture the buggy and the
 * correct implementation return the same list and the assertion proves nothing.
 *
 * The five true orders are also pairwise DISTINCT (cost `b,a,c`, duration
 * `c,a,b`, started `a,b,c`, updated `c,b,a`, last active `a,c,b`), so a reader
 * wired to a neighbouring field — the `updated`/`lastActivity` confusion
 * ISS-6005 already had to separate once — fails here rather than passing on a
 * coincidence.
 */

/** Pinned clock. Every label below is relative to it, so nothing drifts. */
const NOW = new Date("2026-06-01T15:00:00.000Z");

/**
 * A terminal row, so the Duration window is `end - start` rather than a span
 * measured against `NOW` — see `resolveSessionDurationWindow`.
 */
function terminalSession(
  overrides: Record<string, unknown>
): AgentSessionListItem {
  return createAgentSessionListItemFixture({
    prs: [],
    prsMerged: 0,
    status: SESSION_STATUS.INACTIVE,
    ...overrides,
  });
}

const SESSION_A = terminalSession({
  id: "ses-a",
  name: "a",
  startedAt: new Date("2026-05-27T15:00:00.000Z"),
  endedAt: new Date("2026-05-27T15:09:00.000Z"),
  lastActivityAt: new Date("2026-05-27T15:09:00.000Z"),
  recordUpdatedAt: new Date("2026-06-01T14:50:00.000Z"),
  estimatedCost: 100,
});

const SESSION_B = terminalSession({
  id: "ses-b",
  name: "b",
  startedAt: new Date("2026-06-01T12:00:00.000Z"),
  endedAt: new Date("2026-06-01T14:40:00.000Z"),
  lastActivityAt: new Date("2026-06-01T14:40:00.000Z"),
  recordUpdatedAt: new Date("2026-06-01T14:40:00.000Z"),
  estimatedCost: 1234,
});

const SESSION_C = terminalSession({
  id: "ses-c",
  name: "c",
  startedAt: new Date("2026-06-01T14:15:00.000Z"),
  endedAt: new Date("2026-06-01T14:20:00.000Z"),
  lastActivityAt: new Date("2026-06-01T14:20:00.000Z"),
  recordUpdatedAt: new Date("2026-06-01T14:20:00.000Z"),
  estimatedCost: 9.5,
});

/** Column id → the label its cell renders, for the disagreement proof below. */
const LABEL_READERS: Readonly<
  Record<string, (row: SessionTableRow) => string>
> = {
  cost: (row) => row.costLabel,
  duration: (row) => row.durationLabel ?? "",
  started: (row) => row.startedLabel ?? "",
  updated: (row) => row.updatedLabel ?? "",
  lastActivity: (row) => row.lastActivityLabel ?? "",
};

let rows: SessionTableRow[] = [];

/**
 * The clock is pinned for the MAPPING and nothing else.
 *
 * `agentSessionToSessionTableRow` resolves its relative labels against the
 * ambient clock, so the rows have to be built under a frozen one or they drift.
 * No case BELOW needs it: `sortRows` and `buildGroups` are pure over the rows
 * built here. Restoring inside the hook keeps the frozen clock off every test
 * body rather than leaving it installed for the whole file (whitlockk, PR #6009) —
 * `finally`, so a throw in the mapper cannot leak it either.
 */
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  try {
    rows = [SESSION_A, SESSION_B, SESSION_C].map((item) =>
      agentSessionToSessionTableRow(item, null, { now: NOW })
    );
  } finally {
    vi.useRealTimers();
  }
});

/**
 * Root AGENTS' restoration rule. The hook above already unwinds the only
 * installation this file makes; this is what stops a case added later from
 * installing its own and handing it to the next one.
 */
afterEach(() => {
  vi.useRealTimers();
});

describe("SessionsListSurfaceV2 value-sort fixture", () => {
  it("leaves no frozen clock installed for the cases that follow", () => {
    expect(vi.isFakeTimers()).toBe(false);
  });
});

function idsSortedBy(
  field: SessionsListSortField,
  direction: "asc" | "desc"
): string[] {
  return sortRows(rows, field, direction).map((row) => row.id);
}

/**
 * The order the OLD, defective sort produced: `localeCompare` over the label
 * each cell renders. Computed from the fixture's own labels rather than
 * hardcoded, so the anti-vacuity check below stays true if a formatter changes
 * and fails loudly the moment the fixture stops discriminating.
 */
function idsInLexicographicLabelOrder(field: string): string[] {
  const readLabel = LABEL_READERS[field];
  return [...rows]
    .sort((left, right) =>
      (readLabel?.(left) ?? "").localeCompare(readLabel?.(right) ?? "")
    )
    .map((row) => row.id);
}

const VALUE_SORTED_CASES: readonly {
  field: SessionsListSortField;
  ascending: readonly string[];
}[] = [
  { field: "cost", ascending: ["ses-c", "ses-a", "ses-b"] },
  { field: "duration", ascending: ["ses-c", "ses-a", "ses-b"] },
  { field: "started", ascending: ["ses-a", "ses-b", "ses-c"] },
  { field: "updated", ascending: ["ses-c", "ses-b", "ses-a"] },
  { field: "lastActivity", ascending: ["ses-a", "ses-c", "ses-b"] },
];

describe("SessionsListSurfaceV2 value sorting", () => {
  for (const { field, ascending } of VALUE_SORTED_CASES) {
    it(`sorts ${field} by its underlying value, not its label`, () => {
      // Anti-vacuity FIRST: against a fixture where the two agree, the buggy
      // and the correct implementation return the same list and the two
      // assertions below prove nothing.
      expect(idsInLexicographicLabelOrder(field)).not.toEqual(ascending);
      expect(idsSortedBy(field, "asc")).toEqual(ascending);
      expect(idsSortedBy(field, "desc")).toEqual([...ascending].reverse());
    });
  }
});

/**
 * A row with none of the five values — the version-skewed producer. It must be
 * parked LAST in both directions rather than leading the ascending list as
 * though it were the cheapest, shortest or oldest run on the page.
 *
 * ISS-8013 (codex, PR #6009): every raw value is nulled EXPLICITLY. The fixture
 * default now carries the number behind each label it sets, so relying on their
 * absence would silently make this row a measured one and stop it describing the
 * case it is named for.
 */
const UNMEASURED_ROW: SessionTableRow = createSessionTableRowFixture({
  id: "ses-unmeasured",
  costLabel: "—",
  costValue: null,
  durationLabel: null,
  durationMs: null,
  startedLabel: null,
  startedAtMs: null,
  updatedLabel: null,
  updatedAtMs: null,
  lastActivityLabel: null,
  lastActivityAtMs: null,
});

describe("SessionsListSurfaceV2 value sorting with no value", () => {
  for (const { field, ascending } of VALUE_SORTED_CASES) {
    it(`parks a ${field}-less row last in both directions`, () => {
      const mixed = [UNMEASURED_ROW, ...rows];

      expect(sortRows(mixed, field, "asc").at(-1)?.id).toBe("ses-unmeasured");
      expect(sortRows(mixed, field, "desc").at(-1)?.id).toBe("ses-unmeasured");
      // The positive sibling on the same subject: a row that DOES carry a value
      // moves to the head of the ascending list, so "last" above cannot be
      // satisfied by a comparator that simply left the input order alone.
      expect(sortRows(mixed, field, "asc")[0]?.id).toBe(ascending[0]);
    });
  }
});

/**
 * ISS-10332 review: the wire boundary lets a priority value outside this build's
 * vocabulary through (`SessionTableRow.priority` is narrower than the wire), and
 * the reader used to index `PRIORITY_ORDINAL` raw — `undefined` into a numeric
 * comparator, so one skewed row corrupted the whole page's order. The unknown
 * member now parks with the unset row, last in both directions.
 */
describe("SessionsListSurfaceV2 priority sort with a member this build does not know", () => {
  const unknown = createSessionTableRowFixture({
    id: "ses-unknown-priority",
    priority: "CRITICAL" as Priority,
  });
  const unset = createSessionTableRowFixture({
    id: "ses-unset-priority",
    priority: null,
  });
  const ranked = [
    createSessionTableRowFixture({ id: "ses-high", priority: Priority.High }),
    createSessionTableRowFixture({ id: "ses-low", priority: Priority.Low }),
  ];

  it("parks the unknown member with the unset row, after every ranked one, in both directions", () => {
    const mixed = [unknown, ...ranked, unset];
    const ascending = sortRows(mixed, SESSIONS_PRIORITY_COLUMN_ID, "asc").map(
      (row) => row.id
    );
    const descending = sortRows(mixed, SESSIONS_PRIORITY_COLUMN_ID, "desc").map(
      (row) => row.id
    );

    expect(ascending.slice(0, 2)).toEqual(["ses-low", "ses-high"]);
    expect(descending.slice(0, 2)).toEqual(["ses-high", "ses-low"]);
    for (const order of [ascending, descending]) {
      expect(new Set(order.slice(2))).toEqual(
        new Set(["ses-unknown-priority", "ses-unset-priority"])
      );
    }
  });
});

/**
 * ISS-8013 (codex, PR #6009): the SHARED fixture default carries the number
 * behind each label it states, so a row built from it participates in value
 * sorting instead of being parked.
 *
 * Every V2 story row comes from `createSessionTableRowFixture`. While the
 * default stated the four labels and none of their values, selecting Cost,
 * Duration, Started or Last active on the checked-in story data moved nothing —
 * the primary interactive story demonstrated broken sort controls.
 *
 * DESCENDING is the direction that proves it, and the only one that can: an
 * absent value parks last in BOTH directions ({@link compareNullableNumber}), so
 * the ascending list is identical whether the default carries a value or
 * nothing. Only the descending list separates "the default ranks above the
 * smaller row" from "the default has nothing and got parked behind it".
 */
const FIXTURE_DEFAULT_VALUE_CASES: readonly {
  field: SessionsListSortField;
  smaller: Partial<SessionTableRow>;
}[] = [
  { field: "cost", smaller: { costLabel: "$1.00", costValue: 1 } },
  {
    field: "duration",
    smaller: { durationLabel: "1m", durationMs: MINUTE_MS },
  },
  {
    field: "started",
    smaller: {
      startedLabel: "9h ago",
      startedAtMs: SESSION_FIXTURE_NOW_MS - 9 * HOUR_MS,
    },
  },
  {
    field: "lastActivity",
    smaller: {
      lastActivityLabel: "9h ago",
      lastActivityAtMs: SESSION_FIXTURE_NOW_MS - 9 * HOUR_MS,
    },
  },
];

describe("shared session row fixture", () => {
  for (const { field, smaller } of FIXTURE_DEFAULT_VALUE_CASES) {
    it(`carries the ${field} value behind the label its default states`, () => {
      const rowsToSort = [
        createSessionTableRowFixture({ id: "smaller", ...smaller }),
        createSessionTableRowFixture({ id: "fixture-default" }),
      ];

      expect(sortRows(rowsToSort, field, "desc").map((row) => row.id)).toEqual([
        "fixture-default",
        "smaller",
      ]);
    });
  }
});

/**
 * ISS-8013 (whitlockk, PR #6009): the Updated column's PROJECTION states the same
 * fact its cell does.
 *
 * A row whose producer served no `recordUpdatedAt` renders an em dash in
 * Updated — `renderSessionCell` reaches `renderTimestampCell(row.updatedLabel ??
 * null)` first, and that returns `GridEmptyValue` rather than falling through to
 * `SESSION_CELL_READERS`. The reader used to answer `lastActivityLabel` for that
 * same row, so grouping by Updated banded it under a time no cell in the band
 * showed — the ISS-5366 defect — while the numeric sort parked it last. Three
 * paths, two different answers.
 *
 * `lastActivityLabel` is deliberately POPULATED here: against a row with neither
 * value both the old and the new reader answer "—" and this proves nothing.
 */
const RECORD_UPDATE_SKEWED_ROW: SessionTableRow = createSessionTableRowFixture({
  id: "ses-skewed",
  lastActivityLabel: "5m ago",
  lastActivityAtMs: NOW.getTime() - 300_000,
  updatedLabel: null,
  updatedAtMs: null,
});

describe("SessionsListSurfaceV2 Updated projection", () => {
  it("bands a row with no recordUpdatedAt under the empty glyph its cell shows, not its Last active time", () => {
    const groups = buildGroups([RECORD_UPDATE_SKEWED_ROW], {
      primary: {
        fieldId: SESSIONS_UPDATED_COLUMN_ID,
        order: TableGroupOrder.Ascending,
        showEmptyGroups: false,
      },
      secondary: {
        fieldId: null,
        order: TableGroupOrder.Ascending,
        showEmptyGroups: false,
      },
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("—");
    // The anti-vacuity half: the band is not merely "not the em dash by
    // accident" — it must not be the neighbouring column's answer, which is the
    // value the removed fallback produced.
    expect(groups[0]?.label).not.toBe(
      RECORD_UPDATE_SKEWED_ROW.lastActivityLabel
    );
  });

  it("still bands a row that HAS a recordUpdatedAt under its own Updated label", () => {
    const groups = buildGroups(
      [
        createSessionTableRowFixture({
          id: "ses-updated",
          updatedLabel: "1h ago",
        }),
      ],
      {
        primary: {
          fieldId: SESSIONS_UPDATED_COLUMN_ID,
          order: TableGroupOrder.Ascending,
          showEmptyGroups: false,
        },
        secondary: {
          fieldId: null,
          order: TableGroupOrder.Ascending,
          showEmptyGroups: false,
        },
      }
    );

    expect(groups[0]?.label).toBe("1h ago");
  });
});

/**
 * AC-4's guard. The expected sets below are written OUT, by hand, and are
 * deliberately NOT derived from `SESSIONS_COLUMN_SPECS` — the declaration these
 * assertions exist to police. A guard that asks the specs which columns are
 * sortable and then checks those same columns is green the moment a new
 * `sortable: true` column is declared, which is the exact defect ISS-8013 was
 * filed for: the hazard was described in-tree at
 * `sessions-list-surface-rows.tsx` and in this suite, and five columns shipped
 * inside it anyway.
 */
const PINNED_SORTABLE_COLUMN_IDS: readonly string[] = [
  "autonomy",
  "cost",
  "duration",
  "harness",
  "lastActivity",
  "model",
  "owner",
  // ISS-10332: ordered by the wire ordinal, never by the rendered word.
  "priority",
  "repo",
  "started",
  "status",
  "updated",
];

/** The subset of the above whose order is a NUMBER, not a rendered string. */
const PINNED_VALUE_SORTED_COLUMN_IDS: readonly string[] = [
  "autonomy",
  "cost",
  "duration",
  "lastActivity",
  "priority",
  "started",
  "updated",
];

describe("SessionsListSurfaceV2 sortable-column guard", () => {
  it("states a sort rule for every column the geometry marks sortable", () => {
    expect(SESSIONS_SORTABLE_IDS_WITHOUT_SORT_RULE).toEqual([]);
  });

  /**
   * The independently-written half. A new `sortable: true` column fails HERE
   * before anyone has to notice it slipped through the structural guard by being
   * classified as text.
   */
  it("marks exactly the pinned set of columns sortable", () => {
    expect(
      SESSIONS_COLUMN_SPECS.filter(isSortableSpec)
        .map((spec) => spec.id)
        .sort()
    ).toEqual([...PINNED_SORTABLE_COLUMN_IDS].sort());
  });

  it("sorts exactly the pinned set of columns by value", () => {
    for (const id of PINNED_VALUE_SORTED_COLUMN_IDS) {
      expect(sortsByValue(id)).toBe(true);
    }
    // The negative's positive sibling: a column pinned as TEXT must NOT have
    // acquired a numeric reader, or `Status` would rank by a number nothing on
    // the row shows.
    for (const id of PINNED_SORTABLE_COLUMN_IDS.filter(
      (candidate) => !PINNED_VALUE_SORTED_COLUMN_IDS.includes(candidate)
    )) {
      expect(sortsByValue(id)).toBe(false);
    }
  });

  it("marks Autonomy sortable by its numeric value", () => {
    const autonomy = SESSIONS_COLUMN_SPECS.find(
      (spec) => spec.id === SESSIONS_AUTONOMY_COLUMN_ID
    );
    expect(autonomy).toBeDefined();
    expect(autonomy && isSortableSpec(autonomy)).toBe(true);
    expect(sortsByValue(SESSIONS_AUTONOMY_COLUMN_ID)).toBe(true);
  });
});

/**
 * Whether `sortRows` orders this column by a value rather than by its label.
 *
 * Behavioural, not a peek at the reader map: it sorts two rows whose labels rank
 * one way and whose values rank the other, and reports which one won. That keeps
 * the guard honest if the readers are ever restructured.
 */
function sortsByValue(columnId: string): boolean {
  const low = createSessionTableRowFixture({
    autonomy: 9,
    id: "low",
    costLabel: "$9.50",
    costValue: 9.5,
    durationLabel: "9m",
    durationMs: 540_000,
    startedLabel: "5 days ago",
    startedAtMs: 1,
    updatedLabel: "5 days ago",
    updatedAtMs: 1,
    lastActivityLabel: "5 days ago",
    lastActivityAtMs: 1,
    // The text-sorted columns rank the OTHER way here too, so a column pinned as
    // text answers `false` because its label genuinely won — not because both
    // rows happened to tie.
    harness: "zeta",
    model: "zeta",
    repo: "zeta",
    status: SESSION_STATUS.INACTIVE,
    user: { id: "u-low", name: "Zoe" },
    // ISS-10332: MEDIUM ranks below HIGH on the wire ordinal while "Medium"
    // sorts AFTER "High" as text, so a label sort would answer the other way.
    priority: Priority.Medium,
  });
  const high = createSessionTableRowFixture({
    autonomy: 100,
    id: "high",
    costLabel: "$1,234.00",
    costValue: 1234,
    durationLabel: "2h 40m",
    durationMs: 9_600_000,
    startedLabel: "10 min ago",
    startedAtMs: 2,
    updatedLabel: "10 min ago",
    updatedAtMs: 2,
    lastActivityLabel: "10 min ago",
    lastActivityAtMs: 2,
    harness: "alpha",
    model: "alpha",
    repo: "alpha",
    status: SESSION_STATUS.ACTIVE,
    user: { id: "u-high", name: "Ada" },
    priority: Priority.High,
  });

  return (
    sortRows([high, low], columnId as SessionsListSortField, "asc")[0]?.id ===
    "low"
  );
}
