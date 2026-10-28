/**
 * Report a chosen width as the observed content-box width, so
 * `useContainerWidth` commits it.
 *
 * The implementation lives in
 * `packages/typescript-config/vitest-container-width-stub` (ISS-7432). This
 * package is gated from importing `@repo/app` (`AGENTS.md`), so the ready-made
 * `@repo/app/test/mocks/container-width` is unreachable and a hand-copy stood
 * here instead; `packages/typescript-config` is the package both sides may
 * legally import, and both already reach it by relative path for
 * `vitest-jsdom-setup`.
 *
 * It delegates rather than re-exporting because a file that only forwards names
 * is a barrel, which Biome rejects.
 *
 * Install BEFORE `render` and restore in `afterEach`.
 */

import { stubContainerWidthPx as stubContainerWidthPxImpl } from "../../../typescript-config/vitest-container-width-stub";

/** Report `widthPx` for the duration of a test; returns the restore function. */
export function stubContainerWidthPx(widthPx: number): () => void {
  return stubContainerWidthPxImpl(widthPx);
}
