import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { LEADING_COLUMN_DATA_ID } from "@repo/design-system/lib/grid-table-v2-rows";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSIONS_TOGGLEABLE_COLUMNS,
  sessionsToggleableColumns,
} from "../../../hooks/use-sessions-view-state";
import {
  resolveRenderedSessionColumnIds,
  SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS,
  SESSIONS_SEAM_REQUIRED_COLUMN_IDS,
  selectOfferableSessionColumns,
} from "../../../lib/sessions-column-visibility";
import {
  normalizeSessionColumnId,
  SESSIONS_AUTONOMY_COLUMN_ID,
  SESSIONS_BRANCHES_COLUMN_ID,
  SESSIONS_COLUMN_SPECS,
  SESSIONS_DATA_COLUMN_ORDER,
  SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS,
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_LEGACY_BRANCHES_COLUMN_ID,
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_TAGS_COLUMN_ID,
} from "../../../lib/sessions-table-columns";
import { SessionsTable } from "../session-detail-table";
import { createSessionTableRowFixture } from "../session-list-fixtures";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-5770 / ISS-5713: the Sessions table's default column set, its order, and
 * its View menu carry the approved Sessions contract, and every consumer now
 * derives them from one declaration instead of restating them.
 *
 * The prototype now renders `SessionsListSurfaceV2` directly, so it has no
 * second `COLUMN_SPECS` to compare. The historical approved contract remains a
 * literal oracle here so a reordering of the shared declaration fails loudly —
 * which is what the old parallel View menu never did.
 */

/**
 * The approved 17 columns, in order, with the operator-confirmed defaults.
 *
 * Deliberately a literal rather than a second runtime declaration: this list is
 * the contract being pinned. The prototype consumes the shared surface, so
 * runtime parity is identity rather than synchronization.
 */
