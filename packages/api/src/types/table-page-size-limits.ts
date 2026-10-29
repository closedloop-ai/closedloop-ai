/**
 * ISS-9692: the largest rows-per-page a list surface may offer, and therefore
 * the floor under every list endpoint's `limit` cap.
 *
 * The ladder itself (`TABLE_PAGE_SIZE_OPTIONS_EXTENDED`) lives in
 * `@repo/design-system`, which is a project-agnostic product and is GATED from
 * importing `@repo/api` (biome `noRestrictedImports` on
 * `packages/design-system/**`) — and `@repo/api` cannot import it back without
 * dragging React into the API server's build graph. So the two cannot be one
 * declaration, and this value is the server-side twin of the ladder's largest
 * entry.
 *
 * `packages/app/shared/lib/__tests__/table-page-size-ladder-agreement.test.ts`
 * is what holds them in step: it can import BOTH, and it fails if any offered
 * page size exceeds this value or if any surface's own cap falls below it. That
 * test is the durable guard the ticket asks for — before it, adding a rung to
 * the shared ladder silently offered Sessions users a size its validator
 * rejected with a 400.
 *
 * Raised UNCONDITIONALLY, not behind the `table-page-size-ladder` flag: a cap is
 * not perceivable UI, and a flag-off client never asks for a size it cannot
 * select, so gating the server would only 400 the requests the flag allowed.
 */
export const TABLE_PAGE_SIZE_MAX = 500;
