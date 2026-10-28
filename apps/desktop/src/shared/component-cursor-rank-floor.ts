/**
 * @file component-cursor-rank-floor.ts
 * @description The component sync lane's KEYSET FLOOR, alone, in a boot-safe module.
 *
 * ISS-11327 (tamsinb review). The rank itself lives in
 * `main/database/component-cursor-rank.ts` and reaches `db-helpers.ts` /
 * `session-timestamp-form.ts` for its JS half, so the whole module is under
 * `src/main/database/**` — a path the boot graph may not statically reach
 * (`boot-no-design-system-runtime` in `scripts/dependency-cruiser.config.cjs`; the
 * db modules run in the forked db host). The lane and the cursor advance are both
 * boot-reachable and need only this ONE value, so it is spelled here and imported
 * by the rank module rather than re-derived on either side.
 */

/** The position NULL and every unreadable value share: before any real instant. */
export const COMPONENT_CURSOR_RANK_FLOOR = "";
