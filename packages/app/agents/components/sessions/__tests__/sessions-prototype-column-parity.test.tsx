import { GRID_TABLE_V2_FLAG_KEY } from "@repo/api/src/types/grid-table-v2-flag";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSIONS_TOGGLEABLE_COLUMNS,
  sessionsToggleableColumns,
} from "../../../hooks/use-sessions-view-state";
import {
  normalizeSessionColumnId,
  resolveRenderedSessionColumnIds,
  SESSIONS_AUTONOMY_COLUMN_ID,
  SESSIONS_BRANCHES_COLUMN_ID,
  SESSIONS_COLUMN_SPECS,
  SESSIONS_DATA_COLUMN_ORDER,
  SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS,
  SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS,
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_LEGACY_BRANCHES_COLUMN_ID,
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_SEAM_REQUIRED_COLUMN_IDS,
  selectOfferableSessionColumns,
} from "../../../lib/sessions-table-columns";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsTable, type SessionTableRow } from "../sessions-table";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-5770 / ISS-5713: the Sessions table's default column set, its order, and
 * its View menu are the Sessions PROTOTYPE's, and every consumer derives them
 * from one declaration instead of restating them.
 *
 * The oracle below is transcribed from the prototype's own `COLUMN_SPECS`
 * (`apps/prototypes/app/p/sessions/components/sessions-table.tsx`) as DATA, so a
 * reordering of the production declaration fails these assertions rather than
 * drifting silently — which is what happened to the View menu, whose doc comment
 * promised it "mirrors SESSIONS_COLUMN_SPECS order" while carrying a different
 * tail order and a different id for the branches column.
 */

/**
 * The prototype's 17 columns, in order, with the operator-confirmed defaults.
 *
 * Deliberately a literal rather than an import: `apps/prototypes` is a
 * presentational sandbox that production must not depend on, and this list is
 * the CONTRACT being pinned. If the prototype changes, this literal is the line
 * that has to be updated on purpose.
 */
const PROTOTYPE_COLUMNS: readonly { id: string; defaultOn: boolean }[] = [
  { id: "status", defaultOn: true },
  { id: "tags", defaultOn: false },
  { id: "owner", defaultOn: true },
  { id: "collaborators", defaultOn: false },
  { id: "autonomy", defaultOn: true },
  { id: "projects", defaultOn: false },
  { id: "repo", defaultOn: true },
  { id: "branches", defaultOn: true },
  { id: "issues", defaultOn: false },
  { id: "agents", defaultOn: false },
  { id: "harness", defaultOn: true },
  { id: "model", defaultOn: true },
  { id: "duration", defaultOn: true },
  { id: "cost", defaultOn: true },
  { id: "started", defaultOn: false },
  { id: "updated", defaultOn: false },
  { id: "lastActivity", defaultOn: true },
];

/**
 * Prototype columns production does not implement yet, each owned by its own
 * ticket. They are absent rather than half-built: every one needs backing data,
 * not just a column spec, and each is default-OFF in the prototype — which is
 * why the DEFAULT-VISIBLE set is already reachable without them.
 */
const UNIMPLEMENTED_PROTOTYPE_COLUMN_IDS: readonly string[] = [
  "tags", // FEA-4213
  "collaborators", // FEA-4208
  "agents", // FEA-4212 (blocked on ISS-5664)
  // `updated` was here as "no ticket found; reported for triage". ISS-6005 IS
  // that ticket: the column now ships (default-OFF, reading the record-mutation
  // clock `recordUpdatedAt` rather than the `session_updated_at` lookalike), in
  // exactly the slot this literal already predicted — between `started` and
  // `lastActivity`. Its removal from this list is what makes the order
  // assertion below prove the new column landed in the prototype's slot.
];

/** Production columns with no prototype slot. Kept, but default-OFF. */
const EXTRA_PRODUCTION_COLUMN_IDS: readonly string[] = ["pr", "merge"];

const ROW: SessionTableRow = createSessionTableRowFixture({
  autonomy: 88,
  branch: "feature/auth-guard",
  model: "opus-4.8",
  repo: "acme/app",
  status: "Working",
  user: { avatarUrl: null, name: "Parker Byrd" },
});

function renderName(row: SessionTableRow, className: string) {
  return (
    <a className={className} href={`/sessions/${row.id}`}>
      {row.name}
    </a>
  );
}

