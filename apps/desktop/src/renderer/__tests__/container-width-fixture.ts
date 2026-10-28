import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { afterEach, beforeEach } from "vitest";

/**
 * Install the shared `ResizeObserver` stub around every test in the calling
 * suite, at a desktop-window width.
 *
 * ISS-12276 (#8626) virtualized the shared Session trace, and its scroller
 * measure now constructs a `ResizeObserver` once the scroller resolves. jsdom
 * has none (Electron always does), so a suite that mounts Session detail
 * without this stub crashes the whole tree on mount.
 */
export function setupContainerWidthStub(widthPx = 1440): void {
  let restore: (() => void) | undefined;

  beforeEach(() => {
    restore = stubContainerWidthPx(widthPx);
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
  });
}
