/**
 * Declare which `md` tier a `SummaryCardRow` test is rendering in.
 *
 * The shared `vitest.setup.ts` stubs `matchMedia` as always NON-matching, which
 * is right for the responsive-dialog hook it exists for but puts every row below
 * the `md` breakpoint. Two of the row's derivations key off that tier and behave
 * differently on each side of it — `useSummaryCardColumns` stands down below
 * `md` (the row's own `grid-cols-2` class owns the layout there), and since
 * ISS-5366 `useSummaryCardDensity` asks the fixed-cell question instead of the
 * one-rank question — so a suite asserting desktop widths has to say so, or it
 * silently asserts the phone regime at a 1099px track.
 *
 * Extracted here because three suites needed the identical ~40-line stub. The
 * shape mirrors `vitest.setup.ts` exactly, including the deprecated
 * `addListener`/`removeListener` pair, so the object satisfies `MediaQueryList`
 * structurally and needs no cast.
 */
export function stubGridTier(matches: boolean): PropertyDescriptor | undefined {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis.window,
    "matchMedia"
  );
  Object.defineProperty(globalThis.window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {
        // No live tier changes in these suites; each test renders at one tier.
      },
      removeEventListener: () => {
        // Paired with the no-op above.
      },
      addListener: () => {
        // Deprecated MediaQueryList member, present for structural parity.
      },
      removeListener: () => {
        // Deprecated MediaQueryList member, present for structural parity.
      },
      dispatchEvent: () => false,
    }),
    writable: true,
  });
  return previous;
}

/**
 * Put `matchMedia` back exactly as it was, including the case where the property
 * did not exist at all — assigning `undefined` would leave a real own property
 * behind and change what the next suite's `globalThis.window.matchMedia` check
 * sees.
 */
export function restoreGridTier(
  previous: PropertyDescriptor | undefined
): void {
  if (previous) {
    Object.defineProperty(globalThis.window, "matchMedia", previous);
    return;
  }
  Reflect.deleteProperty(globalThis.window, "matchMedia");
}