/** The rendered header ids, left to right, off one real screen. */
function renderedHeaderIds(): string[] {
  return screen
    .getAllByRole("columnheader")
    .map((cell) => cell.getAttribute("data-column-id"))
    .filter((id): id is string => Boolean(id));
}

describe("Sessions column parity with the prototype (ISS-5770)", () => {
  it("declares the prototype's order for every column both sides have", () => {
    const prototypeOrder = PROTOTYPE_COLUMNS.map((column) => column.id).filter(
      (id) => !UNIMPLEMENTED_PROTOTYPE_COLUMN_IDS.includes(id)
    );
    const declaredOrder = SESSIONS_DATA_COLUMN_ORDER.filter(
      (id) => !EXTRA_PRODUCTION_COLUMN_IDS.includes(id)
    );
    expect(declaredOrder).toEqual(prototypeOrder);
  });

  it("defaults exactly the prototype's ten ON columns, in order", () => {
    const expected = PROTOTYPE_COLUMNS.filter(
      (column) =>
        column.defaultOn &&
        !UNIMPLEMENTED_PROTOTYPE_COLUMN_IDS.includes(column.id)
    ).map((column) => column.id);
    expect(expected).toHaveLength(10);
    expect(SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS).toEqual(expected);
  });

  it("renders that same default set, in that order, on a real screen", () => {
    // `visibleColumns` is what a brand-new saved view hands the table — default
    // VISIBILITY is the view state's job, not the table's, so a bare mount
    // deliberately renders every ungated column. Driving the real seam is what
    // makes this an assertion about the shipped screen rather than the array.
    render(
      <SessionsTable
        items={[ROW]}
        mode="expanded"
        renderName={renderName}
        visibleColumns={new Set(SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS)}
      />
    );
    // The lead "Session" track is not a data column; every data column follows.
    expect(renderedHeaderIds()).toEqual([
      ...SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS,
    ]);
  });

  it("renders every ungated column when no saved view narrows it", () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    // The gated pair stays out — its gate is a property of the BUILD, so no
    // `visibleColumns` set can conjure it — while the default-hidden columns do
    // appear, because nothing has hidden them yet.
    expect(renderedHeaderIds()).toEqual(
      SESSIONS_DATA_COLUMN_ORDER.filter(
        (id) =>
          id !== SESSIONS_PROJECTS_COLUMN_ID && id !== SESSIONS_ISSUES_COLUMN_ID
      )
    );
  });

  it("keeps pr and merge available but default-hidden", () => {
    for (const id of EXTRA_PRODUCTION_COLUMN_IDS) {
      expect(SESSIONS_DATA_COLUMN_ORDER).toContain(id);
      expect(SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS).toContain(id);
      expect(SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS).not.toContain(id);
    }
  });
});

describe("the Signals column is gone (ISS-5770)", () => {
  it("declares no qualifiers column in any flag state", () => {
    for (const enabledGates of [
      {},
      { [GRID_TABLE_V2_FLAG_KEY]: true },
      { [GRID_TABLE_V2_FLAG_KEY]: false },
    ]) {
      const rendered = resolveRenderedSessionColumnIds({ enabledGates });
      expect(rendered).not.toContain("qualifiers");
    }
    expect(SESSIONS_DATA_COLUMN_ORDER).not.toContain("qualifiers");
  });

  it("renders no Signals header and no Signals menu entry", () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    expect(screen.queryByText("Signals")).not.toBeInTheDocument();
    expect(
      SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.label)
    ).not.toContain("Signals");
  });
});

describe("a re-shown default-hidden column lands in its declared slot (ISS-5770)", () => {
  /**
   * The web e2e `sessions-list-surface` "the View menu can show a default-hidden
   * column" used to expect `Started` APPENDED after the default headers. ISS-5770
   * moved `started` to sit immediately BEFORE `Last active` (the prototype's
   * adjacency), so that literal asserted an order the declaration never made and
   * the spec went red on a correct build.
   *
   * Pinned here, on the shared component BOTH surfaces render, so the e2e's
   * derived expectation has a component-level statement of the same contract
   * standing behind it rather than being self-referential.
   */
  it("renders Started immediately before Last active, not at the end", () => {
    const shown = [...SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS, "started"];
    render(
      <SessionsTable
        items={[ROW]}
        mode="expanded"
        renderName={renderName}
        visibleColumns={new Set(shown)}
      />
    );
    const headers = [...screen.getAllByRole("columnheader")].map(
      (cell) => cell.textContent?.trim() ?? ""
    );
    const started = headers.findIndex((label) => label.includes("Started"));
    const lastActive = headers.findIndex((label) =>
      label.includes("Last active")
    );
    expect(started).toBeGreaterThan(-1);
    expect(lastActive).toBeGreaterThan(-1);
    expect(started).toBe(lastActive - 1);
    // And it is NOT the trailing data column, which is what the old literal
    // assumed.
    expect(started).toBeLessThan(headers.length - 1);
  });
});

