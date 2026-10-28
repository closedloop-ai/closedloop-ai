/**
 * ISS-9307 — the duplicate-path guard.
 *
 * The champion's whole value is that there is exactly ONE implementation of the
 * priority mark. A test that only proves the champion works would stay green the
 * day someone adds a second renderer beside it, which is how the four label maps
 * and two rank maps ISS-9439 inventoried came to exist in the first place.
 *
 * So this asserts the negative, on the rendered surface: every priority glyph
 * and every priority word a champion-owned surface paints must sit inside a
 * `[data-slot="artifact-priority"]`. Reintroducing a page-private badge or a
 * hand-assembled `PriorityIcon` + label pair on one of those surfaces produces a
 * priority-bearing element with no champion above it, and this turns red.
 *
 * WHAT IT DOES NOT CLAIM, stated precisely because a guard read wider than it
 * reaches is worse than no guard:
 *
 *  - TWO SURFACES. It mounts `DocumentRow` and `ArtifactRowView` and nothing
 *    else, so it says nothing about the search results, the bulk bar, the filter
 *    facet, or the board. `useBulkPriorityAction` and `useDocumentTableFilterUi`
 *    still hand-assemble their option rows, and the flag-OFF `IssuePriorityBadge`
 *    still paints its own badge; those are the surfaces phases 04-06 migrate, and
 *    this file will not notice until they are mounted here.
 *  - MENUS CLOSED. The surface as a reader sees it. `ArtifactPriorityMenu`'s own
 *    option rows assemble a glyph and a label, deliberately outside this guard:
 *    the menu is the single owner of what the vocabulary offers, not a second
 *    renderer of one artifact's value.
 *  - LEAF-MOST EXACT MATCHES. A fork whose word sits beside a sibling element
 *    (`<Badge><Dot/>High</Badge>`), or that draws a glyph that is not
 *    `PriorityIcon`, escapes the text walk. The shapes it does catch are the ones
 *    the four inventoried label maps actually took.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

import { PRIORITY_TRIGGER_FIELD_LABEL } from "@repo/app/documents/components/artifact-field-menus";
import { ArtifactRowView } from "@repo/app/documents/components/relationships/artifact-row-view";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import { ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  makeArtifact,
  makeRawArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import type { ReactElement } from "react";

/**
 * Pinned as literals rather than read from the label map, so deleting a member
 * from that map cannot quietly shrink what this guard looks for.
 */
const PRIORITY_WORDS = [
  "Low",
  "Medium",
  "High",
  "Urgent",
  "No priority",
  "Unknown priority",
  // The empty mark counts: a hand-rolled dash beside the champion's own is the
  // second renderer this guard exists to catch, and it carries no glyph and no
  // word to be found by either of the checks above.
  "—",
];

const CHAMPION = '[data-slot="artifact-priority"]';
const GLYPH = '[data-slot="priority-icon"]';

const EDIT_HANDLERS: RowEditHandlers = { onUpdatePriority: vi.fn() };

afterEach(() => {
  cleanup();
});

/**
 * The activity treatments ship behind the `batch-706-champion-ui` key (ISS-4779
 * closed-by-default), so a case that wants to see one has to open it. Every other
 * case here mounts with no provider, which resolves closed and is the default.
 */
function gated(children: ReactElement) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

/**
 * Every element on the surface that states a priority without the champion
 * above it, described well enough to name the offending renderer in the failure.
 */
function priorityMarksOutsideChampion(container: HTMLElement): string[] {
  const offenders: string[] = [];
  for (const glyph of container.querySelectorAll(GLYPH)) {
    if (!glyph.closest(CHAMPION)) {
      offenders.push(`glyph in <${glyph.parentElement?.tagName ?? "?"}>`);
    }
  }
  for (const node of container.querySelectorAll("*")) {
    // Leaf-most only: an ancestor's textContent includes its children's words,
    // so counting every ancestor would report the same word many times and any
    // wrapper would look like an offender.
    if (node.childElementCount > 0) {
      continue;
    }
    const text = node.textContent?.trim() ?? "";
    if (PRIORITY_WORDS.includes(text) && !node.closest(CHAMPION)) {
      offenders.push(`"${text}" in <${node.tagName.toLowerCase()}>`);
    }
  }
  return offenders;
}

