/**
 * ISS-8554 — the shared TypedSQL facet fragments: expansion, and the one
 * invariant expansion cannot cover.
 *
 * SHARED CORE. Two entry points import this and must never disagree about what
 * expansion means: `splice-sql-fragments.mjs` (the WRITER, run by
 * `pnpm run sync:typed-sql`) and `scripts/lint/check-typed-sql-fragments.ts`
 * (the GUARD, run in CI). The guard lives under `scripts/lint/` because
 * `guard-policy.ts` requires a `check:<id>` script to be backed by
 * `scripts/lint/check-<id>.ts`; this module is what keeps that split from
 * becoming a second implementation.
 *
 * WHY THIS EXISTS. Four statements (usage totals, cost split, merged PR LOC, LOC
 * coverage) must apply an IDENTICAL facet filter, and a fifth (facet counts)
 * shares most of it. TypedSQL has no include mechanism: each `.sql` file is
 * prepared standalone against the server, so the text has to be present in every
 * file. Four hand-maintained copies of a ~100-line predicate is how the four
 * cards come to disagree about what "has a PR" means — which is the exact defect
 * class ISS-7905 and ISS-5823 already recorded on this surface.
 *
 * So the text has ONE source in `prisma/sql-fragments/`, and this script expands
 * it into each consumer between sentinel markers:
 *
 *   -- >>> FRAGMENT facet-common (generated — edit prisma/sql-fragments/facet-common.sql)
 *   ...expanded body...
 *   -- <<< FRAGMENT facet-common
 *
 * The expansion is committed rather than produced at build time, because Prisma
 * reads the `.sql` files directly and a reviewer reads them too — a statement
 * whose real WHERE clause is invisible in the file is worse than a copy.
 * `--check` is the CI half: it re-expands in memory and fails when a committed
 * region has drifted, so editing a copy inline is caught rather than shipped.
 *
 * Marker indentation is preserved: each fragment line is prefixed with the
 * indentation of the opening marker, so the same fragment reads correctly in a
 * top-level WHERE and inside a CTE.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const dbRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const sqlDir = join(dbRoot, "prisma", "sql");
export const fragmentDir = join(dbRoot, "prisma", "sql-fragments");

/**
 * The statements that MUST carry a spliced fragment region. ISS-8554 added this
 * floor because a bare count could not tell a stripped marker from a file that
 * never had one (`sessionLastSyncTargets.sql` legitimately has none).
 *
 * ISS-9757 moved it here, out of the CLI-only guard script, so a test can import
 * it without executing that script's top-level walk — and so it can be pinned.
 * Unpinned, deleting a name, stripping that statement's markers and inlining a
 * divergent predicate left `missingRegion` empty, `drifted` empty and every
 * check green; the guard's own stderr advertised the edit as the escape hatch.
 * `statementsCarryingFacetCommon` derives the same set from the committed tree,
 * and a test asserts the two agree — so removing a name now requires removing
 * the predicate too.
 */
export const STATEMENTS_REQUIRING_A_FRAGMENT = new Set([
  "sessionCostSplit.sql",
  "sessionFacetCounts.sql",
  "sessionListPageByCompoundSort.sql",
  "sessionListPageByDuration.sql",
  "sessionListPageByUpdated.sql",
  "sessionListPageByUser.sql",
  "sessionLocCoverageCounts.sql",
  "sessionMergedPrLoc.sql",
  "sessionUsageTotals.sql",
]);

