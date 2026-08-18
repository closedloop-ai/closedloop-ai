/**
 * ISS-5301: the first-launch tour's three render modes and its exit paths.
 *
 * `tour.test.tsx` next door owns the ISS-5112 completion-label contract; this
 * suite covers the rest of the component's behavior, which is where the states
 * a user can actually get stuck live:
 *
 *  - the intro summary card (rows, chips, optional value/sub) vs a spotlight
 *    step docked to an anchor,
 *  - a spotlight step whose anchor is NOT on screen, which must fall back to a
 *    full-dim scrim rather than unmounting the tour out from under the user,
 *  - the skip paths, including the one where the fly-into-button animation has
 *    no button to fly into and has to close immediately,
 *  - and step navigation, since Back must not be offered on the first step.
 *
 * Every exit asserts `onClose` and its reason: the host writes the tour-seen
 * flag from that callback, so a tour that closes without firing it strands the
 * user in a state that replays forever.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tour, type TourStep } from "../tour";

/** The fly-into-button animation's settle delay before `onClose` fires. */
const SKIP_ANIMATION_MS = 460;

const BACK_BUTTON = /Back/;
const NEXT_BUTTON = /Next/;

const INTRO_STEP: TourStep = {
  intro: true,
  eyebrow: "Ready",
  title: "Build and see how your agents perform",
  body: "Intro body.",
  summary: [
    {
      icon: <span data-testid="row-icon" />,
      label: "Sessions",
      value: "128",
      sub: "Imported from your local harness history.",
      chips: [
        { label: "claude", ok: true },
        { label: "~/code/app", mono: true },
        { label: "no repo", muted: true },
      ],
    },
    { icon: <span />, label: "Repositories" },
  ],
};

const SPOTLIGHT_STEP: TourStep = {
  sel: "prs",
  eyebrow: "Throughput",
  title: "Shipping velocity",
  body: "Spotlight body.",
};

/** A spotlight step with no eyebrow, so the `Step N` fallback renders. */
const UNLABELLED_STEP: TourStep = {
  sel: "cost",
  title: "Spend",
  body: "Cost body.",
};

/**
 * The tour renders TWO controls whose accessible name is "Skip tour": the
 * full-viewport click blocker (`aria-label`) first, then the text button in the
 * callout footer. Address them positionally so neither test is ambiguous.
 */
const SKIP_BLOCKER = 0;
const SKIP_TEXT_BUTTON = 1;

function skipControl(which: number): HTMLElement {
  return screen.getAllByRole("button", { name: "Skip tour" })[
    which
  ] as HTMLElement;
}

/** Nodes appended straight to the document, torn down in `afterEach`. */
const mountedNodes: HTMLElement[] = [];

/** Mount an anchor the spotlight can measure, inside a scrollable parent. */
function mountAnchor(sel: string): HTMLElement {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  const anchor = document.createElement("div");
  anchor.setAttribute("data-tour", sel);
  scroller.append(anchor);
  document.body.append(scroller);
  mountedNodes.push(scroller);
  return anchor;
}

/** Mount the element `startSkip` animates the callout into. */
function mountSkipTargetButton(): HTMLElement {
  const button = document.createElement("button");
  button.setAttribute("data-tour-btn", "");
  document.body.append(button);
  mountedNodes.push(button);
  return button;
}

const originalScrollToDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollTo"
);

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom does not implement it; the spotlight measure path calls it.
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalScrollToDescriptor) {
    Object.defineProperty(
      Element.prototype,
      "scrollTo",
      originalScrollToDescriptor
    );
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollTo");
  }
  for (const node of mountedNodes.splice(0)) {
    node.remove();
  }
});

