/**
 * Ambient types for the runtime sibling `preview-heavy-migrations-core.mjs`,
 * which is the ONE owned source for these values.
 *
 * The migration names are deliberately NOT restated here. They were, and the
 * copy drifted (ISS-6211): this file listed 5 skip entries and 1 plain-build
 * entry while the `.mjs` had grown to 9 and 2. A literal tuple bought the two
 * consumers nothing — `scripts/lint/destructive-migrations/index-ddl.ts` and
 * `preview-heavy-migrations.ts` only test membership against a `string` — and
 * cost a hand-maintained duplicate that no runtime test could see.
 *
 * `__tests__/preview-heavy-migrations-declaration-parity.test.ts` keeps it that
 * way: it resolves this file's AST and fails when an export here disagrees with
 * the runtime module, including a re-introduced literal that has drifted.
 */

export const PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS: readonly string[];
export const PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS: readonly string[];
export const PREVIEW_SKIP_OPT_OUT_MARKER: "preview-skip: no";

export function isPreviewSkippableConcurrentIndexSql(sql: string): boolean;
export function containsConcurrentIndexBuild(sql: string): boolean;
