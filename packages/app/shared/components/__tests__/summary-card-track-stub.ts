/**
 * Supply the two layout inputs `useSummaryCardDensity` reads and jsdom cannot
 * produce: the row's content-box width (`clientWidth`) and its resolved
 * `column-gap`.
 *
 * The gap MATTERS and is stubbed rather than left at jsdom's `""` → 0: four
 * 16px gutters are 64px of the 1364px comfortable crossover, so a test run at
 * gap 0 would assert the wrong boundary and pass against an implementation that
 * ignored the gutters entirely. Everything downstream of these two values is the
 * real hook.
 *
 * Why a shared module (ISS-10540): in jsdom an UNMEASURED row folds to Compact,
 * so a bare `data-density=compact` assertion is vacuous — it passes with the
 * pin deleted. The only state in which a Compact pin is observable is a track
 * where the MEASURED tier resolves Comfortable, and that needs this stub plus
 * `stubGridTier(true)`. Every suite that pins a strip's density mounts the pair,
 * so the matchMedia half stays in `summary-card-grid-tier-stub.ts` beside it.
 */

export const SUMMARY_CARD_COLUMN_GAP_PX = 16;

export type TrackStubDescriptors = {
  clientWidth: PropertyDescriptor | undefined;
  computedStyle: PropertyDescriptor | undefined;
};

/**
 * Install the `columnGap` proxy over `getComputedStyle`. `columnGap` only:
 * padding and every other property still come from jsdom, so nothing else
 * about the measurement is faked. Returns the descriptors `restoreTrackStub`
 * needs to put both properties back exactly as they were.
 */
export function stubTrackGap(): TrackStubDescriptors {
  const clientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth"
  );
  const computedStyle = Object.getOwnPropertyDescriptor(
    globalThis.window,
    "getComputedStyle"
  );
  const original = globalThis.window.getComputedStyle.bind(globalThis.window);
  Object.defineProperty(globalThis.window, "getComputedStyle", {
    configurable: true,
    value: (element: Element, pseudo?: string | null) => {
      const style = original(element, pseudo ?? undefined);
      return new Proxy(style, {
        get(target, key) {
          if (key === "columnGap") {
            return `${SUMMARY_CARD_COLUMN_GAP_PX}px`;
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    writable: true,
  });
  return { clientWidth, computedStyle };
}

/** Pin every element's content-box width to `width` px. */
export function stubTrackWidth(width: number): void {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width,
  });
}

/**
 * Put both stubbed properties back exactly as they were: the captured
 * descriptor when the object owned one, and otherwise removed entirely.
 * Assigning `undefined` would leave the key present with a dead value rather
 * than restoring the prototype/host behaviour the stub shadowed.
 */
export function restoreTrackStub(descriptors: TrackStubDescriptors): void {
  restoreOwnProperty(
    HTMLElement.prototype,
    "clientWidth",
    descriptors.clientWidth
  );
  restoreOwnProperty(
    globalThis.window,
    "getComputedStyle",
    descriptors.computedStyle
  );
}

function restoreOwnProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  Reflect.deleteProperty(target, key);
}
