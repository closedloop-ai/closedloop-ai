import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import {
  ArtifactTagAvailability,
  TagColor,
  type TagSummary,
} from "@repo/api/src/types/tag";
import { SESSION_COST_CELL_TEST_ID } from "@repo/app/agents/components/sessions/session-cost-cell";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SESSIONS_HISTORY_LIST_TEST_ID } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import {
  SESSIONS_COST_COLUMN_ID,
  SESSIONS_STATUS_COLUMN_ID,
  SESSIONS_TAGS_COLUMN_ID,
} from "@repo/app/agents/lib/sessions-table-columns";
import {
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
  SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import type { BothHostRenderContract } from "@repo/app/shared/testing/both-host-render-contract";
import { foundOrAbsent } from "@repo/app/shared/testing/both-host-render-contract";
import { GRID_EMPTY_VALUE_GLYPH } from "@repo/design-system/components/ui/grid-table-card";
import { isGridChromeRowId } from "@repo/design-system/lib/grid-table-v2-chrome-rows";
import { screen, waitFor } from "@testing-library/react";

/**
 * ISS-9532 — the STATE MATRIX `SessionsListSurfaceV2` owes its reader on BOTH
 * shells: the same `AgentSessionListItem` fixtures, mounted through each host's
 * own adapter, must put the same row ids in the same order, the same status
 * words, the same range readout, and the same offered actions on screen.
 *
 * Sibling of `sessions-both-host-contract.ts` (ISS-9544), which pins the
 * everyday population; this file pins the states that population does not
 * reach. The web and Desktop halves are
 * `apps/app/components/agent-sessions/__tests__/sessions-state-matrix.test.tsx`
 * and
 * `apps/desktop/src/renderer/components/sessions/__tests__/sessions-state-matrix.test.tsx`.
 *
 * Every case carries its own expectation in `fixture.expected`, and ONE check
 * (`renderedStateProblem`) reads whichever expectations a case states. Absence
 * is never asserted alone: each case that expects a thing to be missing also
 * expects its sibling to be present in the same render, so a list that failed
 * to mount cannot satisfy it.
 *
 * Offline is not a case here: it is a Desktop-only capability (the web host has
 * no connectivity-driven source swap), so it is stated in each host's own suite.
 */

/**
 * No exported constant names the Duration column; its id is the literal in
 * `SESSIONS_COLUMN_SPECS`.
 */
export const DURATION_COLUMN_ID = "duration";

/**
 * Recent enough to stay inside the Desktop shell's shared date window (a fixed
 * June instant ages out and empties the table), and old enough to be "stale"
 * next to a clock that keeps ticking.
 */
const STALE_START_MS = Date.now() - 3 * 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** What a case expects on screen; every field is optional and read when set. */
export type StateMatrixExpectation = {
  /** Cost cell text per row id (the shared unknown glyph when unpriced). */
  readonly costByRow?: Readonly<Record<string, string>>;
  /** Duration cell text per row id. */
  readonly durationByRow?: Readonly<Record<string, string>>;
  /** Rows whose tags editor is offered (named after the session). */
  readonly editableTagRows?: readonly string[];
  /** The visible range sentence, e.g. "Showing 26-27 of 27 sessions". */
  readonly readout?: string;
  /** Row ids in rendered order. */
  readonly rowIds?: readonly string[];
  /** Status word per row id. */
  readonly statusByRow?: Readonly<Record<string, string>>;
  /** Rows that show their tags but offer no editor. */
  readonly readOnlyTagRows?: readonly string[];
  /** Rows whose tags cell is the shared unknown glyph. */
  readonly unknownTagRows?: readonly string[];
  /** Whether the Tags column (wide) or tags renderer (narrow) is on screen. */
  readonly tagsVisible?: boolean;
  /** The narrow one-column list: no per-column cells in the rows. */
  readonly narrowList?: boolean;
};

export type StateMatrixFixture = {
  /** Flag keys the host must report enabled; every other flag is off. */
  readonly enabledFlags: readonly string[];
  readonly expected: StateMatrixExpectation;
  readonly items: readonly AgentSessionListItem[];
  readonly narrow?: boolean;
  /** Zero-based page index. */
  readonly pageIndex?: number;
  readonly pageSize?: number;
  readonly total?: number;
  /** The column ids the view has switched on. */
  readonly visibleColumns: readonly string[];
};

export const TAGS_FLAG_ON = [SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY];
/**
 * The stubbed narrow viewport reaches the card layout only with this key on
 * (the three narrow cases fail without it under jsdom).
 */
const NARROW_FLAGS = [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY];
const WIDE_COLUMNS = [SESSIONS_STATUS_COLUMN_ID, SESSIONS_COST_COLUMN_ID];

const TAG: TagSummary = {
  color: TagColor.Blue,
  id: "tag-1",
  name: "matrix-tag",
};

function session(
  id: string,
  overrides: Record<string, unknown> = {}
): AgentSessionListItem {
  const at = new Date(Date.now() - 60 * MINUTE_MS);
  return createAgentSessionListItemFixture({
    endedAt: at,
    id,
    lastActivityAt: at,
    name: `agent/${id}`,
    startedAt: new Date(at.getTime() - 30 * MINUTE_MS),
    status: SESSION_STATUS.INACTIVE,
    updatedAt: at,
    ...overrides,
  });
}

function taggedSession(
  id: string,
  permissions: { canApply: boolean; canRemove: boolean } | undefined
): AgentSessionListItem {
  return session(id, {
    tagAvailability: ArtifactTagAvailability.Available,
    tagPermissions: permissions,
    tags: [TAG],
  });
}

function rowName(item: AgentSessionListItem): string {
  return item.name ?? "";
}

const STATUS_ITEMS = [
  // A producer spelling this build does not model, a retired spelling, and the
  // legacy awaiting-input word all fold to Active (ISS-10364); the two
  // recognised terminal states keep their own words.
  session("ses-status-bogus", { status: "not-a-session-status" }),
  session("ses-status-retired", { status: "completed" }),
  session("ses-status-waiting", { status: "waiting" }),
  session("ses-status-inactive", { status: SESSION_STATUS.INACTIVE }),
  session("ses-status-error", { status: SESSION_STATUS.ERROR }),
];

const ENRICHED = taggedSession("ses-enriched", {
  canApply: true,
  canRemove: true,
});
const UNENRICHED = session("ses-unenriched", {
  cacheReadTokens: null,
  cacheWriteTokens: null,
  estimatedCost: null,
  inputTokens: null,
  outputTokens: null,
  tagAvailability: undefined,
  tagPermissions: undefined,
  tags: undefined,
});

const STALE_INACTIVE = session("ses-stale-inactive", {
  endedAt: new Date(STALE_START_MS + 90 * MINUTE_MS),
  lastActivityAt: new Date(STALE_START_MS + 90 * MINUTE_MS),
  startedAt: new Date(STALE_START_MS),
  status: SESSION_STATUS.INACTIVE,
  updatedAt: new Date(STALE_START_MS + 90 * MINUTE_MS),
});
const STALE_ERROR = session("ses-stale-error", {
  endedAt: new Date(STALE_START_MS + 45 * MINUTE_MS),
  lastActivityAt: new Date(STALE_START_MS + 45 * MINUTE_MS),
  startedAt: new Date(STALE_START_MS),
  status: SESSION_STATUS.ERROR,
  updatedAt: new Date(STALE_START_MS + 45 * MINUTE_MS),
});

const GRANTED = taggedSession("ses-perm-granted", {
  canApply: true,
  canRemove: true,
});
const DENIED = taggedSession("ses-perm-denied", {
  canApply: false,
  canRemove: false,
});
const NOT_REPORTED = taggedSession("ses-perm-unreported", undefined);

const PAGE_TWO_ITEMS = [session("ses-page-26"), session("ses-page-27")];

const FLAG_ITEMS = [
  taggedSession("ses-flag-one", { canApply: true, canRemove: true }),
  taggedSession("ses-flag-two", { canApply: true, canRemove: true }),
];

function ids(items: readonly AgentSessionListItem[]): string[] {
  return items.map((item) => item.id);
}

function sentence(from: number, to: number, total: number): string {
  return `Showing ${from}-${to} of ${total} sessions`;
}

export const SESSIONS_STATE_MATRIX_CASES: readonly {
  readonly fixture: StateMatrixFixture;
  readonly name: string;
}[] = [
  {
    name: "unknown and legacy status spellings fold to the Active word, in the fixture's order",
    fixture: {
      enabledFlags: [],
      expected: {
        readout: sentence(1, 5, 5),
        rowIds: ids(STATUS_ITEMS),
        statusByRow: {
          "ses-status-bogus": SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE],
          "ses-status-error": SESSION_STATUS_LABELS[SESSION_STATUS.ERROR],
          "ses-status-inactive": SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE],
          "ses-status-retired": SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE],
          "ses-status-waiting": SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE],
        },
      },
      items: STATUS_ITEMS,
      visibleColumns: WIDE_COLUMNS,
    },
  },
  {
    name: "unloaded cost and tags render the shared unknown glyph, never a zero",
    fixture: {
      enabledFlags: TAGS_FLAG_ON,
      expected: {
        costByRow: {
          "ses-enriched": "$4.25",
          "ses-unenriched": GRID_EMPTY_VALUE_GLYPH,
        },
        readout: sentence(1, 2, 2),
        rowIds: ["ses-enriched", "ses-unenriched"],
        unknownTagRows: ["ses-unenriched"],
        editableTagRows: ["ses-enriched"],
      },
      items: [ENRICHED, UNENRICHED],
      visibleColumns: [...WIDE_COLUMNS, SESSIONS_TAGS_COLUMN_ID],
    },
  },
  {
    name: "finished sessions with old activity keep a duration bounded by their own end",
    fixture: {
      enabledFlags: [],
      expected: {
        durationByRow: {
          "ses-stale-error": "45m 0s",
          "ses-stale-inactive": "1h 30m",
        },
        rowIds: ["ses-stale-inactive", "ses-stale-error"],
        statusByRow: {
          "ses-stale-error": SESSION_STATUS_LABELS[SESSION_STATUS.ERROR],
          "ses-stale-inactive": SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE],
        },
      },
      items: [STALE_INACTIVE, STALE_ERROR],
      visibleColumns: [...WIDE_COLUMNS, DURATION_COLUMN_ID],
    },
  },
  {
    name: "offers the tags editor only on rows whose permissions grant it",
    fixture: {
      enabledFlags: TAGS_FLAG_ON,
      expected: {
        editableTagRows: ["ses-perm-granted"],
        readOnlyTagRows: ["ses-perm-denied", "ses-perm-unreported"],
        rowIds: ["ses-perm-granted", "ses-perm-denied", "ses-perm-unreported"],
        tagsVisible: true,
      },
      items: [GRANTED, DENIED, NOT_REPORTED],
      visibleColumns: [SESSIONS_STATUS_COLUMN_ID, SESSIONS_TAGS_COLUMN_ID],
    },
  },
  {
    name: "narrow viewport renders the one-column list with the same rows",
    fixture: {
      enabledFlags: NARROW_FLAGS,
      expected: {
        narrowList: true,
        readout: sentence(1, 5, 5),
        rowIds: ids(STATUS_ITEMS),
      },
      items: STATUS_ITEMS,
      narrow: true,
      visibleColumns: WIDE_COLUMNS,
    },
  },
  {
    name: "page two of a server-driven total states its own range and rows",
    fixture: {
      enabledFlags: [],
      expected: {
        readout: sentence(26, 27, 27),
        rowIds: ids(PAGE_TWO_ITEMS),
      },
      items: PAGE_TWO_ITEMS,
      pageIndex: 1,
      pageSize: 25,
      total: 27,
      visibleColumns: WIDE_COLUMNS,
    },
  },
  {
    name: "shows the Tags column when the sessions-artifact-tags flag is on",
    fixture: {
      enabledFlags: TAGS_FLAG_ON,
      expected: {
        editableTagRows: ids(FLAG_ITEMS),
        rowIds: ids(FLAG_ITEMS),
        tagsVisible: true,
      },
      items: FLAG_ITEMS,
      visibleColumns: [SESSIONS_STATUS_COLUMN_ID, SESSIONS_TAGS_COLUMN_ID],
    },
  },
  {
    name: "hides the Tags column when the sessions-artifact-tags flag is off",
    fixture: {
      enabledFlags: [],
      expected: {
        rowIds: ids(FLAG_ITEMS),
        statusByRow: {
          "ses-flag-one": SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE],
          "ses-flag-two": SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE],
        },
        tagsVisible: false,
      },
      items: FLAG_ITEMS,
      visibleColumns: [SESSIONS_STATUS_COLUMN_ID, SESSIONS_TAGS_COLUMN_ID],
    },
  },
  {
    // ISS-12959 (#9134): narrow rows carry no Tags, per the operator's
    // 2026-10-19 Asana direction, so the flag being on changes nothing here.
    name: "narrow rows show no tags even when the sessions-artifact-tags flag is on",
    fixture: {
      enabledFlags: [...NARROW_FLAGS, ...TAGS_FLAG_ON],
      expected: {
        narrowList: true,
        rowIds: ids(FLAG_ITEMS),
        tagsVisible: false,
      },
      items: FLAG_ITEMS,
      narrow: true,
      visibleColumns: [SESSIONS_STATUS_COLUMN_ID, SESSIONS_TAGS_COLUMN_ID],
    },
  },
  {
    name: "narrow rows hide tags when the sessions-artifact-tags flag is off",
    fixture: {
      enabledFlags: NARROW_FLAGS,
      expected: {
        narrowList: true,
        rowIds: ids(FLAG_ITEMS),
        tagsVisible: false,
      },
      items: FLAG_ITEMS,
      narrow: true,
      visibleColumns: [SESSIONS_STATUS_COLUMN_ID, SESSIONS_TAGS_COLUMN_ID],
    },
  },
];

