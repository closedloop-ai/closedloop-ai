import { PriorityBadge } from "@repo/design-system/components/ui/priority-badge";
import {
  PRIORITY_LABELS,
  PRIORITY_VALUES_HIGHEST_FIRST,
} from "@repo/design-system/lib/priority-order";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";

const WHITESPACE_NOWRAP_CLASS_PATTERN = /whitespace-nowrap/;

/**
 * Displays a color-coded, full-text badge for a priority level. The label
 * always renders — priority is never communicated by color alone — and both
 * the label text and the value order read from
 * `@repo/design-system/lib/priority-order` (ISS-9094) rather than a local
 * label map.
 *
 * ## Product ownership
 * PRD-711 v1 and PRD-715 v4 selected the champion, and ISS-9307 / PR #7180
 * shipped it: product surfaces compose `ArtifactPriority`, whose badge variant
 * renders this `PriorityBadge` pill primitive. The canonical inventory is
 * `packages/app/shared/lib/artifact-priority-ownership.ts`.
 *
 * Search results still enter through `IssuePriorityBadge`. With the
 * closed-by-default `artifact-priority-surfaces` flag off — the shipped
 * default — it renders the legacy rollback badge; with the flag on it delegates
 * to `ArtifactPriority`. Other mounted surfaces compose `ArtifactPriority`
 * directly, so `IssuePriorityBadge` is a selector and rollback arm, not a
 * second champion. `TablePriorityCell` remains the separate table primitive.
 *
 * ## Taxonomy
 * Primitives/Feedback & Status — same tier as `PriorityIcon`. See that
 * story for the primitive / composed / domain layering
 * (`TablePriorityCell`, `EditablePriorityTableCell`, `PriorityCell`).
 *
 * ## State matrix — which of the 16 apply to this primitive
 * `PriorityBadge` takes one required `priority` prop and renders a plain
 * `<span>`, but that span's props extend `HTMLAttributes<HTMLSpanElement>`
 * and forward the rest via spread — so `onClick`, `tabIndex`, `role`, and any
 * other span attribute genuinely reach the DOM if a caller passes them, the
 * same escape hatch `PriorityIcon` has. The states below are "not applicable"
 * because this component implements no purpose-built state prop or behavior
 * for them, not because the underlying props can't arrive:
 *
 * - **default** — every story below.
 * - **narrow** — see `Narrow`.
 * - **overflow** — `Narrow` also covers this: the badge text is
 *   `whitespace-nowrap` and never truncates. The longest labels ("Medium",
 *   "Urgent") are short enough that this has not been a real problem in
 *   practice, but there is no truncation fallback if a caller ever places
 *   this inside a column narrower than that — flagged as an open question,
 *   not fixed here; a truncation fallback is a separate scope from ISS-9308's
 *   Storybook/catalog and contrast-fix work.
 * - **hover, focus-visible, selected, editing, dragging, drag-over,
 *   read-only, permission, disabled, loading, empty, partial, error** — not
 *   applicable, for the same reason as `PriorityIcon`: a caller CAN forward
 *   interaction props through the spread above, but this component renders
 *   no built-in state styling or behavior of its own for any of them. These
 *   states are real for `TablePriorityCell` (see its own story's
 *   `StateMatrix`) and for the domain editors composed on top of it.
 *
 * ## Accessibility
 * Unlike the icon, the label text itself is the accessible name.
 * `@storybook/addon-a11y` surfaces an automated axe scan per story in the
 * Accessibility panel; the assertions below are additional real rendered
 * text and role checks on top of that, not a substitute for it. Light/dark
 * coverage
 * comes from the global preview config the same way `PriorityIcon`'s story
 * documents. Visual-regression coverage does NOT: `parameters.chromatic.modes`
 * only has an effect when a Chromatic build actually uploads snapshots, and
 * nothing in this repo's CI runs that step today — see `PriorityIcon`'s story
 * for the full note.
 */
const meta = {
  title: "Primitives v1.0/Feedback & Status/Priority Badge",
  component: PriorityBadge,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    priority: {
      control: "select",
      options: [...PRIORITY_VALUES_HIGHEST_FIRST],
    },
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof PriorityBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default priority badge at MEDIUM priority.
 */
export const Default: Story = {
  args: {
    priority: "MEDIUM",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(PRIORITY_LABELS.MEDIUM)).toBeVisible();
    await expect(
      canvasElement.querySelector('[data-slot="priority-badge"]')
    ).not.toBeNull();
    // Non-interactive by design: no button/link role to pick up a focus ring
    // or click handler that does not exist on this component.
    await expect(canvas.queryByRole("button")).not.toBeInTheDocument();
  },
};

/**
 * Low priority badge.
 */
export const Low: Story = {
  args: {
    priority: "LOW",
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(PRIORITY_LABELS.LOW)
    ).toBeVisible();
  },
};