describe("the artifact grid paints priority through one path", () => {
  it("renders the priority cell inside the champion and nowhere else", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ priority: Priority.High }),
    };
    const { container } = render(
      <DocumentRow
        editHandlers={EDIT_HANDLERS}
        item={item}
        visibleColumns={[Col.Priority]}
      />
    );

    // The positive half, so the negative below cannot be satisfied by a cell
    // that renders nothing at all: the value IS on screen, through the champion.
    const marks = container.querySelectorAll(CHAMPION);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toContain("High");
    expect(container.querySelectorAll(GLYPH)).toHaveLength(1);

    expect(priorityMarksOutsideChampion(container)).toEqual([]);
  });

  it("keeps an unset priority on one path too", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ priority: null }),
    };
    const { container } = render(
      <DocumentRow
        editHandlers={EDIT_HANDLERS}
        item={item}
        visibleColumns={[Col.Priority]}
      />
    );

    // The positive half, which this case had no version of: the dash IS on
    // screen and it is the design system's, inside the champion. Without it the
    // offender walk below examines zero elements on an unset row — no glyph, and
    // a dash that was not in the word list — so it was satisfied by construction
    // and a second unset renderer beside the champion was invisible to it.
    const marks = container.querySelectorAll(CHAMPION);
    expect(marks).toHaveLength(1);
    expect(
      marks[0].querySelector('[data-slot="grid-empty-value"]')
    ).not.toBeNull();
    expect(priorityMarksOutsideChampion(container)).toEqual([]);
  });

  it("gives the whole cell one control and no separate caret", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ priority: Priority.Urgent }),
    };
    const { container } = render(
      <DocumentRow
        editHandlers={EDIT_HANDLERS}
        item={item}
        visibleColumns={[Col.Priority]}
      />
    );

    const trigger = screen.getByRole("button", { name: "Priority: Urgent" });
    // The mark is INSIDE the trigger, which is what "whole-cell editing" means:
    // the value and its hit target are one element, not a value plus a caret.
    expect(trigger.querySelector(CHAMPION)).not.toBeNull();
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // No redundant caret: the only vector inside the trigger is the priority
    // glyph itself. A chevron would be a second svg, and the positive half below
    // stops this passing on a trigger that draws nothing.
    const vectors = trigger.querySelectorAll("svg");
    expect(vectors).toHaveLength(1);
    expect(vectors[0].closest(GLYPH)).not.toBeNull();
    // Exactly one priority control on the row, so no second disclosure exists.
    expect(container.querySelectorAll(`button ${CHAMPION}`)).toHaveLength(1);
  });
});

