// @vitest-environment jsdom

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_SESSION_DISCOVERY } from "../../lib/guided-onboarding-fixtures";
import { OnboardingAnalysisProgressStatus } from "../guided-onboarding-data";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

const ACCOUNT_HEADING =
  "Learn what's working and share what you learn with your team.";
const SYNC_HEADING = "Choose what to sync";
const CREATE_ORGANIZATION_HEADING = "You're the first one here!";
const RESTORING_HEADING = "Restoring your setup";
const ANALYSIS_STARTED_HEADING = "Session analysis started.";
const ANALYSIS_COMPLETE_HEADING = "Session analysis complete.";

/**
 * ISS-8345 / PLN-1878 step 5: focus movement ACROSS a phase change.
 *
 * Radix's focus trap is not what these cover — it is not in question and needs
 * no test here. What was untested is where focus goes INSIDE that trap when the
 * phase swaps the body out from under it: before this change nothing moved it,
 * so the control the reader was on was unmounted and focus fell to
 * `document.body`, stranding a keyboard or screen reader user in a dialog with
 * every dismissal path prevented (WCAG 2.4.3 Focus Order).
 *
 * ISS-11315 CHANGED WHAT THESE PIN, and the expectation moved for a stated
 * reason rather than because a case was inconvenient. The operator reported the
 * step heading wearing a focus ring on a fresh install and ruled that it must
 * not take focus or show a border on any arrival. The heading was the landing
 * point, so it is no longer focusable at all (`GuidedOnboardingPhaseHeading` no
 * longer carries `tabIndex={-1}`) and the two jobs it was doing are now split:
 * the dialog CONTENT element takes focus, which is what keeps 2.4.3, and a
 * polite live region carries the step's own heading text, which is what keeps
 * the announcement. Every case below therefore asserts the announcement too —
 * deleting the ring must not quietly delete the thing it was a side effect of.
 */