/**
 * Medium priority badge.
 */
export const Medium: Story = {
  args: {
    priority: "MEDIUM",
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(PRIORITY_LABELS.MEDIUM)
    ).toBeVisible();
  },
};

/**
 * High priority badge.
 *
 * `text-destructive`, never `text-destructive-foreground`, is pinned directly
 * here — not left to a visual check. `toBeVisible()` alone does not catch a
 * revert to `-foreground`: jsdom has no real CSS engine, so it never computes
 * that the resulting text is white-on-a-near-white tint. Without this
 * assertion, reverting the fix would keep every existing check green while
 * the badge went unreadable again.
 */
export const High: Story = {
  args: {
    priority: "HIGH",
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(PRIORITY_LABELS.HIGH)
    ).toBeVisible();
    const badge = canvasElement.querySelector('[data-slot="priority-badge"]');
    await expect(badge?.classList.contains("text-destructive")).toBe(true);
    await expect(badge?.classList.contains("text-destructive-foreground")).toBe(
      false
    );
  },
};

/**
 * Urgent priority badge. Same contrast pin as `High` — see its doc comment.
 */
export const Urgent: Story = {
  args: {
    priority: "URGENT",
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(PRIORITY_LABELS.URGENT)
    ).toBeVisible();
    const badge = canvasElement.querySelector('[data-slot="priority-badge"]');
    await expect(badge?.classList.contains("text-destructive")).toBe(true);
    await expect(badge?.classList.contains("text-destructive-foreground")).toBe(
      false
    );
  },
};

/**
 * All priority badges, most urgent first — `PRIORITY_VALUES_HIGHEST_FIRST`,
 * not a locally re-typed array.
 */
export const AllPriorities: Story = {
  tags: ["!manifest"],
  args: {
    priority: "MEDIUM",
  },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {PRIORITY_VALUES_HIGHEST_FIRST.map((level) => (
        <PriorityBadge key={level} priority={level} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const labels = Array.from(
      canvasElement.querySelectorAll('[data-slot="priority-badge"]')
    ).map((node) => node.textContent);
    await expect(labels).toEqual(
      PRIORITY_VALUES_HIGHEST_FIRST.map((level) => PRIORITY_LABELS[level])
    );
  },
  parameters: { controls: { disable: true } },
};

/**
 * A custom `className` merges with the variant's own classes rather than
 * replacing them — the `cn()` contract every design-system component follows.
 */
export const CustomClassName: Story = {
  args: {
    className: "test-custom-badge-class",
    priority: "HIGH",
  },
  play: async ({ canvasElement }) => {
    const badge = canvasElement.querySelector('[data-slot="priority-badge"]');
    await expect(badge?.classList.contains("test-custom-badge-class")).toBe(
      true
    );
    await expect(badge?.classList.contains("rounded-full")).toBe(true);
  },
};

/**
 * Native span attributes are forwarded, including caller-owned data hooks and
 * interaction handlers. Caller ownership of `data-slot` is deliberate for
 * this primitive: native props are spread after its default slot marker. The
 * focusable interaction sample also supplies complete button semantics rather
 * than documenting a mouse-only keyboard stop.
 */
export const ForwardedSpanAttributes: Story = {
  args: {
    "aria-label": "High priority badge interaction sample",
    "data-slot": "priority-badge-caller-slot",
    "data-testid": "priority-badge-forwarding",
    onClick: fn(),
    onKeyDown: (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      event.currentTarget.click();
    },
    priority: "HIGH",
    role: "button",
    tabIndex: 0,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const badge = canvas.getByTestId("priority-badge-forwarding");
    await expect(badge).toHaveAccessibleName(
      "High priority badge interaction sample"
    );
    await expect(badge).toHaveAttribute(
      "data-slot",
      "priority-badge-caller-slot"
    );
    await expect(badge).toHaveAttribute("tabindex", "0");
    await userEvent.click(badge);
    await expect(args.onClick).toHaveBeenCalledOnce();
    badge.focus();
    await expect(badge).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("[Space]");
    await expect(args.onClick).toHaveBeenCalledTimes(3);
  },
};

/**
 * Narrow — the badge inside a column narrower than its own content. The
 * label stays on one line (`whitespace-nowrap`) rather than wrapping; see the
 * doc block above for the open question this raises about a narrower
 * fallback.
 */
export const Narrow: Story = {
  args: {
    priority: "URGENT",
  },
  render: (args) => (
    <div style={{ border: "1px dashed var(--border)", padding: 4, width: 56 }}>
      <PriorityBadge {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const badge = canvasElement.querySelector('[data-slot="priority-badge"]');
    await expect(badge?.className).toMatch(WHITESPACE_NOWRAP_CLASS_PATTERN);
    await expect(
      within(canvasElement).getByText(PRIORITY_LABELS.URGENT)
    ).toBeVisible();
  },
};
