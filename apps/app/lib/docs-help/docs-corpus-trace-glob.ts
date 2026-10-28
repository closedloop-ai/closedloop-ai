/**
 * ISS-10006 — the `outputFileTracingIncludes` pattern that ships the docs corpus
 * with the Help route handlers.
 *
 * RELATIVE TO `apps/app`, because Next globs tracing includes with `cwd` set to
 * the Next project directory rather than to `outputFileTracingRoot`. A pattern
 * written as if it were repo-relative resolves to `apps/app/apps/web/...`,
 * matches nothing, and fails silently — an include that matches no file is not
 * a build error, so the corpus simply is not deployed.
 *
 * Its own module so `next.config.ts` and the guard that globs it read the SAME
 * string. A guard that restated the pattern would pass while the config shipped
 * a different one.
 */
export const DOCS_CORPUS_TRACE_GLOB = "../web/content/docs/**/*";
