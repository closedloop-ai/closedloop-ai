import { screen } from "@testing-library/react";

export function getMetricValueRow(label: string): HTMLElement {
  const card = screen.getByText(label).closest('[data-slot="card"]');
  if (!card) {
    throw new Error(`Metric card for ${label} is missing`);
  }
  const valueRow = card.querySelector('[data-slot="card-title"]');
  if (!(valueRow instanceof HTMLElement)) {
    throw new Error(`Metric value row for ${label} is missing`);
  }
  return valueRow;
}

/**
 * Upper bound on {@link tabTo}'s walk — comfortably past the focus stops a KPI
 * card carries, low enough that an unreachable target fails fast.
 */
const MAX_TAB_STOPS = 12;

/**
 * Tab forward until `target` holds focus, then stop.
 *
 * Asserting an absolute tab position is brittle on these cards: ISS-4995 made
 * the "No comparison" delta chip focusable (its tooltip is the only place the
 * two no-comparison states differ), which inserts a stop ahead of the info
 * affordance on every KPI without a delta. Tests that care about what a control
 * does on focus should say "reach it", not "it is the Nth stop".
 *
 * Leaves focus where it landed so the caller can keep driving. Throws rather
 * than looping forever when the target is not reachable at all — which is the
 * failure worth reporting.
 */
export async function tabTo(
  user: { tab: () => Promise<void> },
  target: Element
): Promise<void> {
  for (let stop = 0; stop < MAX_TAB_STOPS; stop++) {
    if (document.activeElement === target) {
      return;
    }
    await user.tab();
  }
  if (document.activeElement !== target) {
    throw new Error(
      `Target was not reachable by keyboard within ${MAX_TAB_STOPS} tab stops`
    );
  }
}