const TAG_NAME = TAG.name;
const GRID_ROW_SELECTOR = "[data-grid-row-id]";

/** Data rows only: the column-header row carries a row id of its own. */
function renderedRowIds(list: HTMLElement): string[] {
  return [...list.querySelectorAll(GRID_ROW_SELECTOR)]
    .map((row) => row.getAttribute("data-grid-row-id") ?? "")
    .filter((id) => !isGridChromeRowId(id));
}

function rowFor(list: HTMLElement, id: string): Element | null {
  return list.querySelector(`[data-grid-row-id="${id}"]`);
}

function cellFor(row: Element, columnId: string): Element | null {
  return row.querySelector(`[data-column-id="${columnId}"]`);
}

/**
 * The accessible name `SessionTagsCell` gives the editor trigger of a row.
 * Spelled here rather than imported because the production string is an inline
 * template; presence on a granted row in the same render keeps every absence
 * assertion on this locator from passing vacuously.
 */
export function editTagsName(item: AgentSessionListItem): string {
  return `Edit tags for ${rowName(item)}`;
}

/** The accessible name the row star carries, as in `sessions-both-host-contract`. */
export function favoriteControlName(item: AgentSessionListItem): string {
  return `Add ${rowName(item)} to favorites`;
}

/** One tagged row whose permissions grant every write, for write-gating suites. */
export const WRITABLE_TAGGED_FIXTURE: StateMatrixFixture = {
  enabledFlags: TAGS_FLAG_ON,
  expected: {},
  items: [GRANTED],
  visibleColumns: [SESSIONS_STATUS_COLUMN_ID, SESSIONS_TAGS_COLUMN_ID],
};