/**
 * Text from `facet-common.sql` distinctive enough that its presence means the
 * statement shares that predicate. Deliberately keyed on the PREDICATE, not on
 * the markers: stripping the markers is the attack, so a derivation that read
 * them would agree with the attacker. Any one hit qualifies the file, so
 * inlining part of the fragment does not dodge it.
 *
 * ISS-10039: keyed on COLUMN/TABLE IDENTITY and STABLE PREDICATE SHAPES, never
 * on a parameter's POSITION in the shared tuple. Every probe wildcards its
 * parameter number (`\$\d+`) and word-boundaries its alias (`\b`) — tamsinb on
 * #7429: without the boundary, `a\.project_id` also matches `pa.project_id`
 * and `sd\.session_ended_at` also matches `xsd.session_ended_at`, so alias
 * discrimination silently degrades to a coincidence of spelling the moment a
 * second identifier happens to end the same way.
 *
 * `sd.session_ended_at` and `a.project_id` each appear on exactly one line
 * WITHIN `facet-common.sql` itself — and, once spliced, on the matching one
 * line of each of its seven copies (eight occurrences total across the tree,
 * all sourced from that same fragment line) — verified that no OTHER, unrelated
 * line anywhere in `prisma/sql` or `prisma/sql-fragments` matches either probe.
 * Before this, all three parameter-anchored probes moved together on a
 * renumbering: every probe missed, `statementsCarryingFacetCommon()` came back
 * empty, and the set-equality pin this backs (`STATEMENTS_REQUIRING_A_FRAGMENT`)
 * reds with a message whose cheapest fix is deleting names from that set — the
 * one action ISS-9757 built this floor to make impossible.
 *
 * The pull-request probe is NOT the bare `'session_pr_set'` literal (whitlockk on
 * #7429): that value also appears in `sessionLocCoverageCounts.sql`'s own
 * metric-only predicate, OUTSIDE the spliced facet-common region, through a
 * DIFFERENT alias (`al.metadata -> 'linkKinds' ? 'session_pr_set'`) — so the
 * bare literal alone would false-positive a statement that carried that
 * unrelated predicate but never spliced facet-common at all. `prl` is the
 * alias facet-common.sql itself binds (`FROM artifact_links prl`), verified
 * unique to its own splices across the whole tree, so qualifying the literal
 * by that alias (word-boundaried, same reason as the column probes) excludes
 * the `al.`-aliased false match without needing a parameter number.
 *
 * The changes-facet probe is likewise NOT the bare `'has_changes'` literal
 * (tamsinb on #7429): a future statement adding its own changes filter with
 * no relation to facet-common would pick up that literal and land in the
 * derived set without ever splicing this fragment, and the set-equality pin
 * would then red pointing at a file that carries nothing wrong. Anchored to
 * the predicate shape (`'has_changes' = ANY($N::text[])`) instead, parameter
 * wildcarded the same way as the column probes.
 *
 * Exported so a test can pin each probe against the real `facet-common.sql`
 * source directly (marisolashgrove on #7429) — the redundancy across four probes
 * means a column rename in the fragment could quietly leave one of them
 * matching nothing while the other three keep the derived set looking correct,
 * and nothing here would notice until a much wider rewrite took the rest with
 * it.
 */
export const FACET_COMMON_PROBES = [
  /\bsd\.session_ended_at >= \$\d+/,
  /\ba\.project_id = \$\d+::uuid/,
  /'has_changes' = ANY\(\$\d+::text\[\]\)/,
  /\bprl\.metadata -> 'linkKinds' \? 'session_pr_set'/,
];

/**
 * Whether `text` matches `probe`. Every probe above is a non-global `RegExp`,
 * but `lastIndex` is reset defensively before each test (tamsinb on #7429)
 * so a future probe declared with a `/g` flag cannot carry state across the
 * `.some()` walk in {@link carriesFacetCommonPredicate} — a global regex's
 * `test()` advances `lastIndex` on a match, which would answer differently for
 * the same text depending on which file was checked immediately before it.
 * Four other regexes in this module are global for exactly this reason and
 * each resets `lastIndex` by hand; this is the same discipline applied here.
 */
function containsProbe(text, probe) {
  probe.lastIndex = 0;
  return probe.test(text);
}

/** Every `.sql` under `prisma/sql` whose text carries the shared facet-common
 * predicate, derived from the tree rather than declared. */
export function statementsCarryingFacetCommon() {
  return new Set(
    readdirSync(sqlDir)
      .filter((name) => name.endsWith(".sql"))
      .filter((name) =>
        carriesFacetCommonPredicate(readFileSync(join(sqlDir, name), "utf8"))
      )
  );
}

export const OPEN = /^(\s*)-- >>> FRAGMENT ([a-z0-9-]+)\b.*$/;
const CLOSE = /^\s*-- <<< FRAGMENT ([a-z0-9-]+)\s*$/;
const TRAILING_NEWLINES = /\n+$/;

function loadFragment(name) {
  const path = join(fragmentDir, `${name}.sql`);
  return readFileSync(path, "utf8").replace(TRAILING_NEWLINES, "").split("\n");
}

/**
 * Rewrites every marked region in `source`. Throws on a malformed region rather
 * than silently leaving it alone — an unclosed marker means the file's real
 * predicate is ambiguous, which must never be resolved by guessing.
 */
/**
 * Index of the line closing the region opened at `start`. Throws rather than
 * returning a sentinel: an unclosed or mismatched marker means the file's real
 * predicate is ambiguous, and that must never be resolved by guessing.
 */