describe("an artifact row paints priority through one path", () => {
  it("renders the read-only mark inside the champion", () => {
    const { container } = render(
      <ArtifactRowView
        priority={Priority.Low}
        slug="ISS-1"
        statusIcon={<span />}
        statusLabel="Todo"
        title="A row"
        typeIcon={<span />}
        typeLabel="Issue"
      />
    );

    expect(container.querySelectorAll(CHAMPION)).toHaveLength(1);
    expect(priorityMarksOutsideChampion(container)).toEqual([]);
  });

  it("renders the editable mark inside the champion", () => {
    const { container } = render(
      <ArtifactRowView
        onPriorityChange={vi.fn()}
        priority={Priority.Low}
        slug="ISS-1"
        statusIcon={<span />}
        statusLabel="Todo"
        title="A row"
        typeIcon={<span />}
        typeLabel="Issue"
      />
    );

    const trigger = screen.getByRole("button", { name: "Priority: Low" });
    expect(trigger.querySelector(CHAMPION)).not.toBeNull();
    expect(priorityMarksOutsideChampion(container)).toEqual([]);
  });

  it("announces a priority write in flight, and not otherwise", () => {
    const busy = render(
      gated(
        <ArtifactRowView
          onPriorityChange={vi.fn()}
          priority={Priority.Low}
          priorityPending
          slug="ISS-1"
          statusIcon={<span />}
          statusLabel="Todo"
          title="A row"
          typeIcon={<span />}
          typeLabel="Issue"
        />
      )
    );
    expect(
      busy.container.querySelector(CHAMPION)?.getAttribute("aria-busy")
    ).toBe("true");
    cleanup();

    const settled = render(
      gated(
        <ArtifactRowView
          onPriorityChange={vi.fn()}
          priority={Priority.Low}
          slug="ISS-1"
          statusIcon={<span />}
          statusLabel="Todo"
          title="A row"
          typeIcon={<span />}
          typeLabel="Issue"
        />
      )
    );
    expect(
      settled.container.querySelector(CHAMPION)?.getAttribute("aria-busy")
    ).toBeNull();
  });
});

// ISS-10332 (operator ruling 2026-09-21): a branch and a session CARRY a
// priority now, so the artifact grid paints the value through the champion —
// but this grid's commit path is the documents PUT, which cannot write one, so
// the mark is read-only here and the editor lives on the Sessions and Branches
// grids. Under the superseded 2026-09-11 ruling these two rows painted nothing.
describe("priority on the artifact grid's branch and session rows", () => {
  it("paints a branch row's priority through the champion, read-only", () => {
    const item: DocumentRowItem = {
      kind: "branch",
      data: makeRawArtifact(ArtifactType.Branch, { priority: Priority.High }),
    };
    const { container } = render(
      <DocumentRow
        editHandlers={EDIT_HANDLERS}
        item={item}
        visibleColumns={[Col.Priority]}
      />
    );

    // Handed a commit callback AND a value, the row paints the value once,
    // inside the champion, and offers no control: `onUpdatePriority` here is
    // the documents write, and a branch is not a document. Scoped to priority
    // controls because the row legitimately carries a favourite toggle and an
    // actions menu.
    expect(container.querySelectorAll(CHAMPION)).toHaveLength(1);
    expect(container.querySelectorAll(`${CHAMPION} ${GLYPH}`)).toHaveLength(1);
    expect(container.querySelectorAll(`button ${CHAMPION}`)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: namesPriority })).toBeNull();
  });

  it("paints a session row's priority through the champion, read-only", () => {
    const item: DocumentRowItem = {
      kind: "session",
      data: makeRawArtifact(ArtifactType.Session, { priority: Priority.High }),
    };
    const { container } = render(
      <DocumentRow
        editHandlers={EDIT_HANDLERS}
        item={item}
        visibleColumns={[Col.Priority]}
      />
    );

    expect(container.querySelectorAll(CHAMPION)).toHaveLength(1);
    expect(container.querySelectorAll(`${CHAMPION} ${GLYPH}`)).toHaveLength(1);
    expect(container.querySelectorAll(`button ${CHAMPION}`)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: namesPriority })).toBeNull();
  });

  it("does offer one on an artifact row, so the two above are a real refusal", () => {
    // The sibling positive. Without it, "no priority control" would be satisfied
    // by a harness that never renders a priority control for any row kind.
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ priority: Priority.High }),
    };
    const { container } = render(
      <DocumentRow
        editHandlers={EDIT_HANDLERS}
        item={item}
        visibleColumns={[Col.Priority]}
      />
    );

    expect(container.querySelectorAll(`button ${CHAMPION}`)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Priority: High" })).toBeTruthy();
  });
});

/** Any control naming priority, whatever value it currently shows. */
function namesPriority(name: string): boolean {
  return name
    .toLowerCase()
    .includes(PRIORITY_TRIGGER_FIELD_LABEL.toLowerCase());
}
