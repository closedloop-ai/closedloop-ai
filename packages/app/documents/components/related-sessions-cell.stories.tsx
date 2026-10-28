import { GridTable } from "@repo/design-system/components/ui/grid-table";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import {
  RELATED_SESSIONS_EMPTY_TITLE,
  RelatedSessionsCell,
  type RelatedSessionsCellItem,
} from "./related-sessions-cell";

/**
 * ISS-7235 — interaction coverage for the promoted, READ-ONLY provenance cell.
 *
 * Every `play` below is written so an empty or unordered render fails it. That
 * matters more here than usual: an empty Related Sessions list satisfies almost
 * any "does not contain an editor" assertion, so each read-only case is paired
 * with a positive one that proves the pills actually rendered.
 *
 * The clock is pinned. "Today as a time, earlier as MM/DD" is a
 * calendar-boundary rule, and a story that read the wall clock would render
 * three times today and differently tomorrow.
 */
const NOW = new Date("2026-08-21T15:00:00.000Z");
const TIME_OF_DAY = /\d{1,2}:\d{2}\s?(AM|PM)/;
const ADA_CONTRIBUTION = /by Ada Lovelace, Aug 21, 2026/;
const UNKNOWN_OWNER_CONTRIBUTION = /by Unknown owner, Aug 2, 2026/;
const OVERFLOW_SENTENCE = /related sessions not shown/;
const ANY_OVERFLOW = /more/;
/** The middle fixture row, matched on the label inside its accessible name. */
const MIDDLE_TRIGGER_NAME = /Review the eligibility query/;
/** What that row's disclosure states: its owner and its full timestamp. */
const MIDDLE_DETAIL = "by Grace Hopper, Aug 14, 2026 at 6:30 PM";

/**
 * Three distinct timestamps, deliberately: a two-item fixture passes under a
 * reversed comparator half the time and a one-item fixture proves nothing about
 * order at all.
 */
const ITEMS: RelatedSessionsCellItem[] = [
  {
    id: "session-newest",
    label: "Refactor the ingest fold",
    ownerName: "Ada Lovelace",
    // A real URL: Radix only renders <img> once the image loads, which jsdom
    // never does, so this branch is only reachable in a browser story.
    ownerAvatarUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='%236366f1'/%3E%3C/svg%3E",
    status: "active",
    occurredAt: "2026-08-21T09:04:00.000Z",
    relationshipLabel: "Contributed",
    occurredAtLabel: "Aug 21, 2026 at 9:04 AM",
  },
  {
    id: "session-middle",
    label: "Review the eligibility query",
    ownerName: "Grace Hopper",
    ownerAvatarUrl: null,
    status: "inactive",
    occurredAt: "2026-08-14T18:30:00.000Z",
    relationshipLabel: "Commented",
    occurredAtLabel: "Aug 14, 2026 at 6:30 PM",
  },
  {
    id: "session-oldest",
    label: "Draft the provenance model",
    ownerName: null,
    ownerAvatarUrl: null,
    status: "error",
    occurredAt: "2026-08-02T11:00:00.000Z",
    relationshipLabel: "Contributed",
    occurredAtLabel: "Aug 2, 2026 at 11:00 AM",
  },
];

const meta = {
  title: "Composites v1.0/Documents/Related Sessions Cell",
  component: RelatedSessionsCell,
  tags: ["deprecated", "autodocs"],
  args: { items: ITEMS, now: NOW },
} satisfies Meta<typeof RelatedSessionsCell>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Presentation: owner, session, status word, and time all render per pill. */
export const Presentation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("Refactor the ingest fold")).toBeVisible();
    await expect(
      canvas.getByText("Review the eligibility query")
    ).toBeVisible();
    await expect(canvas.getByText("Draft the provenance model")).toBeVisible();
    // The owner rides in the pill's accessible sentence, not in hue or an
    // initials glyph alone.
    await expect(canvas.getByText(ADA_CONTRIBUTION)).toBeInTheDocument();
    await expect(
      canvas.getByText(UNKNOWN_OWNER_CONTRIBUTION)
    ).toBeInTheDocument();
    // The relationship word renders; it is not a hover-only secret.
    await expect(canvas.getAllByText("Contributed")).toHaveLength(2);
    await expect(canvas.getByText("Commented")).toBeVisible();
  },
};