function findRegionEnd(lines, start, name, fileLabel) {
  for (let index = start + 1; index < lines.length; index += 1) {
    const close = CLOSE.exec(lines[index]);
    if (close) {
      if (close[1] !== name) {
        throw new Error(
          `${fileLabel}: FRAGMENT ${name} opened at line ${start + 1} is closed by ${close[1]}`
        );
      }
      return index;
    }
    if (OPEN.test(lines[index])) {
      throw new Error(
        `${fileLabel}: FRAGMENT ${name} at line ${start + 1} is not closed before the next marker`
      );
    }
  }
  throw new Error(
    `${fileLabel}: FRAGMENT ${name} opened at line ${start + 1} is never closed`
  );
}

/** Rewrites every marked region in `source` from its fragment. */
export function expand(source, fileLabel) {
  const lines = source.split("\n");
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const open = OPEN.exec(lines[index]);
    if (!open) {
      out.push(lines[index]);
      index += 1;
      continue;
    }
    const [, indent, name] = open;
    const end = findRegionEnd(lines, index, name, fileLabel);
    out.push(lines[index]);
    for (const line of loadFragment(name)) {
      out.push(line.length === 0 ? "" : `${indent}${line}`);
    }
    out.push(lines[end]);
    index = end + 1;
  }
  return out.join("\n");
}

const DIMENSION_COLUMNS = new Set([
  "assignee_id",
  "repository_full_name",
  "harness",
  "model",
  "project_id",
]);

/**
 * Both dialects a dimension can be compared in: scalar `col = ANY($n::...)`,
 * and set-overlap `cols && $n::...` for a column holding the AGGREGATED set.
 * sessionFacetCounts carries project as a per-session ARRAY so `base` stays one
 * row per session (tamsinb on #6281); without the second alternative this
 * assertion reads that as "no longer compares project_id".
 */