describe("GuidedOnboardingDialog focus across a phase change", () => {
  it("announces the new phase and lands focus on the card, never the heading", () => {
    const { rerender } = render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.Account}
      />
    );

    expect(
      screen.getByRole("heading", { name: ACCOUNT_HEADING })
    ).not.toHaveFocus();

    rerender(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.SyncPolicy}
      />
    );

    // The heading is not a focus target and cannot be one: without a tabindex
    // it is not programmatically focusable, so no `:focus` or `:focus-visible`
    // heuristic can paint a ring on it for a mouse user who never touched it.
    const heading = screen.getByRole("heading", { name: SYNC_HEADING });
    expect(heading).not.toHaveFocus();
    expect(heading).not.toHaveAttribute("tabindex");

    // The reader still lands inside the card they are not allowed to dismiss.
    expect(dialogContent()).toHaveFocus();
    // And the step change is still spoken — the capability the heading focus
    // existed for, now carried by the live region.
    expect(announcement()).toBe(SYNC_HEADING);
  });

  it("leaves focus alone on a re-render that is not an arrival", () => {
    const { rerender } = render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.CreateOrganization}
      />
    );

    const name = screen.getByLabelText("Name");
    // The mount commit moves nothing, so the field this phase autofocuses still
    // holds focus before the test touches it. Asserted before the explicit
    // `focus()` below, or that call would supply the state it is meant to pin.
    expect(name).toHaveFocus();
    name.focus();

    // A prop change inside the SAME phase is not an arrival anywhere. Only the
    // body the reader is looking at may move focus, or every keystroke that
    // re-renders the host drags the reader back out of the field they are in.
    rerender(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        organizationName="Acme"
        phase={OnboardingPhase.CreateOrganization}
      />
    );

    expect(name).toHaveFocus();
    expect(
      screen.getByRole("heading", { name: CREATE_ORGANIZATION_HEADING })
    ).not.toHaveFocus();
    expect(dialogContent()).not.toHaveFocus();
  });

  it("moves focus to the card when the restoring screen gives way to its phase", () => {
    const { rerender } = render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.SyncPolicy}
        restoring
      />
    );

    expect(screen.queryByRole("heading", { name: SYNC_HEADING })).toBeNull();

    // `phase` never changed — only the restoring override lifted. Keying the
    // focus move on `phase` alone would spend the move while the reader was
    // still on the restoring screen and leave the real arrival silent.
    rerender(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.SyncPolicy}
      />
    );

    expect(
      screen.getByRole("heading", { name: SYNC_HEADING })
    ).not.toHaveFocus();
    expect(dialogContent()).toHaveFocus();
    expect(announcement()).toBe(SYNC_HEADING);
  });

  it("leaves the arriving phase's autofocused field alone", () => {
    // The shape every host produces: `restoring` is derived from a passive
    // effect, so the dialog's first commit is ALWAYS the restoring body and
    // arriving at a phase is a body CHANGE, not a mount. The mount no-op is
    // spent on the restoring screen and protects nothing here.
    const { rerender } = render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.CreateOrganization}
        restoring
      />
    );

    rerender(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.CreateOrganization}
      />
    );

    // A control in the arriving body claimed focus for itself. Landing on the
    // heading here would not be a rescue — it would take the field away from a
    // reader who opened the wizard to type.
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(
      screen.getByRole("heading", { name: CREATE_ORGANIZATION_HEADING })
    ).not.toHaveFocus();
    expect(dialogContent()).not.toHaveFocus();
    // The arrival is still ANNOUNCED even though no focus moved. This is the
    // case that separates the live region from the focus move: the old
    // implementation stayed silent here, because its only way to speak was to
    // take focus, and taking it would have pulled the reader out of the field.
    expect(announcement()).toBe(CREATE_ORGANIZATION_HEADING);
  });

  it("announces the restoring screen and holds focus when it takes over", () => {
    const { rerender } = render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.SyncPolicy}
      />
    );

    // The restoring body is an arrival the shell names for itself, so it is
    // announced and holds focus like every phase does. Without that the reader
    // is stranded on `document.body` inside a dialog with every dismissal path
    // prevented, and nothing says the screen changed.
    rerender(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.SyncPolicy}
        restoring
      />
    );

    const heading = screen.getByRole("heading", { name: RESTORING_HEADING });
    expect(heading).not.toHaveFocus();
    expect(heading).not.toHaveAttribute("tabindex");
    expect(dialogContent()).toHaveFocus();
    expect(announcement()).toBe(RESTORING_HEADING);
  });

  it("speaks nothing on the commit that closes the dialog", () => {
    const openDialog = render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.SyncPolicy}
      />
    );

    // The control, and the reason the silence below means anything: the same
    // body change with the dialog still OPEN is an arrival, and does announce.
    openDialog.rerender(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.SyncPolicy}
        restoring
      />
    );
    expect(announcement()).toBe(RESTORING_HEADING);
    openDialog.unmount();

    const closingDialog = render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.SyncPolicy}
      />
    );

    // A host whose teardown turns `restoring` back on as it closes. Radix holds
    // the content mounted through the exit animation, so the heading IS there
    // to be found on this commit — and announcing it would make "Restoring your
    // setup" the last thing a screen reader says after the wizard is done.
    const whileClosing = recordFocusMoves();
    closingDialog.rerender(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open={false}
        phase={OnboardingPhase.SyncPolicy}
        restoring
      />
    );
    whileClosing.stop();

    // The focus move is what this case can pin, and only that: jsdom reports no
    // exit animation, so Radix unmounts the content — live region included — in
    // this same commit, and there is no region left to read an announcement off.
    // The effect's `open` guard covers both side effects in one early return,
    // and the open control above is what proves the commit was an arrival.
    expect(whileClosing.moves).toEqual([]);
  });

  it("keeps Tab inside the blocking card", () => {
    // The other half of ISS-11149 row 5: the trap is inherited from Radix and was
    // untested here, which matters more on this dialog than on any other — every
    // dismissal path is prevented, so focus escaping it strands the reader on a
    // page they cannot interact with and cannot get back from.
    const outside = document.createElement("button");
    outside.textContent = "Outside the modal";
    document.body.append(outside);

    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.Account}
      />
    );

    const dialog = screen.getByRole("dialog");
    const tabbable = tabbableInside(dialog);
    // Positive control: there is something to tab THROUGH, so the wrap below is
    // not satisfied by an empty card.
    expect(tabbable.length).toBeGreaterThan(1);

    tabbable.at(-1)?.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });

    // The WRAP, not merely "focus did not leave": jsdom performs no native
    // tabbing, so asserting that focus stayed inside would hold just as well
    // with the trap switched off and nothing moving at all.
    expect(document.activeElement).toBe(tabbable[0]);
    expect(outside).not.toHaveFocus();
  });
});