function itemFor(
  fixture: StateMatrixFixture,
  id: string
): AgentSessionListItem | undefined {
  return fixture.items.find((item) => item.id === id);
}

function statusProblem(
  list: HTMLElement,
  expected: Readonly<Record<string, string>>
): string | undefined {
  for (const [id, label] of Object.entries(expected)) {
    const row = rowFor(list, id);
    const cell = row ? cellFor(row, SESSIONS_STATUS_COLUMN_ID) : null;
    if (cell?.textContent !== label) {
      return `row ${id} states status "${cell?.textContent ?? "(no cell)"}", expected "${label}"`;
    }
  }
  return undefined;
}

function costProblem(
  list: HTMLElement,
  expected: Readonly<Record<string, string>>
): string | undefined {
  for (const [id, text] of Object.entries(expected)) {
    const row = rowFor(list, id);
    const cell = row?.querySelector(
      `[data-testid="${SESSION_COST_CELL_TEST_ID}"]`
    );
    if (cell?.textContent !== text) {
      return `row ${id} states cost "${cell?.textContent ?? "(no cell)"}", expected "${text}"`;
    }
  }
  return undefined;
}

function durationProblem(
  list: HTMLElement,
  expected: Readonly<Record<string, string>>
): string | undefined {
  for (const [id, text] of Object.entries(expected)) {
    const row = rowFor(list, id);
    const cell = row ? cellFor(row, DURATION_COLUMN_ID) : null;
    if (cell?.textContent !== text) {
      return `row ${id} states duration "${cell?.textContent ?? "(no cell)"}", expected "${text}"`;
    }
  }
  return undefined;
}

