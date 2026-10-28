/**
 * Reading a Packs Performance tile back out of a render, for the two suites
 * that drive `PackDetail` from opposite adapters (the web one beside the
 * component, the desktop one in `apps/desktop`).
 *
 * Both needed the same two readers and had begun to keep private copies, which
 * is how one surface's selector drifts from the other's while both stay green.
 */

/** Everything a tile's card renders, its delta caption included. */
export function metricCardText(screen: TestingScreen, label: string): string {
  return metricCard(screen, label).textContent?.trim() ?? "";
}

/** The accessible name of a tile's info-hint trigger and its popover. */
export function metricCardHintName(label: string): string {
  return `About ${label}`;
}

function metricCard(screen: TestingScreen, label: string): Element {
  const card = screen.getByText(label).closest("[data-slot='card']");
  if (!card) {
    throw new Error(`the ${label} label is not inside a card`);
  }
  return card;
}

/**
 * The one `@testing-library/react` member these helpers need. Structural rather
 * than imported: `packages/app` is consumed from the desktop renderer's own
 * vitest project, which resolves its testing-library copy separately.
 */
type TestingScreen = {
  getByText: (text: string) => HTMLElement;
};