/**
 * THE IN-PLACE HEADING CHANGE, which is the only reason the announcement is not
 * keyed on an arrival (ISS-11315 review, whitlockk).
 *
 * Every other case in this file swaps the PHASE, so an arrival-keyed dependency
 * list satisfies them all — put `[body]` back on that effect and they stay
 * green. This one does not move the phase at all: `SessionDiscovery` stays
 * mounted while `getAnalysisTitle` walks its own heading from "started" to
 * "complete" on the progress operand alone. Reverting the effect to an
 * arrival-only list holds the first sentence here, so a reader hears the scan
 * begin and never hears it finish while the card in front of them says
 * otherwise.
 *
 * The first assertion is the fixture control: without it a case that never
 * announced anything would pass the second one the moment the heading happened
 * to match.
 */
describe("GuidedOnboardingDialog announcement within one phase", () => {
  it("re-announces when the analysis heading changes with the phase held", () => {
    // Built per commit rather than reused: React bails out of re-rendering a
    // referentially IDENTICAL element, so a rerender that passes the same node
    // back never commits and the effect below never runs.
    const atPercent = (percent: number) => (
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        discovery={FIXTURE_SESSION_DISCOVERY}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.SessionDiscovery}
        progress={{
          percent,
          status: OnboardingAnalysisProgressStatus.Measured,
        }}
      />
    );

    const { rerender } = render(atPercent(40));
    // Radix's `Portal` renders null until its own layout effect flips an
    // internal `mounted` flag, so the OPENING commit has no content element for
    // `contentRef` and the announcement effect finds no heading to read. Every
    // sibling case above gets past that for free because its first assertion
    // already follows a rerender; this one holds the phase still, so it names
    // the settling commit rather than borrowing one.
    rerender(atPercent(40.5));

    expect(
      screen.getByRole("heading", { name: ANALYSIS_STARTED_HEADING })
    ).toBeInTheDocument();
    expect(announcement()).toBe(ANALYSIS_STARTED_HEADING);

    rerender(atPercent(100));

    expect(
      screen.getByRole("heading", { name: ANALYSIS_COMPLETE_HEADING })
    ).toBeInTheDocument();
    expect(announcement()).toBe(ANALYSIS_COMPLETE_HEADING);
  });
});

/**
 * What the dialog's polite live region currently says — the step announcement,
 * read the way assistive technology gets it rather than from component state.
 */
function announcement(): string {
  const region = document.querySelector<HTMLElement>(
    '[data-slot="guided-onboarding-announcement"]'
  );
  if (!region) {
    throw new Error("the dialog renders no announcement region");
  }
  return region.textContent ?? "";
}

/** The dialog card itself: the programmatic landing point for a step change. */
function dialogContent(): HTMLElement {
  return screen.getByRole("dialog");
}

/** Everything the reader can reach with Tab inside `root`, in document order. */
function tabbableInside(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ),
  ];
}

/**
 * The focus MOVES this effect makes, as events rather than as a final
 * `document.activeElement`.
 *
 * `toHaveFocus` cannot see a move made INSIDE the closing commit. A browser keeps
 * `DialogContent` mounted through its exit animation, but jsdom reports no
 * animation, so Radix's presence layer unmounts the content in that same commit
 * and `activeElement` collapses whether or not the heading was focused first.
 * The `focusin` is the move itself — what a screen reader announces — and it
 * survives the node being removed a moment later.
 *
 * That is about the body swap. Where focus ends up once the dialog is GONE is
 * still unasserted here, and deliberately: Radix's modal restore focuses a
 * `DialogTrigger`, this dialog is host-driven and renders none, so focus resets
 * to the document body rather than to whatever held it before the takeover.
 * Nothing in this repo can change that outcome without changing the dialog's
 * behaviour, which ISS-11149 (a proof-only ticket) does not do — the finding is
 * on that ticket for ISS-8383 to rule on. The last case covers the Tab trap,
 * which WAS unpinned (ISS-11149 row 5).
 */
function recordFocusMoves() {
  const moves: string[] = [];
  const record = (event: Event) => {
    moves.push(
      event.target instanceof HTMLElement
        ? (event.target.textContent ?? "")
        : ""
    );
  };
  document.addEventListener("focusin", record);
  return {
    moves,
    stop: () => document.removeEventListener("focusin", record),
  };
}