function unknownTagsProblem(
  list: HTMLElement,
  rowIdsExpected: readonly string[]
): string | undefined {
  for (const id of rowIdsExpected) {
    const row = rowFor(list, id);
    const cell = row ? cellFor(row, SESSIONS_TAGS_COLUMN_ID) : null;
    if (cell?.textContent !== GRID_EMPTY_VALUE_GLYPH) {
      return `row ${id} states tags "${cell?.textContent ?? "(no cell)"}", expected the shared unknown glyph`;
    }
  }
  return undefined;
}

function tagsColumnProblem(
  list: HTMLElement,
  fixture: StateMatrixFixture,
  visible: boolean
): string | undefined {
  const narrow = fixture.narrow === true;
  // Narrow rows have no column cells, so the column is judged by whether the
  // tag chip is rendered at all.
  const columnPresent =
    list.querySelector(`[data-column-id="${SESSIONS_TAGS_COLUMN_ID}"]`) !==
    null;
  const chipPresent = list.textContent?.includes(TAG_NAME) === true;
  if (!narrow && columnPresent !== visible) {
    return visible
      ? "the Tags column is absent"
      : "the Tags column is on screen with the flag off";
  }
  if (chipPresent !== visible) {
    return visible
      ? "no row shows its tags"
      : "a row shows tags with the flag off";
  }
  return undefined;
}

