import { GRAPH_RESET_EVENT } from "@repo/design-system/components/ui/primitives/graph-events";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DashboardCard } from "../dashboard-card";
import { ExpandableWidget } from "../expandable-widget";

const WIDGET_TEXT = "widget body content";
const CLOSE_BUTTON_NAME_REGEX = /close/i;
const REPO_TOOLTIP_TEXT = "org/repo-name";

describe("ExpandableWidget", () => {
  it("renders a keyboard-focusable, aria-labeled corner expand control per widget", () => {
    render(
      <ExpandableWidget title="Model Usage">
        <div>{WIDGET_TEXT}</div>
      </ExpandableWidget>
    );

    const trigger = screen.getByRole("button", { name: "Expand Model Usage" });
    expect(trigger).toBeInTheDocument();
    // A native <button> is inherently keyboard-focusable (no tabIndex=-1).
    expect(trigger).not.toHaveAttribute("tabindex", "-1");
    // Content renders in-card before any expansion.
    expect(screen.getByText(WIDGET_TEXT)).toBeInTheDocument();
  });

  it("keeps the expand control discoverable on touch: hover-reveal on fine pointers, always visible on coarse pointers", () => {
    render(
      <ExpandableWidget title="Model Usage">
        <div>{WIDGET_TEXT}</div>
      </ExpandableWidget>
    );

    const trigger = screen.getByRole("button", { name: "Expand Model Usage" });
    // Default state is hover/focus-revealed (no layout shift on the grid)...
    expect(trigger).toHaveClass("opacity-0", "group-hover:opacity-100");
    // ...but coarse pointers (touch) have no hover event, so the affordance is
    // pinned visible there — otherwise the expand feature is undiscoverable on
    // tablets (FEA-3700 design-critic follow-up).
    expect(trigger).toHaveClass("pointer-coarse:opacity-100");
  });

  it("opens a modal dialog with the same widget content on activation", async () => {
    const user = userEvent.setup();
    render(
      <ExpandableWidget title="Autonomy Trend">
        <div>{WIDGET_TEXT}</div>
      </ExpandableWidget>
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Expand Autonomy Trend" })
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // Same content, re-rendered inside the large-format modal.
    expect(within(dialog).getByText(WIDGET_TEXT)).toBeInTheDocument();
    // Modal heading uses the widget title.
    expect(within(dialog).getByText("Autonomy Trend")).toBeInTheDocument();
  });

  it("dismisses the modal via the design-system close button", async () => {
    const user = userEvent.setup();
    render(
      <ExpandableWidget title="Event Activity">
        <div>{WIDGET_TEXT}</div>
      </ExpandableWidget>
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Event Activity" })
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: CLOSE_BUTTON_NAME_REGEX })
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("dismisses the modal via the Escape key (design-system focus-trap/Esc)", async () => {
    const user = userEvent.setup();
    render(
      <ExpandableWidget title="Agent Collaboration">
        <div>{WIDGET_TEXT}</div>
      </ExpandableWidget>
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Agent Collaboration" })
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the modal heading sr-only when the content owns its title (no double heading)", async () => {
    const user = userEvent.setup();
    render(
      <ExpandableWidget title="Recent Sessions" titleInContent>
        <div>
          <h2>Recent Sessions</h2>
          {WIDGET_TEXT}
        </div>
      </ExpandableWidget>
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Recent Sessions" })
    );
    const dialog = screen.getByRole("dialog");
    // The dialog still has an accessible name (focus-trap requirement)...
    expect(dialog).toHaveAccessibleName("Recent Sessions");
    // ...but the DialogHeader wrapper is visually hidden (sr-only), so the
    // content's own heading is the only visible one.
    const srTitle = within(dialog)
      .getAllByText("Recent Sessions")
      .find((el) => el.closest('[data-slot="dialog-header"]'));
    expect(srTitle?.closest('[data-slot="dialog-header"]')).toHaveClass(
      "sr-only"
    );
  });
});

describe("ExpandableWidget single-instance state continuity (FEA-3700)", () => {
  /**
   * A stateful widget standing in for a real chart/panel: it owns local control
   * state (a selected timeframe), reports how many times it has mounted and how
   * many times a subscription effect ran, and carries a stable element `id`.
   * If the widget is mounted twice (card + modal) or remounted on expand, the
   * mount/subscription counters climb and the local state resets.
   */
  function StatefulWidget({
    onMount,
    onSubscribe,
  }: {
    onMount: () => void;
    onSubscribe: () => void;
  }) {
    const [timeframe, setTimeframe] = useState("7d");
    const mounted = useRef(false);
    if (!mounted.current) {
      mounted.current = true;
      onMount();
    }
    useEffect(() => {
      // A durable subscription / data request that must not be duplicated.
      onSubscribe();
    }, [onSubscribe]);
    return (
      <div id="widget-panel">
        <span data-testid="timeframe">{timeframe}</span>
        <button onClick={() => setTimeframe("30d")} type="button">
          Set 30d
        </button>
      </div>
    );
  }

  it("keeps one mounted instance and preserves control state across expand → interact → collapse", async () => {
    const user = userEvent.setup();
    const onMount = vi.fn();
    const onSubscribe = vi.fn();

    render(
      <ExpandableWidget title="Model Usage">
        <StatefulWidget onMount={onMount} onSubscribe={onSubscribe} />
      </ExpandableWidget>
    );

    // The host is created synchronously (lazy useState initializer), so
    // `children` portal into it from the very FIRST render — there is no
    // inline-then-portal swap and no null→non-null host transition. The widget
    // subtree therefore mounts EXACTLY ONCE at initial load: one mount, one
    // subscription. (A regression to the old mount-effect host would show 2
    // here, because the inline render then remounts into the freshly-created
    // host.)
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onSubscribe).toHaveBeenCalledTimes(1);

    // Baseline for the expand/collapse cycle below. From here on, expand and
    // collapse must NOT remount or re-subscribe — that is the FEA-3700
    // guarantee — so these counts must stay pinned at 1.
    const mountsAtRest = onMount.mock.calls.length;
    const subsAtRest = onSubscribe.mock.calls.length;

    // Change a control in the collapsed card.
    await user.click(screen.getByRole("button", { name: "Set 30d" }));
    expect(screen.getByTestId("timeframe")).toHaveTextContent("30d");

    // Expand: the SAME instance relocates into the dialog — no remount, no
    // second subscription, and the changed control state carries over.
    await user.click(
      screen.getByRole("button", { name: "Expand Model Usage" })
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("timeframe")).toHaveTextContent("30d");
    expect(onMount).toHaveBeenCalledTimes(mountsAtRest);
    expect(onSubscribe).toHaveBeenCalledTimes(subsAtRest);

    // The panel lives only inside the dialog while expanded (single location).
    expect(within(dialog).getByTestId("timeframe")).toBeInTheDocument();
    expect(screen.getAllByTestId("timeframe")).toHaveLength(1);

    // Collapse back to the card via Escape.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Still one instance; state survives the round-trip back into the card, and
    // no expand/collapse in the cycle caused a remount or a new subscription.
    // The mount/subscription counts are STILL exactly 1 (they were pinned to 1
    // at initial load and `mountsAtRest`/`subsAtRest` captured that), proving
    // the child mounted exactly once across the entire initial-load →
    // expand → interact → collapse lifecycle.
    expect(screen.getByTestId("timeframe")).toHaveTextContent("30d");
    expect(mountsAtRest).toBe(1);
    expect(subsAtRest).toBe(1);
    expect(onMount).toHaveBeenCalledTimes(mountsAtRest);
    expect(onSubscribe).toHaveBeenCalledTimes(subsAtRest);
  });

  it("keeps the collapsed card side a plain block (no flex-1 stretch) so the overview grid is unchanged", () => {
    const noop = vi.fn();
    const { container } = render(
      <ExpandableWidget title="Model Usage">
        <StatefulWidget onMount={noop} onSubscribe={noop} />
      </ExpandableWidget>
    );

    // The outer wrapper and the in-card slot must NOT be flex columns — a
    // content-height card inside a `flex-1 min-h-0` column can stretch to fill a
    // grid row (the reshaping FEA-3700 must avoid). They stay plain blocks so
    // the card hugs its content exactly as it did before this change.
    const outerWrapper =
      container.querySelector<HTMLElement>(".group.relative");
    expect(outerWrapper).not.toBeNull();
    expect(outerWrapper).not.toHaveClass("flex");
    expect(outerWrapper).not.toHaveClass("flex-1");

    // The in-card slot is the wrapper's first element child (the trigger Button
    // is its second). It hosts the live widget instance and must also be a plain
    // block.
    const cardSlot = outerWrapper?.firstElementChild;
    expect(cardSlot).not.toBeNull();
    expect(cardSlot?.querySelector("#widget-panel")).not.toBeNull();
    expect(cardSlot).not.toHaveClass("flex");
    expect(cardSlot).not.toHaveClass("flex-1");

    // Crucially, the relocatable HOST node itself (the direct parent of the
    // widget) must ALSO be a plain block while in the card. `flex flex-col` is
    // NOT inert without a flex parent — it would make the host a flex CONTAINER,
    // turning the wrapped card from a block-flow child into a flex item and
    // perturbing h-full/stretch layout. So the host carries the flex utilities
    // only inside the dialog, never in the card.
    const host = container.querySelector("#widget-panel")?.parentElement;
    expect(host).not.toBeNull();
    expect(host).not.toHaveClass("flex");
    expect(host).not.toHaveClass("flex-col");
    expect(host).not.toHaveClass("flex-1");
  });

  it("makes the host a fill-the-dialog flex column only while expanded", async () => {
    const user = userEvent.setup();
    const noop = vi.fn();
    const { container } = render(
      <ExpandableWidget title="Model Usage">
        <StatefulWidget onMount={noop} onSubscribe={noop} />
      </ExpandableWidget>
    );

    // Collapsed: host is a plain block (asserted above), not a flex column.
    const collapsedHost =
      container.querySelector("#widget-panel")?.parentElement;
    expect(collapsedHost).not.toHaveClass("flex");

    // Expand: the SAME host node is relocated into the fixed-height dialog and
    // must switch to `flex flex-1 flex-col` so container-measured charts fill it.
    await user.click(
      screen.getByRole("button", { name: "Expand Model Usage" })
    );
    const dialog = screen.getByRole("dialog");
    const expandedHost = within(dialog)
      .getByTestId("timeframe")
      .closest("#widget-panel")?.parentElement;
    expect(expandedHost).not.toBeNull();
    expect(expandedHost).toHaveClass("flex", "flex-1", "flex-col", "min-h-0");

    // Collapse: the host reverts to a plain block so the card hugs its content
    // again and never leaks the dialog's flex-container class into the grid.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const revertedHost =
      container.querySelector("#widget-panel")?.parentElement;
    expect(revertedHost).not.toHaveClass("flex");
    expect(revertedHost).not.toHaveClass("flex-col");
    expect(revertedHost).not.toHaveClass("flex-1");
  });

  it("forwards contentClassName down the card-slot → host chain so a definite height reaches the wrapped content", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ExpandableWidget contentClassName="h-full" title="Model Usage">
        <div id="widget-panel">{WIDGET_TEXT}</div>
      </ExpandableWidget>
    );

    // The outer wrapper gets `className`, not `contentClassName`, so the height
    // intent is applied specifically to the in-card slot AND the relocatable
    // host — the two links that were previously plain `min-w-0` blocks with no
    // height, collapsing a card tile that needs `h-full` to fill its grid cell.
    const cardSlot =
      container.querySelector<HTMLElement>(
        ".group.relative"
      )?.firstElementChild;
    expect(cardSlot).toHaveClass("h-full");
    const host = container.querySelector("#widget-panel")?.parentElement;
    expect(host).toHaveClass("h-full");

    // The height persists on the host across an expand → collapse round-trip
    // (the dialog slot supplies its own fixed height, so the card class is
    // re-applied on the way back).
    await user.click(
      screen.getByRole("button", { name: "Expand Model Usage" })
    );
    await user.keyboard("{Escape}");
    const revertedHost =
      container.querySelector("#widget-panel")?.parentElement;
    expect(revertedHost).toHaveClass("h-full");
  });

  it("mounts the widget content exactly once — no duplicate element IDs while expanded", async () => {
    const user = userEvent.setup();
    const noop = vi.fn();

    const { container } = render(
      <ExpandableWidget title="Model Usage">
        <StatefulWidget onMount={noop} onSubscribe={noop} />
      </ExpandableWidget>
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Model Usage" })
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // The widget's stable id must appear exactly once in the whole document
    // (jsdom portals the dialog into document.body, so query the document root).
    const withId = container.ownerDocument.querySelectorAll("#widget-panel");
    expect(withId).toHaveLength(1);

    // And exactly one timeframe control, i.e. one live widget instance.
    expect(screen.getAllByTestId("timeframe")).toHaveLength(1);
  });
});

describe("DashboardCard expand affordance", () => {
  it("derives the expand control from the card title", () => {
    render(
      <DashboardCard title="Recent Sessions">
        <div>{WIDGET_TEXT}</div>
      </DashboardCard>
    );

    expect(
      screen.getByRole("button", { name: "Expand Recent Sessions" })
    ).toBeInTheDocument();
  });

  it("uses an explicit expandLabel for title-less cards", () => {
    render(
      <DashboardCard expandLabel="Event Activity">
        <div>{WIDGET_TEXT}</div>
      </DashboardCard>
    );

    expect(
      screen.getByRole("button", { name: "Expand Event Activity" })
    ).toBeInTheDocument();
  });
});

describe("DashboardCard content-owned title (FEA-4016)", () => {
  const CHART_HEADING = "Agent Collaboration Network";

  it("keeps the expanded modal heading sr-only when the chart content owns its title, so only one title is visible", async () => {
    const user = userEvent.setup();
    // An `expandLabel`-only chart card (no outer `title`) whose content draws its
    // own visible heading — the shape of the real Agent Collaboration / Model
    // Usage / Autonomy rows. Without `contentHasOwnTitle` the modal renders a
    // VISIBLE DialogTitle ("Agent Collaboration") stacked above the chart's own
    // "Agent Collaboration Network" heading (the FEA-4016 double title).
    render(
      <DashboardCard
        contentHasOwnTitle
        expandLabel="Agent Collaboration"
        fixedHeightClassName="h-[340px]"
      >
        <h2>{CHART_HEADING}</h2>
        <div>{WIDGET_TEXT}</div>
      </DashboardCard>
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Agent Collaboration" })
    );
    const dialog = screen.getByRole("dialog");

    // The dialog keeps its accessible name (focus-trap requirement) from the
    // sr-only DialogTitle...
    expect(dialog).toHaveAccessibleName("Agent Collaboration");
    // ...and that DialogTitle's header wrapper is visually hidden, so it is not a
    // second visible title.
    const srTitle = within(dialog)
      .getAllByText("Agent Collaboration")
      .find((el) => el.closest('[data-slot="dialog-header"]'));
    expect(srTitle?.closest('[data-slot="dialog-header"]')).toHaveClass(
      "sr-only"
    );

    // Exactly one VISIBLE title in the modal: the chart's own heading. The label
    // string ("Agent Collaboration") only appears inside the sr-only header, and
    // the chart heading ("Agent Collaboration Network") is the sole visible one.
    const visibleTitles = within(dialog)
      .getAllByRole("heading")
      .filter((el) => !el.closest(".sr-only"));
    expect(visibleTitles).toHaveLength(1);
    expect(visibleTitles[0]).toHaveTextContent(CHART_HEADING);
  });

  it("still shows a visible modal DialogTitle for a plain content widget (no contentHasOwnTitle)", async () => {
    const user = userEvent.setup();
    render(
      <DashboardCard expandLabel="Event Activity">
        <div>{WIDGET_TEXT}</div>
      </DashboardCard>
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Event Activity" })
    );
    const dialog = screen.getByRole("dialog");

    // With no content-owned title, the modal DialogTitle stays VISIBLE (its
    // header wrapper is not sr-only) — the label is the widget's only heading.
    const title = within(dialog)
      .getAllByText("Event Activity")
      .find((el) => el.closest('[data-slot="dialog-header"]'));
    expect(title?.closest('[data-slot="dialog-header"]')).not.toHaveClass(
      "sr-only"
    );
  });

  it("reserves the close-button gutter on the expanded content when the header is sr-only", async () => {
    const user = userEvent.setup();
    // With the DialogHeader hidden, a content-owned top-right control (e.g. Event
    // Activity's filter toggle) rides to the corner where the Dialog's close X
    // sits. The expanded slot reserves that gutter (pr-8) only on the sr-only
    // path so the two can't graze (FEA-4016).
    render(
      <DashboardCard contentHasOwnTitle expandLabel="Event Activity">
        <h2>Event Activity</h2>
        <div>{WIDGET_TEXT}</div>
      </DashboardCard>
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Event Activity" })
    );
    const dialog = screen.getByRole("dialog");
    const expandedSlot = within(dialog)
      .getByText(WIDGET_TEXT)
      .closest(".overflow-auto");
    expect(expandedSlot).toHaveClass("pr-8");
  });

  it("does not reserve the gutter when the modal header stays visible", async () => {
    const user = userEvent.setup();
    render(
      <DashboardCard expandLabel="Event Activity">
        <div>{WIDGET_TEXT}</div>
      </DashboardCard>
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Event Activity" })
    );
    const dialog = screen.getByRole("dialog");
    const expandedSlot = within(dialog)
      .getByText(WIDGET_TEXT)
      .closest(".overflow-auto");
    // A visible DialogHeader already pushes content clear of the close button, so
    // no extra gutter is applied.
    expect(expandedSlot).not.toHaveClass("pr-8");
  });
});

describe("DashboardCard fixed-height chart cards fill when expanded (FEA-3944)", () => {
  it("keeps the compact fixed band on the collapsed grid card", () => {
    const { container } = render(
      <DashboardCard expandLabel="Model Usage" fixedHeightClassName="h-[340px]">
        <div id="chart-body">{WIDGET_TEXT}</div>
      </DashboardCard>
    );

    // Collapsed (grid): the compact band rides on the CardContent, so the card
    // reads exactly as before — no fill stretch, no density change.
    const cardContent = container.querySelector<HTMLElement>(
      '[data-slot="card-content"]'
    );
    expect(cardContent).not.toBeNull();
    expect(cardContent).toHaveClass("h-[340px]");
    expect(cardContent).not.toHaveClass("flex-1");

    // The collapsed card is a natural block (the design-system Card is a flex
    // column by default, but it is NOT forced to fill height in the grid).
    const card = container.querySelector<HTMLElement>('[data-slot="card"]');
    expect(card).not.toHaveClass("h-full");

    // The expand affordance is present and derived from the label.
    expect(
      screen.getByRole("button", { name: "Expand Model Usage" })
    ).toBeInTheDocument();
  });

  it("relocates the fill card into the dialog so the chart body grows to full height", async () => {
    const user = userEvent.setup();
    render(
      <DashboardCard
        expandLabel="Agent Collaboration"
        fixedHeightClassName="h-[340px]"
      >
        <div id="chart-body">{WIDGET_TEXT}</div>
      </DashboardCard>
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Agent Collaboration" })
    );

    const dialog = screen.getByRole("dialog");
    // Expanded: the single card instance is relocated into the dialog; the fixed
    // band is dropped and the Card/CardContent switch to the fill layout so the
    // chart grows to the modal height instead of sitting in a 340px band.
    const card = within(dialog)
      .getByText(WIDGET_TEXT)
      .closest('[data-slot="card"]');
    expect(card).toHaveClass("flex", "h-full", "flex-col");
    const cardContent = card?.querySelector('[data-slot="card-content"]');
    expect(cardContent).toHaveClass("min-h-0", "flex-1");
    expect(cardContent).not.toHaveClass("h-[340px]");

    // The relocatable host (the Card's parent) is the fill flex column.
    const host = card?.parentElement;
    expect(host).toHaveClass("flex", "flex-1", "min-h-0");
  });

  it("leaves body-sized cards (no fixed band) at their natural content height", () => {
    const { container } = render(
      <DashboardCard contentClassName="p-2" title="Recent Sessions">
        <div>{WIDGET_TEXT}</div>
      </DashboardCard>
    );

    // Without a fixed band the card is NOT forced to fill: it keeps its prior
    // content-height block layout (no `h-full` stretch). The design-system Card
    // is always a flex column, so only the fill-specific `h-full` is asserted.
    const card = container.querySelector<HTMLElement>('[data-slot="card"]');
    expect(card).not.toHaveClass("h-full");
    const cardContent = container.querySelector<HTMLElement>(
      '[data-slot="card-content"]'
    );
    expect(cardContent).not.toHaveClass("flex-1");
  });
});

describe("ExpandableWidget dismisses frozen tooltips on expand/collapse (FEA-3944)", () => {
  // A hover tooltip like the Recent Sessions "2" repo-count chip. `delayDuration
  // ={0}` makes the hover open instant/deterministic in tests (the default 700ms
  // Radix delay); hover — not focus — is the frozen-tooltip case, since clicking
  // Expand blurs a focused trigger (auto-closing it) but never fires pointerleave
  // on a hovered one, so only the explicit dismiss closes it.
  // A leading focusable element stands in for the surrounding table chrome (rows,
  // links) so the Dialog's autofocus lands there, not on the hovered chip —
  // mirroring the real Recent Sessions panel, where the chip is never the first
  // focusable. Otherwise autofocus would immediately re-open the chip as a focus
  // tooltip, which is standard focus behavior and unrelated to the frozen-hover
  // bug under test.
  function RepoChip() {
    return (
      <div>
        <button type="button">Row action</button>
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <button type="button">2</button>
          </TooltipTrigger>
          <TooltipContent>{REPO_TOOLTIP_TEXT}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  // The visible Radix tooltip content carries `data-state`
  // (open → "instant-open"/"delayed-open", dismissed → "closed"). Asserting the
  // state transition is the behavioral contract: in jsdom the exit-animated node
  // lingers (no animationend), so a presence check would false-fail even though
  // the tooltip is dismissed — the state flips to "closed" either way.
  function openTooltipStates(): string[] {
    return Array.from(
      document.querySelectorAll('[data-slot="tooltip-content"]')
    )
      .map((el) => el.getAttribute("data-state"))
      .filter((state): state is string => state !== null && state !== "closed");
  }

  it("closes a hover tooltip that was open at the moment of expand", async () => {
    const user = userEvent.setup();
    render(
      <DashboardCard title="Recent Sessions">
        <RepoChip />
      </DashboardCard>
    );

    // Open the "2" repo-count chip tooltip by hovering it.
    await user.hover(screen.getByRole("button", { name: "2" }));
    expect(
      (await screen.findAllByText(REPO_TOOLTIP_TEXT)).length
    ).toBeGreaterThan(0);
    expect(openTooltipStates().length).toBeGreaterThan(0);

    // Expand the widget — a hover tooltip open here previously froze because the
    // relocated trigger's DOM node never fires pointerleave. The fix dismisses it
    // on the expand toggle, flipping the tooltip to its closed state.
    await user.click(
      screen.getByRole("button", { name: "Expand Recent Sessions" })
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(openTooltipStates()).toHaveLength(0);
  });

  it("closes a hover tooltip open in the modal when the widget is collapsed", async () => {
    const user = userEvent.setup();
    render(
      <DashboardCard title="Recent Sessions">
        <RepoChip />
      </DashboardCard>
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Recent Sessions" })
    );
    const dialog = screen.getByRole("dialog");

    // Open the tooltip inside the expanded modal, then collapse via the close
    // button; the tooltip must not survive the collapse transition.
    await user.hover(within(dialog).getByRole("button", { name: "2" }));
    expect(
      (await screen.findAllByText(REPO_TOOLTIP_TEXT)).length
    ).toBeGreaterThan(0);
    expect(openTooltipStates().length).toBeGreaterThan(0);

    await user.click(
      screen.getByRole("button", { name: CLOSE_BUTTON_NAME_REGEX })
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(openTooltipStates()).toHaveLength(0);
  });
});

describe("ExpandableWidget resets the Graph tooltip/highlight on expand/collapse (FEA-3944)", () => {
  // The Agent Collaboration graph owns a bespoke fixed-position tooltip + hover
  // highlight that Radix's tooltip-dismiss signal never reaches, and that also
  // freezes on the keyboard path (hover a node, Tab to Expand, press Enter — no
  // pointerleave). ExpandableWidget resets it by dispatching GRAPH_RESET_EVENT,
  // which every mounted Graph listens for. Assert that signal fires on the
  // open/close toggle — the observable contract at this boundary.
  function countGraphResets(run: () => Promise<void>): Promise<number> {
    let resets = 0;
    const listener = () => {
      resets += 1;
    };
    document.addEventListener(GRAPH_RESET_EVENT, listener);
    return run()
      .then(() => resets)
      .finally(() => {
        document.removeEventListener(GRAPH_RESET_EVENT, listener);
      });
  }

  it("dispatches a graph reset when expanding", async () => {
    const user = userEvent.setup();
    render(
      <DashboardCard title="Agent Collaboration">{WIDGET_TEXT}</DashboardCard>
    );

    const resets = await countGraphResets(async () => {
      await user.click(
        screen.getByRole("button", { name: "Expand Agent Collaboration" })
      );
    });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(resets).toBeGreaterThan(0);
  });

  it("dispatches a graph reset when collapsing", async () => {
    const user = userEvent.setup();
    render(
      <DashboardCard title="Agent Collaboration">{WIDGET_TEXT}</DashboardCard>
    );
    await user.click(
      screen.getByRole("button", { name: "Expand Agent Collaboration" })
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const resets = await countGraphResets(async () => {
      await user.click(
        screen.getByRole("button", { name: CLOSE_BUTTON_NAME_REGEX })
      );
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(resets).toBeGreaterThan(0);
  });
});
