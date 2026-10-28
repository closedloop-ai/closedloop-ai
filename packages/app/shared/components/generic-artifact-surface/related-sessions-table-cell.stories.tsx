import { formatTimeOfDayOrMonthDay } from "@repo/app/shared/lib/date-utils";
import { TableCellValueState } from "@repo/design-system/components/ui/table-cell-primitives";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import {
  RELATED_SESSIONS_TABLE_EMPTY_TITLE,
  RelatedSessionsTableCell,
  type RelatedSessionTableItem,
} from "./related-sessions-table-cell";
import {
  RELATED_SESSIONS_FIXTURE_ITEMS,
  RELATED_SESSIONS_FIXTURE_NOW,
} from "./related-sessions-table-cell.fixtures";

const ACTIVE_SESSION_NAME =
  /SES-595-3 · Avery Example · Active · Wrote to artifact/;
const OVERFLOW_COUNT = /\+\d/;
const FAILED_SESSION_NAME = /SES-595-1/;
const PICTURE_OWNER = /SES-595-3 · Avery Example/;
const NO_PICTURE_OWNER = /SES-595-3 · Morgan Sample/;

const meta = {
  title: "Composites v1.0/App Shell/Related Sessions Table Cell",
  component: RelatedSessionsTableCell,
  tags: ["deprecated", "autodocs"],
  args: {
    items: RELATED_SESSIONS_FIXTURE_ITEMS,
    now: RELATED_SESSIONS_FIXTURE_NOW,
  },
  // The shared `TableCellPrimitiveStateProps` contract this component
  // forwards (see the doc comment on `Disabled` below): every value here is
  // real and finite, so it gets a real Control on every story in this file,
  // not left discoverable only by already knowing to scroll to a
  // separately-named story. `state` in particular has two more values
  // (`Forbidden`, `Partial`) than any story below demonstrates — the
  // dropdown is what makes that gap visible at all.
  argTypes: {
    disabled: { control: "boolean" },
    focusVisible: { control: "boolean" },
    selected: { control: "boolean" },
    state: {
      control: "select",
      options: [
        TableCellValueState.Default,
        TableCellValueState.Error,
        TableCellValueState.Forbidden,
        TableCellValueState.Loading,
        TableCellValueState.Partial,
        TableCellValueState.Unavailable,
      ],
    },
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof RelatedSessionsTableCell>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The three-session cell at its nominal column width.
 *
 * The play proves only the domain projection this component owns: the complete
 * accessible sentence, the calendar-aware label derived from `occurredAt`
 * against the injected clock, and the status tone. It deliberately does NOT
 * assert the link element or visible-versus-overflow split.
 *
 * `TableReferenceListCell` decides how many chips are visible from measured
 * width, and the story sweep runs plays in jsdom, which lays nothing out and
 * reports every width as 0 — so with more than one reference it always
 * collapses to `+N` and no chip is ever rendered as an anchor here. The
 * link/accessible-name half is pinned where a single reference makes the chip
 * real, by "renders a real link with the complete accessible name" in
 * `__tests__/related-sessions-table-cell.test.tsx`; the measured split is
 * pinned by `MeasuredOverflow` below.
 *
 * The expected label is derived through `formatTimeOfDayOrMonthDay` rather than
 * pinned as `"08/14"`. A play cannot pin `process.env.TZ` — the render it
 * asserts on has already happened by the time it runs — and a literal would be
 * red for every viewer east of the fixture's zone.
 */
export const Presentation: Story = {
  render: (args) => (
    <div className="w-[320px]">
      <RelatedSessionsTableCell {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const active = canvas.getAllByTitle(ACTIVE_SESSION_NAME)[0];
    const failed = canvas.getAllByTitle(FAILED_SESSION_NAME)[0];

    await expect(active).toHaveTextContent(
      fixtureLabel(RELATED_SESSIONS_FIXTURE_ITEMS[0])
    );
    await expect(failed).toHaveTextContent(
      fixtureLabel(RELATED_SESSIONS_FIXTURE_ITEMS[2])
    );
    await expect(failed).toHaveClass("text-destructive");
  },
};

export const MeasuredOverflow: Story = {
  render: (args) => (
    <div className="w-[112px]">
      <RelatedSessionsTableCell {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const overflow = await canvas.findByText(OVERFLOW_COUNT);

    await expect(overflow).toBeVisible();
    await userEvent.hover(overflow);
    const tooltip = await within(canvasElement.ownerDocument.body).findByRole(
      "tooltip"
    );

    await expect(tooltip).toHaveTextContent("SES-595-3");
    await expect(tooltip).toHaveTextContent("SES-595-1");
  },
};

export const Empty: Story = {
  args: { items: [] },
  play: async ({ canvasElement }) => {
    const empty = canvasElement.querySelector('[data-slot="grid-empty-value"]');

    await expect(empty).toBeVisible();
    await expect(empty).toHaveAttribute(
      "title",
      RELATED_SESSIONS_TABLE_EMPTY_TITLE
    );
  },
};

/**
 * The two owner-identity sources side by side, each in a single-reference cell
 * so the measured fit leaves the chip visible in jsdom as well as the browser.
 *
 * The play proves the fallback half of the contract: both sources render the
 * avatar pill variant, and each carries its own owner's initials. The loaded
 * picture is browser-only — Radix's `Avatar.Image` mounts nothing until the
 * image fires `load`, and jsdom never loads one, so an assertion on
 * `[data-slot="avatar-image"]` could only ever be red here. That the URL
 * reaches the primitive at all is pinned on the projection instead, by
 * "projects the domain item into the compact reference contract" in
 * `__tests__/related-sessions-table-cell.test.tsx`; picture-over-initials
 * itself is a visual claim owned by the Storybook/Chromatic render.
 */
export const AvatarSources: Story = {
  render: () => (
    <div className="grid w-[320px] grid-cols-[90px_220px] items-center gap-x-4 gap-y-4">
      <span className="text-muted-foreground text-sm">Picture</span>
      <RelatedSessionsTableCell
        items={[RELATED_SESSIONS_FIXTURE_ITEMS[0]]}
        now={RELATED_SESSIONS_FIXTURE_NOW}
      />
      <span className="text-muted-foreground text-sm">No picture</span>
      <RelatedSessionsTableCell
        items={[
          {
            ...RELATED_SESSIONS_FIXTURE_ITEMS[0],
            id: "session-no-picture",
            ownerAvatarUrl: undefined,
            ownerName: "Morgan Sample",
          },
        ]}
        now={RELATED_SESSIONS_FIXTURE_NOW}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const withPicture = canvas.getAllByTitle(PICTURE_OWNER)[0];
    const withoutPicture = canvas.getAllByTitle(NO_PICTURE_OWNER)[0];

    await expect(withPicture).toHaveClass("rounded-full");
    await expect(withoutPicture).toHaveClass("rounded-full");
    // One initial on every avatar (Nerys, 2026-10-22).
    await expect(within(withPicture).getByText("A")).toBeInTheDocument();
    await expect(within(withoutPicture).getByText("M")).toBeInTheDocument();
  },
};

/**
 * ISS-9096 acceptance criteria calls for disabled, focus-visible, selected,
 * and loading states on this component. These are not this component's own
 * states — they're the shared `TableCellPrimitiveStateProps` contract that
 * `TableReferenceListCell` (and every other table-cell-primitives consumer)
 * inherits. `__tests__/table-cell-primitive-states.test.tsx` already pins the
 * attributes, classes, and loading short-circuit at the primitive boundary;
 * what these stories add is the CONSUMER half — that this component actually
 * forwards the props through to the primitive, and that the states render in
 * the browser sweep as well as in jsdom.
 * Grounded directly in `getTableCellPrimitiveStateAttributes` /
 * `getTableCellPrimitiveStateClassName` / `getTableCellPrimitiveStateValue`
 * in `table-cell-primitives.tsx` — the exact attributes and classes below are
 * what that code emits today, not assumed from the prop names.
 */
export const Disabled: Story = {
  args: { items: [RELATED_SESSIONS_FIXTURE_ITEMS[0]], disabled: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const cell = canvasElement.querySelector("[data-cell-disabled]");
    const chip = canvas.getAllByTitle(ACTIVE_SESSION_NAME)[0];

    await expect(cell).toHaveAttribute("aria-disabled", "true");
    await expect(cell).toHaveClass("pointer-events-none");
    await expect(cell).toHaveClass("opacity-50");
    // The wrapper being styled disabled is not the same claim as the reference
    // inside it being inert: assert the chip itself, and that the interactive
    // role it would otherwise carry is gone.
    await expect(chip).toHaveAttribute("aria-disabled", "true");
    await expect(
      canvas.queryByRole("button", { name: ACTIVE_SESSION_NAME })
    ).toBeNull();
    await expect(
      canvas.queryByRole("link", { name: ACTIVE_SESSION_NAME })
    ).toBeNull();
  },
};

export const FocusVisible: Story = {
  args: { items: [RELATED_SESSIONS_FIXTURE_ITEMS[0]], focusVisible: true },
  play: async ({ canvasElement }) => {
    const cell = canvasElement.querySelector("[data-cell-focus-visible]");

    await expect(cell).toHaveClass("ring-2");
    await expect(cell).toHaveClass("ring-ring");
  },
};

export const Selected: Story = {
  args: { items: [RELATED_SESSIONS_FIXTURE_ITEMS[0]], selected: true },
  play: async ({ canvasElement }) => {
    const cell = canvasElement.querySelector("[data-cell-selected]");

    await expect(cell).toHaveClass("bg-primary/10");
  },
};

/**
 * Loading is not a boolean on this component — it's the shared
 * `state: TableCellValueState.Loading` short-circuit, which replaces the
 * reference list entirely rather than decorating it. Import the real enum
 * rather than the literal `"loading"` so this story breaks if that contract
 * is ever renamed instead of silently asserting against a stale string.
 *
 * "Replaces" is the half the placeholder assertion alone cannot pin, so the
 * play also asserts the fixture's chip title is gone. That absence is safe
 * only because the SAME locator is a positive control elsewhere in this file:
 * `Disabled` renders the identical single-item fixture and resolves
 * `ACTIVE_SESSION_NAME`, so a locator that silently stopped matching would
 * redden there rather than pass quietly here.
 */
export const Loading: Story = {
  args: {
    items: [RELATED_SESSIONS_FIXTURE_ITEMS[0]],
    state: TableCellValueState.Loading,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvasElement.querySelector('[role="status"]');

    await expect(status).toHaveAttribute("aria-busy", "true");
    await expect(status).toHaveTextContent("Loading cell value");
    await expect(canvas.queryByTitle(ACTIVE_SESSION_NAME)).toBeNull();
  },
};

/** The label the cell must render for a fixture item, in the viewer's zone. */
function fixtureLabel(item: RelatedSessionTableItem): string {
  return formatTimeOfDayOrMonthDay(item.occurredAt, {
    now: RELATED_SESSIONS_FIXTURE_NOW,
  });
}
