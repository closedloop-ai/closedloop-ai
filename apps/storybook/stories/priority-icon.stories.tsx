import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  PRIORITY_VALUES_HIGHEST_FIRST,
  priorityLabel,
} from "@repo/design-system/lib/priority-order";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

/**
 * Renders the canonical signal-bar SVG glyph for a priority level. Reads
 * every value, label, and order from `@repo/design-system/lib/priority-order`
 * (ISS-9094) instead of declaring its own vocabulary — LOW/MEDIUM/HIGH render
 * as one/two/three active bars, and URGENT swaps to a categorically
 * different filled glyph with an interior "!" cutout rather than a fourth
 * bar, so the most urgent value never reads as "just more bars" (see
 * `AllPriorities`).
 *
 * ## Taxonomy
 * Primitives/Feedback & Status — a pure, stateless display glyph. The
 * domain-shaped composed variant (with `loading` / `error` / `selected` /
 * etc. states) is `TablePriorityCell`, covered under
 * `Composites/Data Display/Tables/Table Cell Semantic Primitives`. The
 * domain-shaped composition that owns every product rendering of this glyph
 * is `ArtifactPriority`
 * (`packages/app/shared/components/artifact-priority/artifact-priority.tsx`,
 * ISS-9307), under `Composites/App Shell/Artifact Priority`; its editable form is
 * `ArtifactPriorityEditor`. `EditablePriorityTableCell`
 * (`packages/app/shared/components/generic-artifact-surface/semantic-cells.tsx`)
 * and `PriorityCell`
 * (`packages/app/documents/components/table/cells/edit-cells.tsx`) are
 * Storybook-demo surfaces, not product ones — `ArtifactPriority` superseded
 * them as the real call site.
 *
 * ## State matrix — which of the 16 apply to this primitive
 * `PriorityIcon` takes one required `priority` prop and defines no purpose-built
 * state props of its own — no `disabled`, no `state`. It does extend
 * `SVGAttributes<SVGSVGElement>` and spread the rest onto the `<svg>` (this is
 * separate from `size`, which is its own declared, destructured prop, not part
 * of that spread — `CustomSize` demonstrates `size`, not the spread), so
 * `onClick`, `tabIndex`, `role`, and any other SVG/DOM attribute genuinely
 * reach the element if a caller passes them; no story here exercises that path
 * directly, since none of the real consumers below do either. The states
 * below are "not applicable" because this component implements no BEHAVIOR or
 * styling for them, not because the props can't arrive:
 *
 * - **default** — every story on this page.
 * - **narrow** — see `NarrowContainer`. The icon is a fixed-size SVG
 *   (`shrink-0`, width/height set as attributes), so a tight column cannot
 *   compress it into an unreadable bar count.
 * - **overflow** — not applicable, and `NarrowContainer` is the complete
 *   proof: there is no text content to clip and no layout-dependent sizing
 *   to overflow.
 * - **hover, focus-visible, selected, editing, dragging, drag-over,
 *   read-only, permission, disabled** — not applicable. A caller CAN forward
 *   `onClick`/`tabIndex`/`role` through the prop-spread escape hatch above,
 *   but this component renders no built-in interactive affordance, hover
 *   style, or focus ring of its own for any of them. That behavior belongs to
 *   the wrapping cell or button — `TablePriorityCell`'s `disabled` /
 *   `selected` / `focusVisible` props, or the `hover:` classes on
 *   `EditablePriorityTableCell`'s trigger button.
 * - **loading, empty, partial, error** — not applicable. `priority` is
 *   required and non-nullable; a caller with no value renders
 *   `GridEmptyValue` instead of this icon (see `TablePriorityCell`'s
 *   `!priority` branch) rather than asking this component to represent
 *   "no value yet".
 *
 * ## Accessibility
 * The SVG carries no accessible name of its own — `aria-hidden` is opt-in via
 * prop spread, not a default, because this icon is meant to sit beside a
 * visible or `sr-only` text label stating the same priority (see
 * `AccessibilityContract`, and how `TablePriorityCell` pairs it with a text
 * span). `ArtifactPriority`
 * (`packages/app/shared/components/artifact-priority/artifact-priority.tsx`)
 * is the product composition that holds that contract for every rendering of
 * this glyph: where its variant drops the VISIBLE word — the icon-only variants,
 * and the compact "My Issues" cell on a default-priority row, so a page of them
 * reads as quiet icons rather than a repeated word — it emits an `sr-only` one
 * instead, so the value never reaches the accessibility tree through shape and
 * hue alone. A lone `<PriorityIcon priority="HIGH" />` with no sibling text
 * anywhere else is an accessibility bug at the CALL SITE, not something this
 * component can prevent structurally.
 * `@storybook/addon-a11y` surfaces an automated axe scan per story in the
 * Accessibility panel; the assertions below are additional real DOM/attribute
 * checks on top of that, not a substitute for it.
 *
 * Light/dark coverage comes from the global preview config
 * (`apps/storybook/.storybook/preview.tsx`): `withThemeByClassName` puts a
 * manager toolbar toggle on every story. Visual-regression coverage does
 * NOT: `parameters.chromatic.modes` only has an effect when a Chromatic build
 * actually uploads snapshots, and nothing in this repo's CI runs that step —
 * so despite the config being present, there is no automated screenshot diff
 * for this story today. Flagged rather than left implied; wiring up a real
 * Chromatic run is outside this ticket's scope.
 */