const APPROVED_COLUMNS: readonly { id: string; defaultOn: boolean }[] = [
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
 * not just a column spec, and each was approved as default-OFF — which is why
 * the default-visible set is already reachable without them.
 */
const UNIMPLEMENTED_APPROVED_COLUMN_IDS: readonly string[] = [
  // ISS-8712 removed `tags` from this list: the column now ships (default-OFF,
  // seam-required, gated on `sessions-artifact-tags`) reading the generic
  // `TagArtifact` join, in exactly the slot this literal already predicted —
  // between `status` and `owner`. Its removal is what makes the order assertion
  // below prove the new column landed in the prototype's slot.
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

/**
 * ISS-10332 / PLN-2086: a production column with no prototype slot that the
 * operator ruled SHOWN by default (ruling 5, 2026-09-21). It sits beside Status
 * and outside the prototype's order, so the order assertion sets it aside the
 * way it sets aside the default-OFF pair; `sessions-table-columns.test.tsx`
 * pins its slot and its default.
 */
const SHOWN_PRODUCTION_COLUMN_IDS: readonly string[] = ["priority"];

const ROW: SessionTableRow = createSessionTableRowFixture({
  autonomy: 88,
  branch: "feature/auth-guard",
  model: "opus-4.8",
  repo: "acme/app",
  status: "Working",
  user: { avatarUrl: null, name: "Pascoe Birchall" },
});

function renderName(row: SessionTableRow, className: string) {
  return (
    <a className={className} href={`/sessions/${row.id}`}>
      {row.name}
    </a>
  );
}

/** The rendered data-column ids, left to right, off one real screen. */
function renderedHeaderIds(): string[] {
  return screen
    .getAllByRole("columnheader")
    .map((cell) => cell.getAttribute("data-column-id"))
    .filter((id): id is string => Boolean(id) && id !== LEADING_COLUMN_DATA_ID);
}

describe("Sessions approved column contract (ISS-5770)", () => {
  it("declares the approved order for every implemented column", () => {
    const approvedOrder = APPROVED_COLUMNS.map((column) => column.id).filter(
      (id) => !UNIMPLEMENTED_APPROVED_COLUMN_IDS.includes(id)
    );
    const declaredOrder = SESSIONS_DATA_COLUMN_ORDER.filter(
      (id) =>
        !(
          EXTRA_PRODUCTION_COLUMN_IDS.includes(id) ||
          SHOWN_PRODUCTION_COLUMN_IDS.includes(id)
        )
    );
    expect(declaredOrder).toEqual(approvedOrder);
  });

  it("defaults exactly the approved ten ON columns, in order", () => {
    const expected = APPROVED_COLUMNS.filter(
      (column) =>
        column.defaultOn &&
        !UNIMPLEMENTED_APPROVED_COLUMN_IDS.includes(column.id)
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
    // Every GATED column stays out — a gate is a property of the BUILD, so no
    // `visibleColumns` set can conjure one — while the default-hidden columns do
    // appear, because nothing has hidden them yet.
    //
    // ISS-8712: derived from `spec.gate`, not the hand-listed pair this used to
    // name. That literal was the same shape as the drifted `FLAG_GATED_COLUMN_IDS`
    // this file's last describe block exists to catch: adding a third gated
    // column reddened a correct build, and the test's own name already says
    // "ungated" rather than "not those two".
    // `Set<string>`, not the literal union the const specs infer: the ids it is
    // checked against come from `SESSIONS_DATA_COLUMN_ORDER`, which is widened.
    const gatedIds = new Set<string>(
      SESSIONS_COLUMN_SPECS.filter((spec) => spec.gate !== null).map(
        (spec) => spec.id
      )
    );
    expect(gatedIds.size).toBeGreaterThan(0);
    // A seam-required column a bare mount wires no seam for stays out too
    // (ISS-10332: `priority` is ungated AND seam-required, so this is the first
    // column where the two questions have different answers).
    expect(renderedHeaderIds()).toEqual(
      SESSIONS_DATA_COLUMN_ORDER.filter(
        (id) => !(gatedIds.has(id) || SESSIONS_SEAM_REQUIRED_COLUMN_IDS.has(id))
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
      { [SESSIONS_ARTIFACT_TAGS_FLAG_KEY]: true },
      { [SESSIONS_ARTIFACT_TAGS_FLAG_KEY]: false },
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

  /**
   * ISS-10301 ungated the pair: `grid-table-v2` retired ENABLED, so the SEAM
   * DATA is the whole condition now. This case asserts both directions of it.
   *
   * Its sibling, "offers no seam-required entry without the seam data", went with
   * the flag: it pinned the AND — seams present, gate closed, entries withheld —
   * and with no gate left its second arm asserted the entries were absent WITH
   * the seams supplied, which is the opposite of what the surface must now do.
   */
  it("hides the linked-entity entries until the surface supplies their seams", () => {
    const offIds = sessionsToggleableColumns().map((column) => column.id);
    expect(offIds).not.toContain(SESSIONS_PROJECTS_COLUMN_ID);
    expect(offIds).not.toContain(SESSIONS_ISSUES_COLUMN_ID);
    const onIds = sessionsToggleableColumns({
      hostSuppliedColumnIds: [...SESSIONS_SEAM_REQUIRED_COLUMN_IDS],
    }).map((column) => column.id);
    expect(onIds).toContain(SESSIONS_PROJECTS_COLUMN_ID);
    expect(onIds).toContain(SESSIONS_ISSUES_COLUMN_ID);
  });
});

/**
 * ISS-5770 review (codex `use-sessions-view-state.ts:65`, whitlockk `:63`).
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
  /**
   * ISS-10301 re-pointed this case. It used to drive both arms with
   * `grid-table-v2`, which gated the Projects and Issues columns; that key
   * retired ENABLED and both specs now carry `gate: null`, so driving them here
   * would have made the two arms byte-identical and the assertions
   * self-contradicting. Tags is the one spec still carrying a gate, so it is what
   * the gate rule can actually be observed through — and the seam-only behaviour
   * of the linked-entity pair keeps its own case above.
   */
  it("excludes a gated column when its flag is off and includes it when on", () => {
    const off = resolveRenderedSessionColumnIds({
      enabledGates: {},
      hiddenColumnIds: [],
      hostSuppliedColumnIds: SESSIONS_DATA_COLUMN_ORDER,
    });
    expect(off).not.toContain(SESSIONS_TAGS_COLUMN_ID);

    const on = resolveRenderedSessionColumnIds({
      enabledGates: { [SESSIONS_ARTIFACT_TAGS_FLAG_KEY]: true },
      hiddenColumnIds: [],
      hostSuppliedColumnIds: SESSIONS_DATA_COLUMN_ORDER,
    });
    expect(on).toContain(SESSIONS_TAGS_COLUMN_ID);
  });

  it("every column states its gate, so a new one cannot default to ungated", () => {
    for (const spec of SESSIONS_COLUMN_SPECS) {
      // `gate` is a REQUIRED field on the spec type — this asserts the runtime
      // shape matches, so the compile-time forcing function is not the only
      // thing standing between a new column and an unstated gate.
      expect(Object.hasOwn(spec, "gate")).toBe(true);
      // What this pins is the thing that matters — a spec cannot carry a gate
      // string outside the union `SessionsColumnGate` declares. ISS-8712 widened
      // it from one key to the vocabulary; ISS-10301 narrowed the vocabulary back
      // to one when `grid-table-v2` retired ENABLED.
      expect(
        spec.gate === null || spec.gate === SESSIONS_ARTIFACT_TAGS_FLAG_KEY
      ).toBe(true);
    }
  });

  it("uses `null`, not `undefined`, as the ungated sentinel the runtime reads", () => {
    // whitlockk (`sessions-table-columns.ts:434`): the field doc named `undefined`
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
    // Every seam is supplied so only the GATE half is under test here.
    const offered = selectOfferableSessionColumns(
      ungated.map((spec) => ({ id: spec.id, gate: spec.gate })),
      {
        enabledGates: {},
        hostSuppliedColumnIds: [...SESSIONS_SEAM_REQUIRED_COLUMN_IDS],
      }
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
    // what any consumer's copy says. ISS-10301 took Projects and Issues out of
    // this set: `grid-table-v2` was their gate and it retired ENABLED, so Tags is
    // the only gated column left — which is exactly the kind of movement a
    // hand-maintained copy misses and this case exists to make loud.
    expect(declaredGatedIds).toEqual([SESSIONS_TAGS_COLUMN_ID]);
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
