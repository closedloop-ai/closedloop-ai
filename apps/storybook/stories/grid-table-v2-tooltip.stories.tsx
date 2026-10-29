/**
 * The champion grid's tooltip — ISS-9290.
 *
 * A thin restyle of the design-system tooltip (denser padding, a border, no
 * arrow) that the grid's header and cells use so every hover explanation inside
 * a grid reads the same. It is the grid's OVERFLOW affordance: the surface that
 * gives a reader the value a clipped track could not show them.
 *
 * The story exists because the component is a re-export module, and a re-export
 * is exactly the kind of thing that rots invisibly — a subpath that stops
 * forwarding one of the four names still typechecks at its own boundary and
 * fails only in whichever consumer imported that name.
 *
 * Applicable states: default (closed), open, focus-visible, and
 * keyboard/pointer interaction — a tooltip that only answered to hover is
 * unreachable for a keyboard user (WCAG 2.1.1). Not applicable: selected,
 * editing, dragging, drag-over, loading, empty, partial, error, disabled,
 * read-only, permission and narrow — this is a transient popover over content
 * it does not own, and it has no data of its own to be in any of those states.
 */
import { Button } from "@repo/design-system/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/grid-table-v2-tooltip";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, waitFor, within } from "storybook/test";

const meta = {
  title: "Primitives v1.0/Overlays/Grid Table V2 Tooltip",
  component: TooltipContent,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TooltipContent>;

export default meta;

type Story = StoryObj<typeof meta>;

const TRIGGER_LABEL = "Status";
const TOOLTIP_TEXT = "Lifecycle state reported by the collector";

/**
 * The arrow, wherever Radix positions it. A DESCENDANT selector, not a child
 * one: Popper wraps the arrow `svg` in its own absolutely-positioned `span`, so
 * `> svg` matches nothing — which also means the wrapper's own
 * `[&>svg]:fill-popover` class never applies to it. That styling bug predates
 * this story and is reported rather than fixed here.
 */
const TOOLTIP_ARROW_SELECTOR = '[data-slot="tooltip-content"] svg';

/**
 * Classes the v2 wrapper merges in that the base tooltip does not carry — the
 * denser padding and the explicit border that make a tooltip read as part of the
 * grid's chrome.
 */
const WRAPPER_CLASSES = ["border-border", "bg-popover", "px-2.5", "py-1.5"];

/**
 * The clipped value a reader can still reach. Long enough that the trigger
 * cannot show it, which is the situation the tooltip exists for.
 */
const CLIPPED_VALUE = "Reconciliation disposition pending review".repeat(2);

/**
 * Hover opens it and moving away closes it again. The close half is asserted
 * because a tooltip that opens and never closes covers the cell beneath it —
 * and a story that only ever opened one would not notice.
 */
export const OnHover: Story = {
  render: () => <TooltipStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: TRIGGER_LABEL });

    // Closed at rest: no popover, and the trigger describes itself with nothing.
    await expect(openTooltip(canvasElement)).toBeNull();
    await expect(trigger).not.toHaveAttribute("aria-describedby");

    await userEvent.hover(trigger);
    await waitFor(() => {
      expect(openTooltip(canvasElement)).toHaveTextContent(TOOLTIP_TEXT);
    });

    // The two things this module decides FOR ITSELF, without which every
    // assertion in this file would still pass against a bare
    // `export { TooltipContent } from "…/tooltip"` and pin only Radix:

    // 1. No arrow — it defaults `hideArrow` to true where the base defaults false.
    await expect(
      canvasElement.ownerDocument.querySelector(TOOLTIP_ARROW_SELECTOR)
    ).toBeNull();

    // 2. The restyle it merges in, which is the whole reason the grid has its
    // own tooltip rather than importing the base one.
    for (const wrapperClass of WRAPPER_CLASSES) {
      await expect(openTooltip(canvasElement)).toHaveClass(wrapperClass);
    }

    // The popover is ASSOCIATED with the control, not merely adjacent to it —
    // an unassociated tooltip is invisible to a screen reader on the trigger.
    await expect(trigger).toHaveAttribute("aria-describedby");

    // Escape dismisses it WITHOUT moving the pointer, which WCAG 1.4.13
    // (Content on Hover or Focus) requires of any hover-revealed content. In a
    // grid this is not a nicety: the tooltip is positioned over the neighbouring
    // cells, so a reader who cannot dismiss it cannot read the row underneath.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(openTooltip(canvasElement)).toBeNull();
    });

    // The association is released with it, so the control stops advertising a
    // description that is no longer on screen.
    await expect(
      canvas.getByRole("button", { name: TRIGGER_LABEL })
    ).not.toHaveAttribute("aria-describedby");
  },
};