const DIMENSION_COMPARISON =
  /(?:(\w+)\.)?(\w+)\s*(?:=\s*ANY\(|&&\s*)(\$\d+)::/g;

/** The aggregated-set spelling of a dimension column, mapped to the dimension. */
const SET_COLUMN_DIMENSION = new Map([["project_ids", "project_id"]]);

/** Which parameter each dimension column is compared against, by column. */
export function dimensionPairs(source) {
  const pairs = new Map();
  DIMENSION_COMPARISON.lastIndex = 0;
  let match = DIMENSION_COMPARISON.exec(source);
  while (match !== null) {
    const [, , rawColumn, param] = match;
    const column = SET_COLUMN_DIMENSION.get(rawColumn) ?? rawColumn;
    if (DIMENSION_COLUMNS.has(column)) {
      pairs.set(column, param);
    }
    match = DIMENSION_COMPARISON.exec(source);
  }
  return pairs;
}

/** Each counted arm, as the dimension it reports and the flags it applies. */
const FACET_ARM = /SELECT\s+'(\w+)'[\s\S]*?\bWHERE\b([\s\S]*?)\bGROUP BY\b/g;

/** The `matches_*` flag belonging to each arm's OWN dimension. */
const ARM_OWN_FLAG = new Map([
  ["owner", "matches_owner"],
  ["harness", "matches_harness"],
  ["repository", "matches_repository"],
  ["model", "matches_model"],
  ["project", "matches_project"],
]);

const LINE_COMMENT_OPEN = "--";
const BLOCK_COMMENT_OPEN = "/*";
const BLOCK_COMMENT_CLOSE = "*/";

/**
 * `sql` with SQL comments removed, so commented-out text cannot stand in for
 * live predicate text. Two callers need that: a FACET_ARM capture spans
 * comments, so a disabled conjunct still carries the flag's literal, and a
 * `.sql` file's raw text still carries a probe that has been commented out.
 *
 * ISS-9757: one scanner rather than a regex per comment form, because the two
 * forms nest and a pass that ignores that reads text the server has commented as
 * a live predicate — which IS the hole. `-- /*` must not open a block (a regex
 * pass would strip the rest of the clause), `--` inside a block is not a line
 * comment, and blocks NEST exactly as they do in PostgreSQL: closing at the
 * first close marker while the server closes at the last leaves the text
 * between live here and commented there.
 *
 * An unterminated block strips to the end. The server rejects such a file
 * outright, so there is no correct reading to preserve; dropping the rest makes
 * the flags vanish and the guard report them missing, which is the loud failure
 * rather than the silent one.
 *
 * KNOWN BLIND SPOT (ISS-10039): no string-literal tracking. A `/*` inside a
 * quoted SQL string opens a block comment here and eats the rest of the arm,
 * because this scanner does not track whether it is inside a `'...'` literal.
 * Nothing committed under `prisma/sql` does this today. The failure direction
 * is LOUD rather than a silent green, but loud in the direction that gets
 * resolved the wrong way (marisolashgrove on #7429): over-stripping drops probe
 * text out of a required statement's live predicate, so that file falls out
 * of {@link statementsCarryingFacetCommon}, and the set-equality pin this
 * backs reds saying the declared set carries a name the derived tree does not
 * — the SAME red, pointing at the SAME cheap-but-wrong remedy (deleting the
 * name from `STATEMENTS_REQUIRING_A_FRAGMENT`), that the whole probe-keying
 * scheme above exists to make unattractive. Whoever hits this red should
 * suspect a stray `/*` in a quoted literal before reaching for that remedy.
 * Per
 * `scripts/lint/AGENTS.md` guard-policy rule 4, this is recorded rather than
 * fixed speculatively: real string-literal tracking is a small parser, and the
 * fail-loud direction means the cost of the gap is a confusing red, not a
 * missed defect.
 */
function stripSqlComments(sql) {
  let out = "";
  let index = 0;
  let depth = 0;
  while (index < sql.length) {
    if (depth === 0 && sql.startsWith(LINE_COMMENT_OPEN, index)) {
      const newline = sql.indexOf("\n", index);
      if (newline === -1) {
        return out;
      }
      out += "\n";
      index = newline + 1;
    } else if (sql.startsWith(BLOCK_COMMENT_OPEN, index)) {
      depth += 1;
      index += BLOCK_COMMENT_OPEN.length;
    } else if (depth > 0 && sql.startsWith(BLOCK_COMMENT_CLOSE, index)) {
      depth -= 1;
      index += BLOCK_COMMENT_CLOSE.length;
    } else {
      if (depth === 0) {
        out += sql[index];
      }
      index += 1;
    }
  }
  return out;
}

/**
 * ISS-9757: per-flag whole-word matchers, built once at module scope so no regex
 * is constructed inside a function (useTopLevelRegex).
 *
 * `where.includes(flag)` was a RAW SUBSTRING test, which every natural way of
 * disabling a conjunct defeats without tripping it: commenting it out and
 * negating it both leave the literal in the span, so the guard read the flag as
 * applied and the arm silently stopped narrowing.
 */
const FLAG_MENTIONS = new Map(
  [...ARM_OWN_FLAG.values()].map((flag) => [flag, new RegExp(`\\b${flag}\\b`)])
);

/** `NOT` as a keyword, so an identifier that merely contains the letters is not
 * read as one. */
const NOT_KEYWORD = /\bNOT\b/gi;
const LEADING_GROUP_OPEN = /^\s*\(/;
const LEADING_TOKEN = /^\s*[\w$]*/;

/**
 * The text one `NOT` actually negates: the balanced parenthesised group when one
 * opens, otherwise the single token that follows.
 *
 * ISS-9757: the negation is read by SCOPE, not by proximity. `\bNOT\s+<flag>\b`
 * demanded the flag immediately after `NOT`, so a single paren defeated it — but
 * widening the gap to "any characters" swings past the other edge and reads the
 * genuinely applied `matches_model` in `NOT matches_owner AND matches_model` as
 * negated. The scope gets both right, and `NOT (a AND b)` as negating both.
 */
function negatedSpan(clause, start) {
  const rest = clause.slice(start);
  if (LEADING_GROUP_OPEN.exec(rest) === null) {
    const token = LEADING_TOKEN.exec(rest);
    return token === null ? "" : token[0];
  }
  let depth = 0;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "(") {
      depth += 1;
    } else if (rest[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return rest.slice(0, index + 1);
      }
    }
  }
  return rest;
}

function mentionsFlag(clause, flag) {
  return FLAG_MENTIONS.get(flag).test(clause);
}

function negatesFlag(clause, flag) {
  const mention = FLAG_MENTIONS.get(flag);
  NOT_KEYWORD.lastIndex = 0;
  let match = NOT_KEYWORD.exec(clause);
  while (match !== null) {
    if (mention.test(negatedSpan(clause, match.index + match[0].length))) {
      return true;
    }
    match = NOT_KEYWORD.exec(clause);
  }
  return false;
}

/** Every flag problem in ONE arm. Extracted so `facetArmFlagProblems` stays
 * under the cognitive-complexity ceiling. */