const meta = {
  title: "Primitives v1.0/Feedback & Status/Priority Icon",
  component: PriorityIcon,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    priority: {
      control: "select",
      options: [...PRIORITY_VALUES_HIGHEST_FIRST],
    },
    size: {
      control: "number",
    },
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof PriorityIcon>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The three bar rects (`width="3"`), in DOM order, and each one's opacity —
 * `"1"` for an active bar, `"0.3"` for an inactive one. URGENT renders none of
 * these (it draws a different rect shape entirely), so the array is empty. */
function getBarOpacities(canvasElement: HTMLElement): string[] {
  return Array.from(canvasElement.querySelectorAll('rect[width="3"]')).map(
    (rect) => rect.getAttribute("opacity") ?? ""
  );
}

/**
 * The default priority icon at LOW priority.
 */
export const Default: Story = {
  args: {
    priority: "LOW",
  },
  play: async ({ canvasElement }) => {
    await expect(getBarOpacities(canvasElement)).toEqual(["1", "0.3", "0.3"]);
  },
};

/**
 * Low priority — one active bar.
 */
export const Low: Story = {
  args: {
    priority: "LOW",
  },
  play: async ({ canvasElement }) => {
    await expect(getBarOpacities(canvasElement)).toEqual(["1", "0.3", "0.3"]);
  },
};

/**
 * Medium priority — two active bars.
 */
export const Medium: Story = {
  args: {
    priority: "MEDIUM",
  },
  play: async ({ canvasElement }) => {
    await expect(getBarOpacities(canvasElement)).toEqual(["1", "1", "0.3"]);
  },
};

/**
 * High priority — three active bars.
 */
export const High: Story = {
  args: {
    priority: "HIGH",
  },
  play: async ({ canvasElement }) => {
    await expect(getBarOpacities(canvasElement)).toEqual(["1", "1", "1"]);
  },
};

/**
 * Urgent priority — a filled rectangle with an exclamation-mark cutout, not a
 * fourth bar. The DOM has zero bar rects and exactly one `width="14"` body
 * rect, which is how the play function tells the two families apart.
 */
export const Urgent: Story = {
  args: {
    priority: "URGENT",
  },
  play: async ({ canvasElement }) => {
    await expect(getBarOpacities(canvasElement)).toEqual([]);
    await expect(
      canvasElement.querySelector('rect[width="14"]')
    ).not.toBeNull();
  },
};

/**
 * All four priority levels, most urgent first — `PRIORITY_VALUES_HIGHEST_FIRST`,
 * not a locally re-typed array. ISS-9094 exists specifically so nothing in
 * the tree re-spells this order.
 */
export const AllPriorities: Story = {
  tags: ["!manifest"],
  args: {
    priority: "LOW",
  },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {PRIORITY_VALUES_HIGHEST_FIRST.map((level) => (
        <div
          key={level}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <PriorityIcon priority={level} />
          <span style={{ fontSize: 11 }}>{priorityLabel(level)}</span>
        </div>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("svg").length).toBe(
      PRIORITY_VALUES_HIGHEST_FIRST.length
    );
    // URGENT is the only glyph with the distinct filled body rect.
    await expect(
      canvasElement.querySelectorAll('rect[width="14"]').length
    ).toBe(1);
  },
  parameters: { controls: { disable: true } },
};

/**
 * Demonstrates a custom icon size of 24px — `size` sets the SVG's `width`
 * and `height` attributes directly.
 */
export const CustomSize: Story = {
  args: {
    priority: "HIGH",
    size: 24,
  },
  play: async ({ canvasElement }) => {
    const svg = canvasElement.querySelector("svg");
    await expect(svg?.getAttribute("width")).toBe("24");
    await expect(svg?.getAttribute("height")).toBe("24");
  },
};

/**
 * Narrow — the icon inside a column barely wider than its own box.
 * `shrink-0` keeps its intrinsic size; nothing here can compress it into an
 * unreadable signal-bar count, because size comes from the SVG's own
 * `width`/`height` attributes, not from the flex layout around it.
 *
 * Overflow is not a separate story: there is no text content to clip, and a
 * fixed-attribute SVG has no layout-dependent size to overflow — this is the
 * complete demonstration for both matrix rows.
 */
export const NarrowContainer: Story = {
  args: {
    priority: "HIGH",
  },
  render: (args) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        width: 24,
        border: "1px dashed var(--border)",
        padding: 4,
      }}
    >
      <PriorityIcon {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const svg = canvasElement.querySelector("svg");
    await expect(svg?.getAttribute("width")).toBe("16");
    await expect(svg?.getAttribute("height")).toBe("16");
  },
};

/**
 * Accessibility contract: `aria-hidden` is never set by default (left), so a
 * bare icon with no sibling text has no accessible name — a call-site bug,
 * not something this component enforces structurally. The right example is
 * how `TablePriorityCell` renders it: the icon carries `aria-hidden`, and an
 * adjacent text node carries the name. `ArtifactPriority` (see the meta doc
 * above) is the same pairing, and holds it on the variants that paint no
 * VISIBLE word by substituting an `sr-only` one — so the name is always in the
 * tree even when nothing is on screen beside the glyph. That substitution is
 * the composition's job, not this primitive's, and is not what this story
 * demonstrates.
 */
export const AccessibilityContract: Story = {
  args: {
    priority: "HIGH",
  },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <PriorityIcon priority="HIGH" />
        <span style={{ fontSize: 11 }}>
          Bare icon — no aria-hidden, no adjacent text (avoid this)
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <PriorityIcon aria-hidden priority="HIGH" />
        <span>{priorityLabel("HIGH")}</span>
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const [bareIcon, pairedIcon] = canvasElement.querySelectorAll("svg");
    await expect(bareIcon.getAttribute("aria-hidden")).toBeNull();
    await expect(pairedIcon.getAttribute("aria-hidden")).toBe("true");
    await expect(
      within(canvasElement).getByText(priorityLabel("HIGH"))
    ).toBeVisible();
  },
  parameters: { controls: { disable: true } },
};
