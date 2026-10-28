/**
 * PLN-1950 slice 5: desktop's content-scroll restoration hook
 * (`../navigation/use-content-scroll-restoration.ts`) against the shared
 * sessions-scroll contract (packages/app/shared/lib/sessions-scroll-contract.ts).
 * Net-new coverage -- nothing under apps/desktop named these constants or
 * asserted this behaviour before this slice. `app-shell-sessions.test.tsx`
 * already exercises the restore end-to-end through a full App mount
 * ("returns from a page-two session detail to the same sessions page and
 * scroll position"); this file pins the retry bound and clamp math the
 * mechanism actually runs on, via the real exported functions rather than a
 * source scan.
 */
import {
  clampScrollRestoreTarget,
  computeMaxScrollTop,
  hasStoredScrollPosition,
  runSessionsScrollContractConformance,
} from "@repo/app/shared/lib/sessions-scroll-contract";
import { describe, expect, it } from "vitest";
import {
  MAX_CONTENT_SCROLL_RESTORE_ATTEMPTS,
  restoreContentScrollPosition,
} from "../navigation/use-content-scroll-restoration";

describe("desktop content-scroll restore — shared sessions scroll contract", () => {
  it("passes the shared gate, retry-bound and clamp contract, wired to the real production constant", () => {
    runSessionsScrollContractConformance({
      hostLabel: "desktop App-shell content scroll",
      maxRestoreAttempts: MAX_CONTENT_SCROLL_RESTORE_ATTEMPTS,
      computeMaxScrollTop,
      clampScrollRestoreTarget,
      hasStoredScrollPosition,
    });
  });

  it("clamps a remembered position through the real restoreContentScrollPosition", () => {
    const overflowing = createFakeContentViewport({
      scrollHeight: 1000,
      clientHeight: 600,
    });
    restoreContentScrollPosition(overflowing, 900);
    expect(overflowing.scrollTop).toBe(400);

    const roomy = createFakeContentViewport({
      scrollHeight: 1000,
      clientHeight: 600,
    });
    restoreContentScrollPosition(roomy, 250);
    expect(roomy.scrollTop).toBe(250);
  });
});

function createFakeContentViewport({
  scrollHeight,
  clientHeight,
}: {
  scrollHeight: number;
  clientHeight: number;
}): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  return element;
}
