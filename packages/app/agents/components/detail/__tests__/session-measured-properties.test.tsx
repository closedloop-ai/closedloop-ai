import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostAvailability } from "../../../lib/cost-availability";
import { SESSIONS_AUTONOMY_COLUMN_ID } from "../../../lib/sessions-table-columns";
import { createSessionTableRowFixture } from "../../sessions/session-list-fixtures";
import {
  SessionsTable,
  type SessionTableRow,
} from "../../sessions/sessions-table";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import {
  SessionAutonomyProperty,
  SessionTokensProperty,
  SessionWorkProperty,
} from "../session-measured-properties";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-5565: the session-detail Properties panel coerced absent counts to `0`.
 *
 * The headline case is Autonomy, because it had a WITNESS: the Sessions list
 * already rendered the shared empty affordance for `autonomy == null`
 * (`sessions-table.tsx`), while the detail rendered
 * `getAutonomyLabel(session.autonomy)` next to `session.autonomy ?? 0`, i.e.
 * "Unknown autonomy | 0/100". One record, two surfaces, two different claims —
 * and the surface a reader reaches by clicking the dash is the one that lied.
 *
 * The parity spec below therefore renders BOTH surfaces from ONE record in ONE
 * tree and compares them to each other. Checking each independently against a
 * constant would keep passing if the two drifted apart again in the same
 * direction, which is precisely the failure mode being fixed.
 */

/** Wide enough that no list column folds out of the assertions. */
const NATURAL_LAYOUT_CONTAINER_PX = 4000;
const EM_DASH = "—";

/**
 * The class signature the shared sentinel actually renders with, read from the
 * component rather than hardcoded — so "both surfaces agree" cannot be
 * satisfied by both drifting onto the same bespoke dash.
 */
function sharedEmptyGlyphClassName(): string {
  const { container, unmount } = render(<GridEmptyValue />);
  const span = container.querySelector("span");
  if (!span) {
    throw new Error("GridEmptyValue did not render a span");
  }
  const className = span.className;
  unmount();
  return className;
}

/**
 * The list's AUTONOMY cell specifically, not just any empty cell in the row.
 *
 * Code review: the parity assertion used the first dash anywhere in the table,
 * which on this fixture is a different column entirely (branch/model/duration
 * are all empty too). That would keep passing if the autonomy cell regressed to
 * a bespoke glyph, so it proved nothing about the field under test.
 * `GridBodyCell` surfaces its owning column via `data-column-id`.
 */
function listAutonomyCell(list: HTMLElement): HTMLElement {
  // `role="cell"` excludes the `role="columnheader"` of the same column — both
  // carry `data-column-id`, and matching the header would assert against the
  // word "Autonomy" instead of the value under it.
  const cell = list.querySelector<HTMLElement>(
    `[role="cell"][data-column-id="${SESSIONS_AUTONOMY_COLUMN_ID}"]`
  );
  if (!cell) {
    throw new Error("list did not render an autonomy cell");
  }
  return cell;
}

function emptyGlyphElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("*")].filter(
    (element) =>
      element.childElementCount === 0 && element.textContent?.trim() === EM_DASH
  );
}

function renderName(row: SessionTableRow, className: string) {
  return (
    <a className={className} href={`/sessions/${row.id}`}>
      {row.name}
    </a>
  );
}

function listRowFor(autonomy: number | null): SessionTableRow {
  // ISS-5697: one shared row shape (`session-list-fixtures`). Most fields are
  // stated here not because the assertions read them but to keep every OTHER
  // column empty, so the em-dash this test counts can only have come from the
  // autonomy cell. `harness` is the only value left at the shared default.
  return createSessionTableRowFixture({
    autonomy,
    branch: null,
    costAvailability: CostAvailability.NoUsage,
    costLabel: "$0.00",
    durationLabel: null,
    id: "ses-parity",
    lastActivityLabel: null,
    mergeStatusLabel: null,
    model: null,
    name: "agent/parity",
    pullRequestSummaryLabel: null,
    pullRequests: [],
    repo: "acme/app",
    startedLabel: null,
    status: "Working",
  });
}

let restoreContainerWidth: (() => void) | null = null;

