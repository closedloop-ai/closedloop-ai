import { afterAll, beforeAll } from "vitest";

/**
 * jsdom has no layout, so `Range` lacks the rect methods the bubble menu
 * positions against and ProseMirror's scroll-into-view measures, and elements
 * lack the `scrollIntoView` the text-style dropdown calls on open.
 *
 * Installs the stubs for the calling file's suite and restores them after. The
 * prototypes are read inside the hooks, so importing this from a file that is
 * not on the jsdom environment does not throw.
 */
export function installJsdomLayoutStubs(): void {
  let installed: {
    target: object;
    key: string;
    original: PropertyDescriptor | undefined;
  }[] = [];

  beforeAll(() => {
    const stubs = [
      { target: Range.prototype, key: "getClientRects", value: () => [] },
      {
        target: Range.prototype,
        key: "getBoundingClientRect",
        value: () => new DOMRect(),
      },
      {
        target: Element.prototype,
        key: "scrollIntoView",
        value: () => undefined,
      },
    ];
    installed = stubs.map(({ target, key, value }) => {
      const original = Object.getOwnPropertyDescriptor(target, key);
      Object.defineProperty(target, key, { configurable: true, value });
      return { target, key, original };
    });
  });

  afterAll(() => {
    for (const { target, key, original } of installed) {
      if (original) {
        Object.defineProperty(target, key, original);
      } else {
        Reflect.deleteProperty(target, key);
      }
    }
    installed = [];
  });
}