describe("the View menu derives from the column declaration (ISS-5713)", () => {
  it("offers the declared columns, in declared order, minus Autonomy", () => {
    const expected = SESSIONS_DATA_COLUMN_ORDER.filter(
      (id) => id !== SESSIONS_AUTONOMY_COLUMN_ID
    );
    expect(SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id)).toEqual(
      expected
    );
  });

  it("labels each entry with the declared label, so the menu cannot rename a column", () => {
    const labelById = new Map(
      SESSIONS_COLUMN_SPECS.map((spec) => [spec.id, String(spec.label)])
    );
    for (const column of SESSIONS_TOGGLEABLE_COLUMNS) {
      expect(column.label).toBe(labelById.get(column.id));
    }
  });

  it("hides the gated linked-entity entries until the surface opts in", () => {
    const offIds = sessionsToggleableColumns().map((column) => column.id);
    expect(offIds).not.toContain(SESSIONS_PROJECTS_COLUMN_ID);
    expect(offIds).not.toContain(SESSIONS_ISSUES_COLUMN_ID);
    const onIds = sessionsToggleableColumns({
      enabledGates: { [GRID_TABLE_V2_FLAG_KEY]: true },
      hostSuppliedColumnIds: [...SESSIONS_SEAM_REQUIRED_COLUMN_IDS],
    }).map((column) => column.id);
    expect(onIds).toContain(SESSIONS_PROJECTS_COLUMN_ID);
    expect(onIds).toContain(SESSIONS_ISSUES_COLUMN_ID);
  });

  it("needs BOTH halves: the flag alone does not offer a seam-required entry", () => {
    // The menu now takes the same two inputs the table's resolver takes, so a
    // surface that has the flag but not the data does not grow a switch for a
    // column it cannot render — previously these were ANDed into one boolean at
    // the call site and the helper could not tell them apart.
    const flagOnlyIds = sessionsToggleableColumns({
      enabledGates: { [GRID_TABLE_V2_FLAG_KEY]: true },
    }).map((column) => column.id);
    expect(flagOnlyIds).not.toContain(SESSIONS_PROJECTS_COLUMN_ID);
    expect(flagOnlyIds).not.toContain(SESSIONS_ISSUES_COLUMN_ID);

    const seamOnlyIds = sessionsToggleableColumns({
      enabledGates: {},
      hostSuppliedColumnIds: [...SESSIONS_SEAM_REQUIRED_COLUMN_IDS],
    }).map((column) => column.id);
    expect(seamOnlyIds).not.toContain(SESSIONS_PROJECTS_COLUMN_ID);
    expect(seamOnlyIds).not.toContain(SESSIONS_ISSUES_COLUMN_ID);
  });
});

/**
 * ISS-5770 review (codex `use-sessions-view-state.ts:65`, wongk `:63`).
 *
 * The complaint is about the NEXT gated column, not the two that exist: the menu
 * subtracted a hardcoded `projects`/`issues` pair instead of reading `spec.gate`,
 * so a column added behind any other gate would compile, stay absent from the
 * table (whose resolver does read `spec.gate`), and still show a switch in the
 * View menu — a control that toggles nothing the user can see.
 *
 * A test over today's two gated columns cannot catch that, because a hardcoded
 * list containing exactly those two passes it. So this block ADDS a hypothetical
 * column behind a gate key this build does not declare, by mocking the
 * declaration module the menu derives from, and asserts the menu tracks it in
 * both gate states. Re-introducing any hand-maintained exclusion list fails here
 * immediately: such a list cannot know about a gate that did not exist when it
 * was typed.
 */