function oneArmProblems(dimension, ownFlag, where) {
  const problems = [];
  const clause = stripSqlComments(where);
  if (mentionsFlag(clause, ownFlag)) {
    problems.push(
      `the ${dimension} arm applies its OWN ${ownFlag}; that zeroes every unselected ${dimension} and breaks cross-filtering`
    );
  }
  for (const [other, flag] of ARM_OWN_FLAG) {
    if (other === dimension) {
      continue;
    }
    if (negatesFlag(clause, flag)) {
      problems.push(
        `the ${dimension} arm applies NOT ${flag}; a negated flag inverts the cross-filter instead of applying it`
      );
    } else if (!mentionsFlag(clause, flag)) {
      problems.push(`the ${dimension} arm does not apply ${flag}`);
    }
  }
  return problems;
}

/**
 * The cross-filtering invariant, asserted rather than trusted.
 *
 * Each arm must apply the OTHER four `matches_*` flags and NOT its own. Adding
 * its own turns the facet back into a conjunct: every unselected value drops to
 * zero and the facet stops working for WIDENING a search, which is the whole
 * reason the flag dialect exists (facet-dimensions.sql:6-9).
 *
 * This is checked because it was demonstrably unguarded: marisolashgrove put
 * `matches_owner AND` on the owner arm of #6281 and every check in the repo
 * still passed, including this file's parameter pairing.
 */
export function facetArmFlagProblems(source) {
  const problems = [];
  const seen = new Set();
  FACET_ARM.lastIndex = 0;
  let match = FACET_ARM.exec(source);
  while (match !== null) {
    const [, dimension, where] = match;
    const ownFlag = ARM_OWN_FLAG.get(dimension);
    if (ownFlag !== undefined) {
      seen.add(dimension);
      problems.push(...oneArmProblems(dimension, ownFlag, where));
    }
    match = FACET_ARM.exec(source);
  }
  for (const dimension of ARM_OWN_FLAG.keys()) {
    if (!seen.has(dimension)) {
      problems.push(`sessionFacetCounts.sql has no ${dimension} arm`);
    }
  }
  return problems;
}

/**
 * sessionFacetCounts cannot take facet-dimensions.sql as conjuncts — it needs
 * the flag dialect so each arm can relax its OWN dimension (cross-filtering) —
 * so the splicer cannot keep the two in step by expansion. This asserts the part
 * that MUST agree: which column each dimension parameter is compared against. A
 * renumbering that pointed `harness` at the models parameter would otherwise
 * pass every other check in the repo and silently return the wrong counts.
 *
 * `project_id` is compared through the statement's own lateral (`linked.`) and
 * the fragment's EXISTS (`pd.`), so the qualifier is dropped before comparing —
 * the column and the parameter are what has to match, not the alias.
 */
export function assertFacetCountPairing() {
  const fragment = dimensionPairs(
    readFileSync(join(fragmentDir, "facet-dimensions.sql"), "utf8")
  );
  const counts = dimensionPairs(
    readFileSync(join(sqlDir, "sessionFacetCounts.sql"), "utf8")
  );
  const problems = [];
  for (const column of DIMENSION_COLUMNS) {
    const expected = fragment.get(column);
    const actual = counts.get(column);
    if (expected === undefined) {
      problems.push(`facet-dimensions.sql no longer compares ${column}`);
    } else if (actual === undefined) {
      problems.push(`sessionFacetCounts.sql no longer compares ${column}`);
    } else if (expected !== actual) {
      problems.push(
        `${column}: facet-dimensions.sql uses ${expected}, sessionFacetCounts.sql uses ${actual}`
      );
    }
  }
  problems.push(
    ...facetArmFlagProblems(
      readFileSync(join(sqlDir, "sessionFacetCounts.sql"), "utf8")
    )
  );
  return problems;
}

/**
 * Whether `sql` carries the facet-common predicate as LIVE text.
 *
 * ISS-9757, davetho on #7035: the probe test read the file RAW, so the
 * set-equality pin it feeds treated a comment as predicate evidence. Strip a
 * required statement's markers and its real `facet-common` predicate but leave
 * `-- sd.session_ended_at >= $5` (or a block-commented probe) behind, and the
 * derived set still contained that file — so the pin stayed green while the
 * floor it exists to arm had been removed. Same defect class as the raw
 * `where.includes(flag)` above, one layer out.
 *
 * Comments are stripped HERE and nowhere else on this path. `expand` and the
 * OPEN/CLOSE marker regexes are driven BY comment lines (`-- >>> FRAGMENT`), so
 * a stripping pass that reached them would delete the region boundaries and
 * break splicing outright. The probes are predicate text in every committed
 * statement, so they survive the strip.
 */
export function carriesFacetCommonPredicate(sql) {
  const live = stripSqlComments(sql);
  return FACET_COMMON_PROBES.some((probe) => containsProbe(live, probe));
}
