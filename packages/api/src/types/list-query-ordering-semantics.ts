/**
 * ISS-9585 (PRD-706 R10-G03) — how a list query orders and bounds values that
 * ARE present: which collation ranks two strings, which locale that collation
 * is pinned to, and which instant a date-window bound anchors to.
 *
 * The sibling `./list-query-value-semantics.ts` owns the values a query cannot
 * judge, INCLUDING where an unrankable row lands: `ListQuerySortDisposition`
 * and `listQueryOrdersUnrankedRowFirst` are the null/unknown placement rule,
 * declared per field by each list's own registry and already derived at both
 * mirrors. Nothing here restates it.
 *
 * Split from that module rather than appended to it for the reason
 * `artifact-status-rank.ts` is split from `artifact-status.ts`: one module per
 * question, so a compiler imports the rule it needs.
 *
 * ## What both mirrors must honor
 *
 * A list query is answered by two compilers over the same rows — SQL in
 * `apps/api`, and the shared TypeScript kernel `@repo/lib/branches` that the
 * desktop main process runs. Ordering and window bounds are the two places
 * where the SAME query can select a different page, or a different population,
 * depending only on which HOST answered it. Every rule below exists to remove a
 * host from an answer.
 */

/**
 * Which collation ranks a text sort key.
 *
 * The axis is the KEY, not the surface: both compilers apply the same class to
 * the same key, or the two answers diverge.
 */
export const ListQueryTextOrdering = {
  /**
   * Prose a reader expects alphabetized — a name, a label, a repository. Ranks
   * under the ICU root collation, so case and accents fold the way a reader
   * reads them rather than the way UTF-16 stores them.
   */
  Collated: "collated",
  /**
   * A machine identifier — an enum spelling, a bucket key. Ranks by code unit,
   * because collation has nothing to add to a value no one reads as prose and a
   * tailoring would only be one more thing to keep in step.
   *
   * An identifier whose digit runs a reader compares as numbers is
   * {@link ListQueryTextOrdering.Natural}, not this: the artifact slug ranks
   * there (ISS-12636), because the surfaces that sort it already do.
   */
  CodeUnit: "codeUnit",
  /**
   * An identifier whose DIGIT RUNS are magnitudes a reader compares as numbers
   * — `ISS-9` before `ISS-10`, which {@link ListQueryTextOrdering.CodeUnit}
   * reverses. Ranks under the ICU root collation with numeric ordering on.
   *
   * Narrower than it looks: this class is for a key a surface ALREADY ranks
   * this way, never a retuning of one that ranks by code unit today. The
   * artifact slug is the case it exists for (ISS-12636) — the My Tasks and
   * project tables sort it with `numeric: true`, so a server-side mirror that
   * ranked it by code unit would renumber a column the reader is looking at.
   *
   * Its collation does NOT ship with Postgres and is created by
   * `20261021160000_iss12636_natural_text_collation`. A database missing that
   * migration fails the query rather than falling back, which is the intended
   * failure: a silent fallback would take the cluster's default collation and
   * rank a third way.
   */
  Natural: "natural",
} as const;
export type ListQueryTextOrdering =
  (typeof ListQueryTextOrdering)[keyof typeof ListQueryTextOrdering];

/**
 * Every collation name this ruling may name.
 *
 * A closed union rather than `string` because {@link LIST_QUERY_TEXT_COLLATION}
 * is interpolated into `Prisma.raw` by `branchListTextCollationSql`, which
 * escapes nothing and lands in every branch-list query. Widened, a later entry
 * read from config or carrying a quote compiles clean and injects; constrained
 * here, the interpolation cannot be anything but one of these spellings.
 *
 * `satisfies`/`as const` does NOT do this job — measured on PR #7954: an entry
 * written `process.env.COLLATION ?? "C"` is typed `string`, which satisfies a
 * `Record<…, string>` constraint, and both `packages/api` and `apps/api`
 * typechecked clean. Only the annotation refuses it.
 */
export type ListQueryTextCollationName = "und-x-icu" | "C" | "en-u-kn";

/**
 * The Postgres collation naming each class, so the SQL mirror spells out what
 * the comparator does instead of carrying its own literal.
 *
 * Exhaustive by type: a class added later fails `tsc` here rather than reaching
 * the database as an unnamed collation, where it would silently take the
 * cluster's libc default — a third ordering that matches neither mirror.
 */