describe("a column behind a FUTURE gate (ISS-5770 review)", () => {
  const HYPOTHETICAL_GATE = "sessions-hypothetical-gate";
  const HYPOTHETICAL_COLUMN_ID = "hypotheticalGated";

  /**
   * Computed key so the object's inferred type is a string index signature
   * rather than a fresh literal checked against today's single-member
   * `SessionsColumnGate` — which is exactly the point: this models a gate key a
   * LATER build declares.
   */
  function gatesWith(key: string, enabled: boolean) {
    return { [key]: enabled };
  }

  async function loadMenuWithHypotheticalColumn() {
    vi.resetModules();
    vi.doMock("../../../lib/sessions-table-columns", async () => {
      const actual = await vi.importActual<
        typeof import("../../../lib/sessions-table-columns")
      >("../../../lib/sessions-table-columns");
      return {
        ...actual,
        SESSIONS_COLUMN_SPECS: [
          ...actual.SESSIONS_COLUMN_SPECS,
          {
            id: HYPOTHETICAL_COLUMN_ID,
            label: "Hypothetical",
            width: "120px",
            gate: HYPOTHETICAL_GATE,
          },
        ],
      };
    });
    return await import("../../../hooks/use-sessions-view-state");
  }

  afterEach(() => {
    vi.doUnmock("../../../lib/sessions-table-columns");
    vi.resetModules();
  });

  it("offers NO switch for it while its gate is off", async () => {
    const { sessionsToggleableColumns: derived } =
      await loadMenuWithHypotheticalColumn();
    const ids: string[] = derived({
      enabledGates: gatesWith(HYPOTHETICAL_GATE, false),
    }).map((column) => column.id);
    expect(ids).not.toContain(HYPOTHETICAL_COLUMN_ID);
    // And not merely because the mock failed to land — the ungated columns it
    // was appended to are still offered.
    expect(ids).toContain(SESSIONS_BRANCHES_COLUMN_ID);
  });

  it("offers it as soon as its gate is on", async () => {
    const { sessionsToggleableColumns: derived } =
      await loadMenuWithHypotheticalColumn();
    const ids: string[] = derived({
      enabledGates: gatesWith(HYPOTHETICAL_GATE, true),
    }).map((column) => column.id);
    expect(ids).toContain(HYPOTHETICAL_COLUMN_ID);
  });

  it("agrees with the table's own derivation in both gate states", () => {
    // Both surfaces go through ONE function, so the menu cannot offer what the
    // table will not render. Exercised directly against a hypothetical spec list
    // because that is the case a two-column fixture can never reach.
    const specs = [
      { id: SESSIONS_BRANCHES_COLUMN_ID, gate: null },
      { id: HYPOTHETICAL_COLUMN_ID, gate: HYPOTHETICAL_GATE },
    ];
    expect(
      selectOfferableSessionColumns(specs, {
        enabledGates: gatesWith(HYPOTHETICAL_GATE, false),
      }).map((spec) => spec.id)
    ).toEqual([SESSIONS_BRANCHES_COLUMN_ID]);
    expect(
      selectOfferableSessionColumns(specs, {
        enabledGates: gatesWith(HYPOTHETICAL_GATE, true),
      }).map((spec) => spec.id)
    ).toEqual([SESSIONS_BRANCHES_COLUMN_ID, HYPOTHETICAL_COLUMN_ID]);
  });
});