/**
 * Ordering: the cell renders exactly what it is handed, newest first. The
 * assertion pins the sequence with hand-written literals rather than re-reading
 * the fixture, so a render that reversed or reshuffled the list fails.
 */
export const NewestContributionFirst: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rendered = canvas
      .getAllByRole("listitem")
      .map((node) => node.textContent ?? "");

    await expect(rendered).toHaveLength(3);
    await expect(rendered[0]).toContain("Refactor the ingest fold");
    await expect(rendered[1]).toContain("Review the eligibility query");
    await expect(rendered[2]).toContain("Draft the provenance model");
  },
};

/**
 * Status: active and inactive are distinguished by a WORD, not only by tone.
 * Asserting the rendered label (never a class name) is what makes this a WCAG
 * 1.4.1 check rather than a styling snapshot.
 */
export const StatusIsWordedNotOnlyColored: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("Active")).toBeVisible();
    await expect(canvas.getByText("Inactive")).toBeVisible();
    await expect(canvas.getByText("Failed")).toBeVisible();
  },
};

/**
 * The today/earlier rule, against the pinned clock: the Aug 21 contribution
 * reads as a time, the older two as MM/DD.
 */
export const TodayReadsAsATime: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [newest, middle, oldest] = canvas.getAllByRole("listitem");

    await expect(newest.textContent).toMatch(TIME_OF_DAY);
    await expect(middle.textContent).toContain("08/14");
    await expect(oldest.textContent).toContain("08/02");
  },
};

/** Overflow reports the sessions the cap HID, not the ones that survived it. */
export const Overflow: Story = {
  args: { total: 11 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("+8 more")).toBeVisible();
    await expect(canvas.getByText(OVERFLOW_SENTENCE)).toBeInTheDocument();
  },
};

/** A complete list claims no overflow. */
export const NoOverflowWhenComplete: Story = {
  args: { total: 3 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getAllByRole("listitem")).toHaveLength(3);
    await expect(canvas.queryByText(ANY_OVERFLOW)).not.toBeInTheDocument();
  },
};

/**
 * The disclosure carries the owner and the full timestamp, and OPENS ON
 * ACTIVATION rather than on hover (whitlockk review). This story runs in a real
 * browser, so it is the one place the ring and the panel are actually painted.
 */
export const ActivationDisclosure: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(
      canvas.getByRole("button", { name: MIDDLE_TRIGGER_NAME })
    );

    await expect(await findOpenDisclosureDetail(canvasElement)).toBeVisible();
  },
};

/**
 * The same disclosure, reached with the keyboard alone. Separate from the
 * pointer story on purpose: a hover-only tooltip passed a pointer check while
 * leaving keyboard and touch users with no route to the owner or timestamp at
 * all, which is the defect this pair now makes un-shippable.
 *
 * WCAG 2.1 §2.1.1 (Keyboard).
 */
export const KeyboardDisclosure: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", {
      name: MIDDLE_TRIGGER_NAME,
    });

    trigger.focus();
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    await expect(await findOpenDisclosureDetail(canvasElement)).toBeVisible();
  },
};

/**
 * READ-ONLY. The positive half is load-bearing: without it, an empty render
 * would satisfy every "no control" assertion below and the story would pass
 * while proving nothing.
 *
 * NARROWED from a blanket "zero buttons" (whitlockk review). That count was a proxy
 * for "no editor", and it was too broad: it also forbade the disclosure that
 * makes the owner and full timestamp reachable without a mouse, so honouring it
 * literally meant shipping a field two thirds of input methods could not read.
 * Read-only constrains what the reader can CHANGE, not whether they can operate
 * the field. So this now asserts the real contract — every control present is a
 * disclosure, and nothing here writes — which still fails on the editor this
 * story was written to keep out.
 */