beforeEach(() => {
  restoreContainerWidth = stubContainerWidthPx(NATURAL_LAYOUT_CONTAINER_PX);
});

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("ISS-5565: list and detail agree about an unrecorded autonomy", () => {
  it("renders the same shared empty glyph on both surfaces for one null-autonomy record", () => {
    const session = createAgentSessionDetailFixture({ autonomy: null });
    const shared = sharedEmptyGlyphClassName();

    // ONE tree, ONE record, both surfaces. The comparison that matters is
    // list-vs-detail, not each-vs-a-constant.
    const { container } = render(
      <>
        <div data-testid="list-surface">
          <SessionsTable
            items={[listRowFor(session.autonomy ?? null)]}
            mode="expanded"
            renderName={renderName}
          />
        </div>
        <div data-testid="detail-surface">
          <SessionAutonomyProperty session={session} />
        </div>
      </>
    );

    const list = within(container).getByTestId("list-surface");
    const detail = within(container).getByTestId("detail-surface");

    const detailGlyphs = emptyGlyphElements(detail);
    const listGlyphs = emptyGlyphElements(listAutonomyCell(list));

    // The detail now says "nothing recorded" at all, rather than a tier word
    // beside a floor number.
    expect(detailGlyphs).toHaveLength(1);
    expect(detail.textContent).not.toContain("0/100");
    expect(detail.textContent).not.toContain("Unknown autonomy");

    // ...and it is the SAME glyph the list already used for THIS field — the
    // lookup is scoped to the autonomy column, so a regression there cannot
    // hide behind some other empty cell's dash.
    expect(listGlyphs).toHaveLength(1);
    expect(detailGlyphs[0].className).toBe(listGlyphs[0].className);
    expect(detailGlyphs[0].className).toBe(shared);
  });

  it("still renders a measured autonomy on both surfaces, including a real zero", () => {
    // The guard against over-correcting: 0 is a MEASURED score, not an absent
    // one, and must keep its tier word and its number on the detail.
    const session = createAgentSessionDetailFixture({ autonomy: 0 });
    const { container } = render(
      <>
        <div data-testid="list-surface">
          <SessionsTable
            items={[listRowFor(0)]}
            mode="expanded"
            renderName={renderName}
          />
        </div>
        <div data-testid="detail-surface">
          <SessionAutonomyProperty session={session} />
        </div>
      </>
    );

    const detail = within(container).getByTestId("detail-surface");
    expect(detail.textContent).toContain("0/100");
    expect(emptyGlyphElements(detail)).toHaveLength(0);

    const list = within(container).getByTestId("list-surface");
    expect(listAutonomyCell(list).textContent).toContain("0");
    expect(emptyGlyphElements(listAutonomyCell(list))).toHaveLength(0);
  });

  it("keeps a high measured autonomy rendering its tier word and score", () => {
    const session = createAgentSessionDetailFixture({ autonomy: 92 });
    const { container } = render(<SessionAutonomyProperty session={session} />);
    expect(container.textContent).toContain("92/100");
    expect(container.textContent).toContain("High autonomy");
  });
});

describe("ISS-5565: the Tokens row degrades per counter", () => {
  it("collapses to one glyph when no token counter was recorded", () => {
    const session = createAgentSessionDetailFixture({
      tokensIn: null,
      tokensOut: null,
      cache: null,
      cacheWrite: null,
    });
    const { container } = render(<SessionTokensProperty session={session} />);

    // One shrug, not four, and emphatically not "0 in | 0 out".
    expect(emptyGlyphElements(container)).toHaveLength(1);
    expect(container.textContent).not.toContain("0 in");
  });

  it("shows the counters it has and dashes only the ones it does not", () => {
    const session = createAgentSessionDetailFixture({
      tokensIn: 1234,
      tokensOut: 56,
      cache: null,
      cacheWrite: null,
    });
    const { container } = render(<SessionTokensProperty session={session} />);

    expect(container.textContent).toContain("1,234");
    expect(container.textContent).toContain("56");
    // Exactly the two unrecorded counters are dashed — a partially-recorded row
    // must not throw away the halves it does know.
    expect(emptyGlyphElements(container)).toHaveLength(2);
  });

  it("keeps a recorded zero as a zero", () => {
    const session = createAgentSessionDetailFixture({
      tokensIn: 0,
      tokensOut: 0,
      cache: 0,
      cacheWrite: 0,
    });
    const { container } = render(<SessionTokensProperty session={session} />);

    expect(emptyGlyphElements(container)).toHaveLength(0);
    expect(container.textContent).toContain("0 in");
  });
});