export const LIST_QUERY_TEXT_COLLATION: Readonly<
  Record<ListQueryTextOrdering, ListQueryTextCollationName>
> = Object.freeze({
  [ListQueryTextOrdering.Collated]: "und-x-icu",
  [ListQueryTextOrdering.CodeUnit]: "C",
  [ListQueryTextOrdering.Natural]: "en-u-kn",
});

/**
 * The locale {@link ListQueryTextOrdering.Collated} is pinned to.
 *
 * `"en"` is not an English preference — it is the tag whose CLDR collation
 * carries no tailoring, so it ranks by the root (DUCET) order that Postgres
 * `und-x-icu` implements, and which `Intl` will not silently replace.
 *
 * The obvious spelling of "root" does NOT work and is the trap this constant
 * exists to avoid: `"und"` and `"zxx"` are read as "no preference", so
 * `new Intl.Collator("und").resolvedOptions().locale` is the HOST's locale.
 * Measured on Node 24: under `LC_ALL=sv_SE`, `"und"` resolves to `sv-SE` and
 * ranks `ä` after `z`, while `"en"` resolves to `en` and ranks it after `a` on
 * every host. A bare `localeCompare()` with no locale has the same defect, and
 * that is what this module replaced at both mirrors.
 */
export const LIST_QUERY_COLLATED_LOCALE = "en";

const COLLATED_COMPARE = new Intl.Collator(LIST_QUERY_COLLATED_LOCALE).compare;

/**
 * Postgres normalizes the collation's locale to `en-u-kn`, and ICU reads a
 * bare `kn` keyword as `kn-true`, so the two mirrors name the same tailoring
 * from one spelling each rather than from a shared literal that would have to
 * be re-escaped for SQL.
 */
const NATURAL_COMPARE = new Intl.Collator(LIST_QUERY_COLLATED_LOCALE, {
  numeric: true,
}).compare;

/**
 * The zone-less date-time form. A date-only string is already UTC by
 * specification, and an offset or `Z` already names its own instant.
 *
 * Case-insensitive because the designator V8 reads is not the one the grammar
 * writes: `Date.parse("2026-09-25t00:00:00")` is the host's clock on Node 24,
 * reached through the implementation-defined fallback parser rather than the
 * spec's uppercase-`T` format.
 *
 * NOT the only form `Date` anchors to the host, which the docstring here used to
 * claim (tamsinb, PR #7954). That same fallback parser reads `"2026/09/25"`,
 * `"2026/09/25 00:00"` and `"Sep 25 2026"` against the host too — all measured
 * 5h apart between `TZ=UTC` and `TZ=America/Chicago` on Node 24. Those forms are
 * not rewritten here because no shipped client sends one (every caller of
 * `getStableDateWindowForRange` sends `Date#toISOString`), and narrowing what
 * the boundary ACCEPTS is a request-contract decision rather than an ordering
 * one: ISS-11421.
 */
const ZONELESS_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/i;

/** Which clock an instant a list query handles is read against. */
export const ListQueryInstantAnchor = {
  /** Absolute, and therefore the same on every host. */
  Utc: "utc",
  /** The viewer's own calendar, and therefore different on every host. */
  Viewer: "viewer",
} as const;
export type ListQueryInstantAnchor =
  (typeof ListQueryInstantAnchor)[keyof typeof ListQueryInstantAnchor];

/** The two jobs a list query gives an instant. */
export const ListQueryInstantRole = {
  /** A `startDate`/`endDate` bound, which decides which rows are in the query. */
  WindowBound: "windowBound",
  /** A day or hour bucket a reader sees, which decides only how rows are labelled. */
  BucketLabel: "bucketLabel",
} as const;
export type ListQueryInstantRole =
  (typeof ListQueryInstantRole)[keyof typeof ListQueryInstantRole];