export const ReadOnly: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getAllByRole("listitem")).toHaveLength(3);

    const controls = canvas.getAllByRole("button");
    await expect(controls).toHaveLength(3);
    for (const control of controls) {
      await expect(control).toHaveAttribute("aria-haspopup", "dialog");
    }

    await expect(canvas.queryAllByRole("textbox")).toHaveLength(0);
    await expect(
      canvasElement.querySelectorAll("input, textarea, [contenteditable]")
    ).toHaveLength(0);
    await expect(
      canvasElement.querySelectorAll("[data-grid-primary-editor]")
    ).toHaveLength(0);
  },
};

/**
 * ISS-7235 AC5 IS NOT MET, and this pins it so it cannot read as done.
 *
 * The AC asks that activating a row open the artifact's Sessions tab at this
 * session's most recent contributing interaction. That destination does not
 * exist in this repo, so nothing here navigates and no substitute was
 * invented. This story asserts the rows are inert ON PURPOSE — when the
 * Sessions tab lands, this story fails, which is exactly the reminder the next
 * author should get rather than discovering the gap from a ticket.
 *
 * The positive pill-count assertion is load-bearing: an empty render would
 * satisfy every "no link" check below on its own.
 */
export const NotYetNavigable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getAllByRole("listitem")).toHaveLength(3);
    await expect(canvas.queryAllByRole("link")).toHaveLength(0);
    await expect(
      canvasElement.querySelectorAll("a[href], [role='link']")
    ).toHaveLength(0);
  },
};

/** Genuinely empty says so, rather than rendering nothing at all. */
export const Empty: Story = {
  args: { items: [] },
  play: async ({ canvasElement }) => {
    const empty = canvasElement.querySelector('[data-slot="grid-empty-value"]');

    await expect(empty).toBeVisible();
    await expect(empty).toHaveAttribute("title", RELATED_SESSIONS_EMPTY_TITLE);
  },
};

type ArtifactRow = {
  id: string;
  name: string;
  sessions: RelatedSessionsCellItem[];
  total: number;
};

const ROWS: ArtifactRow[] = [
  { id: "PRD-595", name: "Provenance PRD", sessions: ITEMS, total: 11 },
  { id: "ISS-7235", name: "Related Sessions field", sessions: [], total: 0 },
];

/**
 * AC7 — a GridTable consumes the cell through `renderCell`, the only
 * editability seam either grid table has, and the column stays read-only. The
 * assertions run over the TABLE, so a grid that wrapped the cell in an inline
 * editor would fail here even though the cell's own story stayed green.
 */
export const ConsumedByGridTable: StoryObj = {
  render: () => (
    <GridTable<ArtifactRow>
      columns={[{ id: "sessions", label: "Related Sessions" }]}
      getRowId={(row) => row.id}
      gridTemplateColumns="minmax(12rem, 1fr) minmax(20rem, 2fr)"
      items={ROWS}
      leadingLabel="Artifact"
      renderCell={(columnId, row) =>
        columnId === "sessions" ? (
          <RelatedSessionsCell
            items={row.sessions}
            now={NOW}
            total={row.total}
          />
        ) : null
      }
      renderLead={(row) => row.name}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("Refactor the ingest fold")).toBeVisible();
    await expect(canvas.getByText("+8 more")).toBeVisible();
    await expect(
      canvasElement.querySelector('[data-slot="grid-empty-value"]')
    ).toBeVisible();
    await expect(
      canvasElement.querySelectorAll("input, textarea, [contenteditable]")
    ).toHaveLength(0);
    await expect(
      canvasElement.querySelectorAll("[data-grid-primary-editor]")
    ).toHaveLength(0);
  },
};

/**
 * The detail sentence AS IT APPEARS INSIDE THE OPEN PANEL, found through the
 * disclosure's own `dialog` role rather than by sweeping the document for text.
 *
 * Scoping it is what makes the two disclosure stories mean anything: the same
 * sentence also rides in the trigger's `sr-only` accessible name, so a
 * document-wide text query matches whether or not the popover ever opened, and
 * an inert trigger would satisfy it. The panel renders in a portal on `body`,
 * which is why the search starts there rather than on the canvas.
 */
async function findOpenDisclosureDetail(
  canvasElement: HTMLElement
): Promise<HTMLElement> {
  const panel = await within(canvasElement.ownerDocument.body).findByRole(
    "dialog"
  );

  return within(panel).getByText(MIDDLE_DETAIL);
}
