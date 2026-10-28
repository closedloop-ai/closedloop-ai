// @vitest-environment jsdom

/**
 * ISS-11149 row 1: the blocking modal's dismissal lock, falsifiably.
 *
 * PRD-689: "The blocking modal cannot be dismissed by Escape or outside
 * interaction. It closes only through a defined transition to the Dashboard."
 *
 * The lock is doubly held, and the two halves are observable in different ways.
 * The STRUCTURAL half — `<Dialog open={open}>` with no `onOpenChange` — means
 * Radix's dismissal ends in an undefined callback, so `guided-onboarding-dialog
 * .test.tsx`'s Escape case survives the three prevention handlers being deleted
 * and pins only the conjunction of both halves. This suite pins the HANDLERS on
 * their own, by capturing the event Radix asks them about and reading back
 * whether it was refused.
 *
 * The close button is pinned beside them, which `guided-onboarding-dialog
 * .test.tsx` asserts nowhere despite "locked dismissal" in its name.
 *
 * `onEscapeKeyDown` has no such observable and is deliberately not pinned here:
 * when it is absent Radix calls `event.preventDefault()` itself before
 * dismissing (`react-dismissable-layer`), so the native keydown reads the same
 * either way, and the dismissal it then attempts is the no-op above. It is
 * redundant defence for as long as the dialog stays fully controlled; the two
 * handlers below are not, because Radix never refuses their events for them.
 */

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";
import type { GuidedOnboardingDialogProps } from "../guided-onboarding-types";

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

const DIALOG_CLOSE = '[data-slot="dialog-close"]';
const POINTER_DOWN_OUTSIDE = "dismissableLayer.pointerDownOutside";

// Unconditional, not the last line of the one case that installs them: a throw
// between install and restore would leave every later case on a frozen clock.
afterEach(() => {
  vi.useRealTimers();
});

describe("guided onboarding dialog, dismissal lock", () => {
  it("refuses the pointer-down-outside dismissal Radix offers it", () => {
    vi.useFakeTimers();
    const outside = mountOutsideTarget();
    const captured = captureDismissalRequest(outside, POINTER_DOWN_OUTSIDE);
    renderDialog();

    // Radix arms its document listener in a timeout, so the interaction has to
    // happen after that has run or no dismissal is offered at all.
    act(() => {
      vi.runOnlyPendingTimers();
    });
    fireEvent.pointerDown(outside);

    expect(captured.event, "Radix offered no outside dismissal").not.toBeNull();
    // `onInteractOutside` and `onPointerDownOutside` are a redundant pair on
    // this path — Radix offers the same event to both — so this refusal is
    // their conjunction, and removing either alone leaves the other holding it.
    expect(captured.event?.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("renders no close affordance on the blocking card", () => {
    renderDialog();

    expect(document.querySelector(DIALOG_CLOSE)).toBeNull();
  });

  it("renders a close affordance on a dialog that allows one", () => {
    // Paired positive control for the case above: the same selector against a
    // dialog that keeps its close button, so a locator that matches nothing
    // cannot pass for a lock.
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Dismissable</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    expect(document.querySelector(DIALOG_CLOSE)).not.toBeNull();
  });
});

/**
 * The event Radix dispatches to ask a layer whether it may dismiss, read AFTER
 * the interaction so the production handler's refusal is already on it.
 *
 * Radix dispatches on the interaction's own target and attaches its handler at
 * dispatch time, so a listener registered here runs FIRST — before any
 * `preventDefault` — which is why the event object is kept rather than inspected
 * in place.
 */
function captureDismissalRequest(
  target: HTMLElement,
  eventName: string
): { event: Event | null } {
  const captured: { event: Event | null } = { event: null };
  target.addEventListener(eventName, (event) => {
    captured.event = event;
  });
  return captured;
}

function mountOutsideTarget(): HTMLElement {
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  document.body.append(outside);
  return outside;
}

function renderDialog(props: Partial<GuidedOnboardingDialogProps> = {}) {
  return render(
    <GuidedOnboardingDialog
      brand={<span>Closedloop.ai</span>}
      downloadHrefs={DOWNLOAD_HREFS}
      onComplete={vi.fn()}
      open
      phase={OnboardingPhase.Welcome}
      {...props}
    />
  );
}