function tagEditorProblem(
  list: HTMLElement,
  fixture: StateMatrixFixture,
  expected: StateMatrixExpectation
): string | undefined {
  for (const id of expected.editableTagRows ?? []) {
    const item = itemFor(fixture, id);
    if (!item) {
      return `fixture has no row ${id}`;
    }
    if (!screen.queryByRole("button", { name: editTagsName(item) })) {
      return `no tags editor is offered on ${id}`;
    }
  }
  for (const id of expected.readOnlyTagRows ?? []) {
    const item = itemFor(fixture, id);
    if (!item) {
      return `fixture has no row ${id}`;
    }
    if (screen.queryByRole("button", { name: editTagsName(item) })) {
      return `a tags editor is offered on ${id}, whose permissions do not grant it`;
    }
    // Read-only, not missing: the row still shows the tag it carries.
    const row = list.querySelector(`[data-grid-row-id="${id}"]`);
    if (row?.textContent?.includes(TAG_NAME) !== true) {
      return `${id} shows no tags, so its missing editor says nothing about permissions`;
    }
  }
  // A flag-off case lists no editable rows, so absence is read for every item.
  if (expected.tagsVisible === false) {
    for (const item of fixture.items) {
      if (screen.queryByRole("button", { name: editTagsName(item) })) {
        return `a tags editor is offered on ${item.id} with the flag off`;
      }
    }
  }
  return undefined;
}

