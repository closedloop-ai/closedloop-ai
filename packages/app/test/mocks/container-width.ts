/**
 * Shared test helper for driving `useContainerWidth` (ISS-4889).
 *
 * The implementation is no longer here. ISS-7432 hoisted it to
 * `packages/typescript-config/vitest-container-width-stub`, which is the one
 * package `@repo/app` and `@repo/design-system` may BOTH import — the design
 * system is gated from importing `@repo/app` at all, so a parameterized stub
 * that lived here could never be the design system's too, and a hand-copy over
 * there was the result.
 *
 * This module stays as the app-side name so the suites that consume it keep
 * their existing import, and it delegates rather than re-exporting: a file that
 * only forwards names is a barrel, which Biome rejects here. The cross-package
 * reach is relative because `@repo/typescript-config`'s `exports` map lists only
 * its four tsconfig JSON files — the same relative pattern `vitest.setup.ts`
 * already uses for `vitest-jsdom-setup`.
 *
 * Call either helper BEFORE `render`: the hook observes in its mount effect and
 * the shim reports synchronously from `observe`, so the first committed
 * measurement is the width under test. Restore in `afterEach`, never only at the
 * end of a case — an assertion that throws above the restore leaks the stub into
 * every later test in the worker.
 */

import {
  type ResizableContainerWidthStub,
  stubContainerWidthPx as stubContainerWidthPxImpl,
  stubResizableContainerWidthPx as stubResizableContainerWidthPxImpl,
} from "../../../typescript-config/vitest-container-width-stub";

/** Report `widthPx` for the duration of a test; returns the restore function. */
export function stubContainerWidthPx(widthPx: number): () => void {
  return stubContainerWidthPxImpl(widthPx);
}

/**
 * Like {@link stubContainerWidthPx}, but the reported width can be CHANGED
 * during the test (ISS-4906) — which is what the fold-fit damping contract needs
 * and a report-once stub can never express.
 */
export function stubResizableContainerWidthPx(
  initialWidthPx: number
): ResizableContainerWidthStub {
  return stubResizableContainerWidthPxImpl(initialWidthPx);
}