describe("declarative gatedness cannot drift (ISS-5713)", () => {
  it("excludes a gated column when its flag is off and includes it when on", () => {
    const off = resolveRenderedSessionColumnIds({
      enabledGates: {},
      hiddenColumnIds: [],
      hostSuppliedColumnIds: SESSIONS_DATA_COLUMN_ORDER,
    });
    expect(off).not.toContain(SESSIONS_PROJECTS_COLUMN_ID);
    expect(off).not.toContain(SESSIONS_ISSUES_COLUMN_ID);

    const on = resolveRenderedSessionColumnIds({
      enabledGates: { [GRID_TABLE_V2_FLAG_KEY]: true },
      hiddenColumnIds: [],
      hostSuppliedColumnIds: SESSIONS_DATA_COLUMN_ORDER,
    });
    expect(on).toContain(SESSIONS_PROJECTS_COLUMN_ID);
    expect(on).toContain(SESSIONS_ISSUES_COLUMN_ID);
  });

  it("every column states its gate, so a new one cannot default to ungated", () => {
    for (const spec of SESSIONS_COLUMN_SPECS) {
      // `gate` is a REQUIRED field on the spec type — this asserts the runtime
      // shape matches, so the compile-time forcing function is not the only
      // thing standing between a new column and an unstated gate.
      expect(Object.hasOwn(spec, "gate")).toBe(true);
      expect(spec.gate === null || spec.gate === GRID_TABLE_V2_FLAG_KEY).toBe(
        true
      );
    }
  });

  it("uses `null`, not `undefined`, as the ungated sentinel the runtime reads", () => {
    // wongk (`sessions-table-columns.ts:434`): the field doc named `undefined`
    // as the ungated sentinel and pointed at a `SESSIONS_COLUMN_GATES` map,
    // while the required field carries `null` directly on the specs and no such
    // map exists. This pins the answer the RUNTIME acts on, so the doc and the
    // type cannot disagree again without a red test.
    const ungated = SESSIONS_COLUMN_SPECS.filter((spec) => spec.gate === null);
    expect(ungated.length).toBeGreaterThan(0);
    for (const spec of SESSIONS_COLUMN_SPECS) {
      expect(spec.gate).not.toBeUndefined();
    }
    // …and the derivation both consumers share treats exactly `null` as "no
    // gate to satisfy": an ungated column survives an EMPTY enabled-gate map.
    const offered = selectOfferableSessionColumns(
      ungated.map((spec) => ({ id: spec.id, gate: spec.gate })),
      { enabledGates: {} }
    );
    expect(offered).toHaveLength(ungated.length);
  });

  it("catches a hand-maintained exclusion list that has drifted from the declaration", () => {
    // The pre-ISS-5713 shape: a consumer that re-states which columns are gated.
    // `e2e/sessions-list-surface.spec.ts` carried exactly this literal, and a PR
    // adding two gated columns broke all five of its tests without touching it.
    const staleHandMaintainedGatedIds = [SESSIONS_PROJECTS_COLUMN_ID];
    const declaredGatedIds = SESSIONS_COLUMN_SPECS.filter(
      (spec) => spec.gate !== null
    ).map((spec) => spec.id);

    // The drifted fixture disagrees with the declaration — which is the failure
    // this enforcement exists to make loud rather than silent.
    expect(staleHandMaintainedGatedIds).not.toEqual(declaredGatedIds);
    // And the derivation, which reads the declaration, is right regardless of
    // what any consumer's copy says.
    expect(declaredGatedIds).toEqual([
      SESSIONS_PROJECTS_COLUMN_ID,
      SESSIONS_ISSUES_COLUMN_ID,
    ]);
  });
});

describe("the branch -> branches rename keeps persisted views working (ISS-5770)", () => {
  it("declares the prototype's plural id and keeps the visible label", () => {
    const spec = SESSIONS_COLUMN_SPECS.find(
      (candidate) => candidate.id === SESSIONS_BRANCHES_COLUMN_ID
    );
    expect(spec?.label).toBe("Linked branches");
    expect(SESSIONS_DATA_COLUMN_ORDER).not.toContain(
      SESSIONS_LEGACY_BRANCHES_COLUMN_ID
    );
  });

  it("resolves a persisted legacy id to the renamed column", () => {
    expect(normalizeSessionColumnId(SESSIONS_LEGACY_BRANCHES_COLUMN_ID)).toBe(
      SESSIONS_BRANCHES_COLUMN_ID
    );
    // Unknown ids pass through: a view can carry a column another build knows.
    expect(normalizeSessionColumnId("someFutureColumn")).toBe(
      "someFutureColumn"
    );
    // Idempotent, so normalizing an already-migrated view is safe.
    expect(normalizeSessionColumnId(SESSIONS_BRANCHES_COLUMN_ID)).toBe(
      SESSIONS_BRANCHES_COLUMN_ID
    );
  });

  it("keeps a legacy hidden-column entry hiding the renamed column", () => {
    const rendered = resolveRenderedSessionColumnIds({
      enabledGates: {},
      // A saved view written before the rename.
      hiddenColumnIds: [SESSIONS_LEGACY_BRANCHES_COLUMN_ID],
    });
    expect(rendered).not.toContain(SESSIONS_BRANCHES_COLUMN_ID);
  });
});
