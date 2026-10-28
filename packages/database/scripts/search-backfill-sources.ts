/**
 * ISS-9699 — corpus selection for the `search_document` backfill.
 *
 * The drift the backfill is asked to correct is usually narrow — one column on
 * one corpus — but the sweep's only mode was "every corpus in one interactive
 * transaction", which on a production corpus rewrites every comment, pull
 * request, and branch row to fix that one column. A reconcile priced that far
 * above the correction is one nobody runs.
 *
 * So this is a scoping vocabulary, not a second backfill: the same sweep, the
 * same queries, restricted to the corpora an operator names.
 */

/**
 * The corpora {@link runSearchDocumentBackfill} sweeps, keyed by the name an
 * operator types after `--only=`.
 */
export const SearchBackfillSource = {
  Documents: "documents",
  Projects: "projects",
  Comments: "comments",
  PullRequests: "pull-requests",
  Branches: "branches",
  AgentComponents: "agent-components",
} as const;
export type SearchBackfillSource =
  (typeof SearchBackfillSource)[keyof typeof SearchBackfillSource];

/** Every corpus — the default when `--only` is absent. */
export const ALL_SEARCH_BACKFILL_SOURCES: readonly SearchBackfillSource[] =
  Object.values(SearchBackfillSource);

const ONLY_PREFIX = "--only";
const ONLY_FLAG = `${ONLY_PREFIX}=`;

const KNOWN_SOURCES: ReadonlySet<string> = new Set(ALL_SEARCH_BACKFILL_SOURCES);

function isSearchBackfillSource(value: string): value is SearchBackfillSource {
  return KNOWN_SOURCES.has(value);
}

/**
 * Read `--only=<name>[,<name>…]` out of a CLI argv tail.
 *
 * Returns `undefined` when the flag is absent, which the sweep reads as "every
 * corpus": the flag is opt-in, so an operator who forgets it still gets the full
 * historical backfill rather than a silently narrowed one.
 *
 * Every failure mode that could resolve to a DIFFERENT selection than the one
 * typed throws instead — an unrecognised or empty name, and a malformed
 * `--only` with no `=`. Silently narrowing reports a successful zero-row run
 * indistinguishable from "the corpus was already clean"; silently widening
 * rewrites the whole corpus the narrowing existed to avoid. Repeated
 * `--only=` flags are unioned rather than dropped, so neither can happen.
 */
export function parseSearchBackfillSources(
  argv: readonly string[]
): SearchBackfillSource[] | undefined {
  const malformed = argv.find(
    (arg) => arg.startsWith(ONLY_PREFIX) && !arg.startsWith(ONLY_FLAG)
  );
  if (malformed !== undefined) {
    throw new Error(
      `[backfill-search-documents] malformed flag "${malformed}"; use ${ONLY_FLAG}<corpus>[,…]`
    );
  }

  const flags = argv.filter((arg) => arg.startsWith(ONLY_FLAG));
  if (flags.length === 0) {
    return;
  }

  const names = flags.flatMap((flag) =>
    flag
      .slice(ONLY_FLAG.length)
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
  );
  if (names.length === 0) {
    throw new Error(
      `[backfill-search-documents] --only needs at least one corpus; known: ${ALL_SEARCH_BACKFILL_SOURCES.join(", ")}`
    );
  }

  const selected = new Set<SearchBackfillSource>();
  const unknown: string[] = [];
  for (const name of names) {
    if (isSearchBackfillSource(name)) {
      selected.add(name);
    } else {
      unknown.push(name);
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `[backfill-search-documents] unknown --only corpus: ${unknown.join(", ")}; known: ${ALL_SEARCH_BACKFILL_SOURCES.join(", ")}`
    );
  }

  return [...selected];
}