/**
 * The keyboard route to the same content. A grid whose only explanation of a
 * clipped value is a hover target has simply not given that value to a keyboard
 * user (WCAG 2.1.1), so this is the positive sibling of `OnHover` rather than a
 * duplicate of it: same content, a different input.
 */
export const OnKeyboardFocus: Story = {
  render: () => <TooltipStory />,
  play: async ({ canvasElement }) => {
    await expect(openTooltip(canvasElement)).toBeNull();

    await userEvent.tab();
    await expect(
      within(canvasElement).getByRole("button", { name: TRIGGER_LABEL })
    ).toHaveFocus();
    await waitFor(() => {
      expect(openTooltip(canvasElement)).toHaveTextContent(TOOLTIP_TEXT);
    });
  },
};

/**
 * The arrow, opted back in.
 *
 * The positive sibling of `OnHover`'s no-arrow assertion, and the reason that
 * assertion means anything: it proves `TOOLTIP_ARROW_SELECTOR` can actually
 * match, so the negative cannot be passing on a selector that matches nothing.
 * It also pins the prop pass-through — the wrapper changes the DEFAULT, it does
 * not remove the caller's choice.
 */
export const WithArrow: Story = {
  render: () => <TooltipStory hideArrow={false} />,
  play: async ({ canvasElement }) => {
    await userEvent.hover(
      within(canvasElement).getByRole("button", { name: TRIGGER_LABEL })
    );
    await waitFor(() => {
      expect(
        canvasElement.ownerDocument.querySelector(TOOLTIP_ARROW_SELECTOR)
      ).not.toBeNull();
    });
  },
};

/**
 * The overflow case the grid actually uses this for: a value too wide for its
 * track, offered in full on demand.
 *
 * The assertion is that the tooltip carries the WHOLE value — a tooltip
 * repeating the same truncation as the cell beneath it is decoration, not an
 * affordance.
 */
export const ClippedCellValue: Story = {
  render: () => <TooltipStory tooltipText={CLIPPED_VALUE} />,
  play: async ({ canvasElement }) => {
    await userEvent.hover(
      within(canvasElement).getByRole("button", { name: TRIGGER_LABEL })
    );
    await waitFor(() => {
      expect(openTooltip(canvasElement)).toHaveTextContent(CLIPPED_VALUE);
    });
  },
};

/**
 * The rendered popover, or `null` while the tooltip is closed.
 *
 * Addressed by `data-slot="tooltip-content"` — the element THIS component
 * emits — and deliberately NOT by `role="tooltip"`. Radix mirrors the content
 * into a visually-hidden live region that also carries `role="tooltip"`, and
 * that span survives the close: a first draft of this story queried the role,
 * matched the 1x1 clipped announcement copy instead of the popover, and passed
 * its "is open" assertions without the popover ever having rendered.
 *
 * The portal mounts at the document root, outside `canvasElement`, so the
 * lookup has to go through `ownerDocument` rather than `within`.
 */
function openTooltip(canvasElement: HTMLElement): HTMLElement | null {
  return canvasElement.ownerDocument.querySelector<HTMLElement>(
    '[data-slot="tooltip-content"]'
  );
}

function TooltipStory({
  hideArrow,
  tooltipText = TOOLTIP_TEXT,
}: {
  hideArrow?: boolean;
  tooltipText?: string;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <TooltipProvider>
        {/* The Root prop wins over provider context, and the design-system
            `Tooltip` nests its OWN provider with delayDuration=700 — which would
            leave every hover assertion ~300ms from `waitFor`'s 1000ms cap. */}
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button className="max-w-40 truncate" size="sm" variant="outline">
              {TRIGGER_LABEL}
            </Button>
          </TooltipTrigger>
          <TooltipContent hideArrow={hideArrow}>{tooltipText}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </main>
  );
}
