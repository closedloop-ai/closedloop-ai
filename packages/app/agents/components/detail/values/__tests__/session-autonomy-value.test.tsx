import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { TRACE_PREFIX_COUNTED_NOTE } from "@repo/app/shared/lib/trace-truncation-copy";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostAvailability } from "../../../../lib/cost-availability";
import { SESSIONS_AUTONOMY_COLUMN_ID } from "../../../../lib/sessions-table-columns";
import { SessionsTable } from "../../../sessions/session-detail-table";
import { createSessionTableRowFixture } from "../../../sessions/session-list-fixtures";
import { createAgentSessionDetailFixture } from "../../agent-session-detail-fixtures";
import {
  resolveSessionAutonomyExplanation,
  SessionAutonomyValue,
} from "../session-autonomy-value";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-5565: the session-detail Properties panel coerced absent counts to `0`.
 * PLN-2169 M2 moved the Autonomy value out of the row, so the behaviour is
 * pinned on the value here and the row's test proves only that it mounts it.
 *
 * The headline case had a WITNESS: the Sessions list already rendered the
 * shared empty affordance for `autonomy == null` (`session-detail-table.tsx`), while
 * the detail rendered `getAutonomyLabel(session.autonomy)` next to
 * `session.autonomy ?? 0`, i.e. "Unknown autonomy | 0/100". One record, two
 * surfaces, two different claims — and the surface a reader reaches by clicking
 * the dash is the one that lied.
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
 * The list's AUTONOMY cell specifically, not just any empty cell in the row:
 * on this fixture branch/model/duration are all empty too, so the first dash
 * anywhere in the table proves nothing about the field under test.
 * `GridBodyCell` surfaces its owning column via `data-column-id`.
 */
function listAutonomyCell(list: HTMLElement): HTMLElement {
  // `role="cell"` excludes the `role="columnheader"` of the same column.
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
          <SessionAutonomyValue session={session} />
        </div>
      </>
    );

    const list = within(container).getByTestId("list-surface");
    const detail = within(container).getByTestId("detail-surface");

    const detailGlyphs = emptyGlyphElements(detail);
    const listGlyphs = emptyGlyphElements(listAutonomyCell(list));

    // The detail says "nothing recorded" at all, rather than a tier word
    // beside a floor number.
    expect(detailGlyphs).toHaveLength(1);
    expect(detail.textContent).not.toContain("0/100");
    expect(detail.textContent).not.toContain("Unknown autonomy");

    // ...and it is the SAME glyph the list already used for THIS field.
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
          <SessionAutonomyValue session={session} />
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
    const { container } = render(<SessionAutonomyValue session={session} />);
    expect(container.textContent).toBe("High autonomy | 92/100");
  });
});

/**
 * ISS-5636: ISS-5565 taught the value to tell a measured `0` from an unknown,
 * but the desktop's bounded detail read (ISS-5407) leaves a THIRD state —
 * counted, but only over the events the producer could read. The qualifier
 * rides `autonomyTruncated`, NOT `eventsTruncated`: the cloud detail serves a
 * truncated `events` relation too, while reading autonomy off a persisted
 * column the cap never touches.
 */
describe("resolveSessionAutonomyExplanation: the value's one sentence", () => {
  it("says an unrecorded score was never recorded", () => {
    expect(resolveSessionAutonomyExplanation({ autonomy: null })).toBe(
      "Autonomy was not recorded for this session"
    );
  });

  it("qualifies a truncated score as a prefix count", () => {
    expect(
      resolveSessionAutonomyExplanation({
        autonomy: 41,
        autonomyTruncated: true,
      })
    ).toBe(`Autonomy was ${TRACE_PREFIX_COUNTED_NOTE}`);
  });

  it("keeps saying an unrecorded score was never recorded, not that it was cut short", () => {
    // A score the producer never emitted has no prefix count to describe, so
    // the two sentences are mutually exclusive rather than stacked.
    const sentence = resolveSessionAutonomyExplanation({
      autonomy: null,
      autonomyTruncated: true,
    });
    expect(sentence).toBe("Autonomy was not recorded for this session");
    expect(sentence).not.toContain(TRACE_PREFIX_COUNTED_NOTE);
  });

  it("has nothing to say about a whole-run score, even when the raw-event read was cut", () => {
    // The cloud producer never sets `autonomyTruncated`, so its numbers must not
    // become hedges — absence is the flag's only encoding of "whole run", and a
    // bounded raw-event read does not make a persisted score a prefix count.
    expect(resolveSessionAutonomyExplanation({ autonomy: 41 })).toBeUndefined();
    expect(
      resolveSessionAutonomyExplanation({
        ...createAgentSessionDetailFixture({
          autonomy: 41,
          eventsTruncated: true,
        }),
      })
    ).toBeUndefined();
  });
});