describe("Tour — activation", () => {
  it("renders nothing while inactive", () => {
    const { container } = render(
      <Tour
        active={false}
        onClose={vi.fn()}
        steps={[INTRO_STEP, SPOTLIGHT_STEP]}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the frozen step set is empty", () => {
    const { container } = render(<Tour active onClose={vi.fn()} steps={[]} />);

    expect(container.firstChild).toBeNull();
  });
});

describe("Tour — the intro summary card", () => {
  it("renders the eyebrow, copy, and one row per summary entry", () => {
    render(
      <Tour active onClose={vi.fn()} steps={[INTRO_STEP, SPOTLIGHT_STEP]} />
    );

    expect(screen.getByText("Ready")).toBeTruthy();
    expect(
      screen.getByText("Build and see how your agents perform")
    ).toBeTruthy();
    expect(screen.getByText("Intro body.")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("Repositories")).toBeTruthy();
  });

  it("renders a row's optional value, sub-line, and chips", () => {
    render(
      <Tour active onClose={vi.fn()} steps={[INTRO_STEP, SPOTLIGHT_STEP]} />
    );

    expect(screen.getByText("128")).toBeTruthy();
    expect(
      screen.getByText("Imported from your local harness history.")
    ).toBeTruthy();
    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.getByText("~/code/app")).toBeTruthy();
    expect(screen.getByText("no repo")).toBeTruthy();
  });

  it("exposes the card as a labelled modal dialog", () => {
    render(
      <Tour active onClose={vi.fn()} steps={[INTRO_STEP, SPOTLIGHT_STEP]} />
    );

    const dialog = screen.getByRole("dialog", {
      name: "Build and see how your agents perform",
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });
});

describe("Tour — spotlight steps", () => {
  it("uses the step's own eyebrow when it has one", () => {
    render(<Tour active onClose={vi.fn()} steps={[SPOTLIGHT_STEP]} />);

    expect(screen.getByText("Throughput")).toBeTruthy();
  });

  it("falls back to a positional label when the step has no eyebrow", () => {
    render(<Tour active onClose={vi.fn()} steps={[UNLABELLED_STEP]} />);

    expect(screen.getByText("Step 1")).toBeTruthy();
  });

  it("scrolls a measurable anchor into view and keeps the callout readable", () => {
    mountAnchor("prs");

    render(<Tour active onClose={vi.fn()} steps={[SPOTLIGHT_STEP]} />);

    expect(Element.prototype.scrollTo).toHaveBeenCalled();
    expect(screen.getByText("Shipping velocity")).toBeTruthy();
  });

  it("still shows the step when its anchor is not on screen", () => {
    // No `[data-tour="prs"]` in the document: the tour must fall back to the
    // dimmed scrim + docked callout rather than vanishing mid-run.
    render(<Tour active onClose={vi.fn()} steps={[SPOTLIGHT_STEP]} />);

    expect(screen.getByText("Shipping velocity")).toBeTruthy();
    expect(screen.getByText("Spotlight body.")).toBeTruthy();
  });
});

describe("Tour — stepping through", () => {
  it("offers no Back on the first step", () => {
    render(
      <Tour active onClose={vi.fn()} steps={[INTRO_STEP, SPOTLIGHT_STEP]} />
    );

    expect(screen.queryByRole("button", { name: BACK_BUTTON })).toBeNull();
  });

  it("advances to the next step and back again", () => {
    render(
      <Tour active onClose={vi.fn()} steps={[INTRO_STEP, SPOTLIGHT_STEP]} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Take a quick tour" }));
    expect(screen.getByText("Shipping velocity")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: BACK_BUTTON }));
    expect(
      screen.getByText("Build and see how your agents perform")
    ).toBeTruthy();
  });

  it("shows Next on a middle step and completes from the last one", () => {
    const onClose = vi.fn();
    render(
      <Tour
        active
        onClose={onClose}
        steps={[INTRO_STEP, SPOTLIGHT_STEP, UNLABELLED_STEP]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Take a quick tour" }));
    fireEvent.click(screen.getByRole("button", { name: NEXT_BUTTON }));
    expect(screen.getByText("Spend")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledWith("done");
  });
});

describe("Tour — skipping", () => {
  it("closes immediately when there is no button to animate into", () => {
    const onClose = vi.fn();
    render(
      <Tour active onClose={onClose} steps={[INTRO_STEP, SPOTLIGHT_STEP]} />
    );

    fireEvent.click(skipControl(SKIP_TEXT_BUTTON));

    expect(onClose).toHaveBeenCalledWith("skip");
  });

  it("waits for the fly-into-button animation before closing", () => {
    mountSkipTargetButton();
    const onClose = vi.fn();
    render(
      <Tour active onClose={onClose} steps={[INTRO_STEP, SPOTLIGHT_STEP]} />
    );

    fireEvent.click(skipControl(SKIP_TEXT_BUTTON));
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(SKIP_ANIMATION_MS);
    });

    expect(onClose).toHaveBeenCalledWith("skip");
  });

  it("ignores a second skip while the animation is already running", () => {
    mountSkipTargetButton();
    const onClose = vi.fn();
    render(
      <Tour active onClose={onClose} steps={[INTRO_STEP, SPOTLIGHT_STEP]} />
    );

    fireEvent.click(skipControl(SKIP_TEXT_BUTTON));
    fireEvent.click(skipControl(SKIP_TEXT_BUTTON));
    act(() => {
      vi.advanceTimersByTime(SKIP_ANIMATION_MS);
    });

    // One armed animation, so one close — not two.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("skips when the dimmed area behind the callout is clicked", () => {
    const onClose = vi.fn();
    render(
      <Tour active onClose={onClose} steps={[INTRO_STEP, SPOTLIGHT_STEP]} />
    );

    fireEvent.click(skipControl(SKIP_BLOCKER));

    expect(onClose).toHaveBeenCalledWith("skip");
  });

  it("dismisses on Escape from inside the callout", () => {
    const onClose = vi.fn();
    render(
      <Tour active onClose={onClose} steps={[INTRO_STEP, SPOTLIGHT_STEP]} />
    );

    fireEvent.keyDown(
      screen.getByRole("dialog", {
        name: "Build and see how your agents perform",
      }),
      { key: "Escape" }
    );

    expect(onClose).toHaveBeenCalledWith("skip");
  });

  it("leaves other keys alone", () => {
    const onClose = vi.fn();
    render(
      <Tour active onClose={onClose} steps={[INTRO_STEP, SPOTLIGHT_STEP]} />
    );

    fireEvent.keyDown(
      screen.getByRole("dialog", {
        name: "Build and see how your agents perform",
      }),
      { key: "Enter" }
    );

    expect(onClose).not.toHaveBeenCalled();
  });
});