function structureProblem(
  list: HTMLElement,
  fixture: StateMatrixFixture
): string | undefined {
  const { expected } = fixture;
  const rowIdsRendered = renderedRowIds(list);
  if (
    expected.rowIds &&
    rowIdsRendered.join("|") !== expected.rowIds.join("|")
  ) {
    return `rows rendered [${rowIdsRendered.join(", ")}], expected [${expected.rowIds.join(", ")}]`;
  }
  if (expected.narrowList !== undefined) {
    // Body rows only: the column-header row keeps its own column ids.
    const hasColumnCells = [...list.querySelectorAll(GRID_ROW_SELECTOR)]
      .filter(
        (row) => !isGridChromeRowId(row.getAttribute("data-grid-row-id") ?? "")
      )
      .some((row) => row.querySelector("[data-column-id]") !== null);
    if (hasColumnCells === expected.narrowList) {
      return expected.narrowList
        ? "the list kept per-column cells at a narrow width"
        : "the list is not the column grid";
    }
  }
  return undefined;
}

/**
 * What is wrong with the mounted state, from the expectation `fixture.expected`
 * states, or nothing. Shared by every case so the two shells are read by the
 * same eyes.
 */
export async function renderedStateProblem(
  fixture: StateMatrixFixture
): Promise<string | undefined> {
  const { expected } = fixture;
  const list = await foundOrAbsent(() =>
    screen.findByTestId(SESSIONS_HISTORY_LIST_TEST_ID)
  );
  if (!list) {
    return "the shared SessionsListSurfaceV2 list region is absent";
  }
  const wanted = expected.rowIds?.length ?? 0;
  await waitFor(() => {
    if (renderedRowIds(list).length !== wanted) {
      throw new Error("rows still settling");
    }
  }).catch(() => undefined);

  const structure = structureProblem(list, fixture);
  if (structure) {
    return structure;
  }
  if (expected.readout) {
    const readout = await foundOrAbsent(() =>
      screen.findByText(expected.readout ?? "")
    );
    if (!readout) {
      return `the list does not state "${expected.readout}"`;
    }
  }
  const cellProblem =
    (expected.durationByRow && durationProblem(list, expected.durationByRow)) ||
    (expected.statusByRow && statusProblem(list, expected.statusByRow)) ||
    (expected.costByRow && costProblem(list, expected.costByRow)) ||
    (expected.unknownTagRows &&
      unknownTagsProblem(list, expected.unknownTagRows));
  if (cellProblem) {
    return cellProblem;
  }
  if (expected.tagsVisible !== undefined) {
    const column = tagsColumnProblem(list, fixture, expected.tagsVisible);
    if (column) {
      return column;
    }
  }
  return tagEditorProblem(list, fixture, expected);
}

export const SESSIONS_STATE_MATRIX_CONTRACT: BothHostRenderContract<StateMatrixFixture> =
  {
    surface: "Sessions list surface v2 state matrix",
    cases: SESSIONS_STATE_MATRIX_CASES.map(({ fixture, name }) => ({
      fixture,
      name,
      renderProblem: renderedStateProblem,
    })),
  };