/**
 * The ruling, stated once: a bound that decides POPULATION is absolute, and only
 * a label a reader reads is local.
 *
 * This is the rule the desktop Insights backend already keeps in prose
 * (`apps/desktop/src/main/database/local-insights.ts`, FEA-2430: "Window
 * BOUNDARIES are UTC, never local; only bucket labels are local"), given a
 * symbol so the list-query compilers honor the same one rather than a second
 * reading of it.
 *
 * SCOPE, because the same FEA-2430 rules the other way one directory over and a
 * reader who takes this as universal would "fix" a shipped decision: a LIST
 * QUERY selects a population a reader then pages and sorts, and its bound is
 * absolute. A dashboard window that exists to total the viewer's own calendar
 * days is a different question — `getTokenAnalytics`
 * (`apps/desktop/src/main/database/dashboard-queries.ts`) sets its edges to
 * local midnight and local end-of-today so they match the local byDay buckets
 * it renders, and `apps/desktop/test/dashboard-queries-contract.test.ts` pins
 * exactly that. Neither contradicts the other; they answer different questions.
 *
 * Nor does this take the reader's day boundary away from them. ISS-9619 lets a
 * Sessions/Branches reader choose whether a range means their calendar days or
 * UTC ones — and `getStableLocalDateWindowForRange`
 * (`packages/app/shared/lib/format-utils.ts`) resolves that choice client-side
 * and sends the resulting instant, so the wire carries an absolute bound under
 * BOTH modes. The choice is upstream of this rule, which is why the two compose
 * rather than compete.
 */
export const LIST_QUERY_INSTANT_ANCHOR: Readonly<
  Record<ListQueryInstantRole, ListQueryInstantAnchor>
> = Object.freeze({
  [ListQueryInstantRole.WindowBound]: ListQueryInstantAnchor.Utc,
  [ListQueryInstantRole.BucketLabel]: ListQueryInstantAnchor.Viewer,
});

/**
 * Rank two text sort keys under `ordering`, identically on every host.
 *
 * Dispatched through an exhaustive map rather than a branch: a third class
 * added to {@link ListQueryTextOrdering} fails `tsc` here, where a chain of
 * `if`s would compile and silently hand it whichever comparator fell through.
 */
export function compareListQueryText(
  left: string,
  right: string,
  ordering: ListQueryTextOrdering
): number {
  return LIST_QUERY_TEXT_COMPARATOR[ordering](left, right);
}

/**
 * A window bound as the caller wrote it, rewritten so it names one instant.
 *
 * Non-strings and every form that already carries a zone pass through
 * untouched, so this narrows nothing and refuses nothing — what a boundary
 * accepts stays `./list-query-value-semantics.ts`'s question. It only removes
 * the host from a bound that did not name one: `new Date("2026-09-25T00:00:00")`
 * is 05:00Z in Chicago and 00:00Z on the API server, so the same saved query
 * selects a different population on each.
 */
export function anchorListQueryWindowBound(value: unknown): unknown {
  if (typeof value === "string") {
    return anchorListQueryWindowBoundText(value);
  }
  return value;
}

/**
 * The same bound as epoch milliseconds for the in-memory kernel, `NaN` for a
 * value `Date` cannot read — which is the reading the kernel already had, so an
 * unparseable bound keeps failing its comparison rather than newly throwing.
 */
export function listQueryWindowBoundMs(value: string): number {
  return Date.parse(anchorListQueryWindowBoundText(value));
}

function compareCodeUnit(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Exhaustive by type, for the reason {@link LIST_QUERY_TEXT_COLLATION} is: the
 * two mirrors must not be able to disagree about which comparator a class names.
 */
const LIST_QUERY_TEXT_COMPARATOR: Readonly<
  Record<ListQueryTextOrdering, (left: string, right: string) => number>
> = Object.freeze({
  [ListQueryTextOrdering.Collated]: COLLATED_COMPARE,
  [ListQueryTextOrdering.CodeUnit]: compareCodeUnit,
  [ListQueryTextOrdering.Natural]: NATURAL_COMPARE,
});

/**
 * The string half of {@link anchorListQueryWindowBound}, typed so no caller casts.
 *
 * Reads the anchor out of {@link LIST_QUERY_INSTANT_ANCHOR} rather than stamping
 * `Z` unconditionally, so the ruling map is what decides and flipping
 * `WindowBound` to `Viewer` changes this behavior instead of leaving a constant
 * nothing consults.
 */
function anchorListQueryWindowBoundText(value: string): string {
  const anchorsToUtc =
    LIST_QUERY_INSTANT_ANCHOR[ListQueryInstantRole.WindowBound] ===
    ListQueryInstantAnchor.Utc;
  if (anchorsToUtc && ZONELESS_DATE_TIME.test(value)) {
    return `${value}Z`;
  }
  return value;
}