describe("ISS-5581: a missing value's reason is reachable without a mouse", () => {
  // Code review: the reason used to live in a native `title` on the dash, which
  // is hover-only. It now rides `PropertyValue`'s `explanation` (ISS-4654) — a
  // focusable button whose accessible name ends with the sentence — so the
  // assertions below are about the ROW's accessible name, not a title attribute.
  function explanationOf(container: HTMLElement): string {
    const trigger = container.querySelector("button");
    if (!trigger) {
      throw new Error("row did not render an explained (focusable) value");
    }
    return trigger.textContent ?? "";
  }

  it("puts the autonomy reason in the accessible name, not a hover-only title", () => {
    const session = createAgentSessionDetailFixture({ autonomy: null });
    const { container } = render(<SessionAutonomyProperty session={session} />);

    expect(explanationOf(container)).toContain(
      "Autonomy was not recorded for this session"
    );
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("names only the token counters that are actually missing", () => {
    const session = createAgentSessionDetailFixture({
      cache: null,
      cacheWrite: null,
      tokensIn: 100,
      tokensOut: 200,
    });
    const { container } = render(<SessionTokensProperty session={session} />);

    expect(explanationOf(container)).toContain(
      "Cache reads and cache writes were not recorded for this session"
    );
  });

  it("states the whole row once when no token counter was recorded", () => {
    const session = createAgentSessionDetailFixture({
      cache: null,
      cacheWrite: null,
      tokensIn: null,
      tokensOut: null,
    });
    const { container } = render(<SessionTokensProperty session={session} />);

    // Not four counter names strung together, and not the bare fragment "Not
    // recorded" that used to sit beside three full-sentence siblings.
    expect(explanationOf(container)).toContain(
      "Token counts were not recorded for this session"
    );
  });

  it("says nothing at all when every counter was recorded", () => {
    const session = createAgentSessionDetailFixture({
      cache: 1,
      cacheWrite: 2,
      tokensIn: 3,
      tokensOut: 4,
    });
    const { container } = render(<SessionTokensProperty session={session} />);

    // A fully-measured row is not a hedge, so it must not become a button with
    // an explanation appended to its name.
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("ISS-5565: the Work row stops inventing steering episodes", () => {
  it("dashes an unrecorded steering count instead of claiming zero steers", () => {
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: null,
      turns: 7,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    // "0 steers" and "we never counted" are different claims about how
    // autonomous the run was, and only one of them is true here.
    expect(container.textContent).not.toContain("0 steers");
    expect(container.textContent).toContain("7 turns");
    expect(emptyGlyphElements(container)).toHaveLength(1);
  });

  it("keeps a recorded zero-steer run reading as zero steers", () => {
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: 0,
      turns: 7,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(container.textContent).toContain("0 steers");
    expect(emptyGlyphElements(container)).toHaveLength(0);
  });

  it("falls back to the transcript length before giving up on the turn count", () => {
    // `turnItems.length` is a real derivation from the same record, not a
    // coercion, so it is used before the row admits it does not know.
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: 3,
      turns: null,
    });
    const { container } = render(<SessionWorkProperty session={session} />);
    const expectedTurns = session.turnItems?.length ?? 0;

    expect(expectedTurns).toBeGreaterThan(0);
    expect(container.textContent).toContain(`${expectedTurns} turns`);
    expect(emptyGlyphElements(container)).toHaveLength(0);
  });

  it("dashes the turn count when there is no transcript to count either", () => {
    // `turnItems` is optional on `AgentSessionDetail`, so an absent transcript
    // is a reachable shape — and with no turn count either, the row genuinely
    // does not know.
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: 3,
      turns: null,
      turnItems: undefined,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(container.textContent).not.toContain("0 turns");
    expect(emptyGlyphElements(container)).toHaveLength(1);
  });

  it("collapses to one glyph when no work counter was recorded at all", () => {
    // Code review: "— turns | 0 tool calls | — steers" is two shrugs strung on
    // pipes around a zero, which scans as a broken row rather than an honest
    // one. Tokens already collapses in this situation; Work now matches it.
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: null,
      toolCallsTotal: null,
      toolUseCount: 0,
      turnItems: undefined,
      turns: null,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(emptyGlyphElements(container)).toHaveLength(1);
    expect(container.textContent).not.toContain("turns");
    expect(container.textContent).not.toContain("tool calls");
    expect(container.textContent).not.toContain("steers");
  });

  it("keeps a measured tool-call count visible when its neighbours are unknown", () => {
    // The boundary the collapse must not cross: `toolUseCount` is
    // non-nullable, so a nonzero count is a MEASURED fact. Hiding it because
    // the counters either side of it were never recorded would trade one
    // dishonesty for another, so the row degrades per counter instead.
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: null,
      toolCallsTotal: null,
      toolUseCount: 12,
      turnItems: undefined,
      turns: null,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(container.textContent).toContain("12 tool calls");
    expect(emptyGlyphElements(container)).toHaveLength(2);
  });

  it("treats an empty transcript as a measured zero, not an unknown", () => {
    // The other side of the boundary above: an EMPTY `turnItems` array is
    // evidence — the transcript was read and held no turns — so "0 turns" is a
    // true statement here and must not be softened into a dash.
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: 3,
      turns: null,
      turnItems: [],
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(container.textContent).toContain("0 turns");
    expect(emptyGlyphElements(container)).toHaveLength(0);
  });
});
