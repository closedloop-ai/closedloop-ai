/**
 * The query-param keys an artifact-detail route addresses state with: which
 * tab is open, and which comment the comments rail should open on.
 *
 * SSOT for both names, in a module with NO imports of its own, because the
 * modules that consume them are not safe for every reader of the keys:
 * `use-tab-param.ts` is a `"use client"` hook over `@repo/navigation`'s hooks,
 * and `artifact-comment-href.ts` reads the navigation port's types. A link
 * producer, a pure unit test, or a Playwright spec that needs only the KEY
 * must not drag a React runtime in to read it (`packages/app/AGENTS.md` —
 * split constants from the modules that consume them).
 *
 * Under the desktop E2E spec loader that is not a preference but a hard
 * failure: the hook's own extensionless `@repo/*` subpaths resolve to
 * something without its exports there, which aborts the whole suite at load
 * time (`apps/desktop/test/AGENTS.md` — Import hazard).
 */

/** The key a tabbed screen uses unless it names its own. */
export const DEFAULT_TAB_PARAM = "tab";

/** The key naming the comment thread the rail opens on (ISS-11004). */
export const ARTIFACT_COMMENT_PARAM = "comment";
