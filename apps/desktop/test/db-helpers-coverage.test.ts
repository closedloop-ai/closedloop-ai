/**
 * @file db-helpers-coverage.test.ts
 * @description ISS-8730 — coverage sweep for the pure helpers in
 * db-helpers.ts that had no direct unit coverage: value coercion
 * (`strOf`/`nonEmptyString`/`safeJsonParse`/`numberFromUnknown`), SQL-text
 * builders, GitHub URL/repo parsing, id/title formatting, ISO-date
 * comparison, truncation, LIKE escaping, token-count coercion, and the
 * dashboard page-window clamp.
 *
 * `numberOrZero`/`nullableNumber` (db-helpers-number-or-zero.test.ts),
 * `readZoneLessAsUtc` (db-helpers-zone-less.test.ts),
 * `formatLocalDayKey`/`localCutoffDay` (db-helpers-local-day.test.ts), and
 * `PLUGIN_CHILD_KINDS_SQL_LIST` (plugin-child-kinds-sql.test.ts) already have
 * dedicated suites and are deliberately not re-covered here.
 */
import assert from "node:assert/strict";
import {
  ArtifactRefRelation,
  PR_INT_MAX,
  REPOSITORY_FULL_NAME_MAX_LENGTH,
} from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import { InvalidTokenCountError } from "../src/main/cost/token-counts.js";
import type { TokenUsageCounts } from "../src/main/dashboard/agent-dashboard-db-types.js";
import {
  boundedNonNegativeInt,
  coerceDashboardListWindow,
  compareIsoDesc,
  compareLastUsedThenName,
  createdArtifactLinksSubquery,
  escapeSqliteLikePattern,
  GitHubPrUrlRefusal,
  localDay,
  localHour,
  localTimeZone,
  maxIso,
  minIso,
  nonEmptyString,
  normalizeRepoFullName,
  normalizeTokenUsageCounts,
  numberFromUnknown,
  optionalTokenCountValue,
  packIdFromSkillName,
  parseGitHubPrUrl,
  safe,
  safeJsonParse,
  strOf,
  titleFromId,
  titleFromPlan,
  toCanonicalIso,
  tokenCountValue,
  toolInvocationPredicate,
  truncate,
  validIso,
} from "../src/main/database/db-helpers.js";

// ---------------------------------------------------------------------------
// strOf
// ---------------------------------------------------------------------------

test("strOf returns a non-empty string unchanged", () => {
  assert.equal(strOf("hello"), "hello");
  assert.equal(strOf(" padded "), " padded "); // no trimming — that's nonEmptyString's job
});

test("strOf returns undefined for an empty string", () => {
  assert.equal(strOf(""), undefined);
});

test("strOf returns undefined for any non-string value", () => {
  for (const value of [42, null, undefined, true, {}, [], Symbol("x")]) {
    assert.equal(
      strOf(value),
      undefined,
      `expected ${String(value)} to be undefined`
    );
  }
});

// ---------------------------------------------------------------------------
// nonEmptyString
// ---------------------------------------------------------------------------

test("nonEmptyString trims and returns a string with real content", () => {
  assert.equal(nonEmptyString("  hello  "), "hello");
  assert.equal(nonEmptyString("hello"), "hello");
});

test("nonEmptyString returns undefined for whitespace-only input", () => {
  for (const value of [" ", "\t", "\n", "   \n\t  ", ""]) {
    assert.equal(nonEmptyString(value), undefined);
  }
});

test("nonEmptyString returns undefined for any non-string value", () => {
  for (const value of [42, null, undefined, true, {}, []]) {
    assert.equal(nonEmptyString(value), undefined);
  }
});

// ---------------------------------------------------------------------------
// safeJsonParse
// ---------------------------------------------------------------------------

test("safeJsonParse parses a valid JSON object", () => {
  assert.deepEqual(safeJsonParse('{"a":1,"b":"two"}'), { a: 1, b: "two" });
});

test("safeJsonParse returns null for malformed JSON text", () => {
  assert.equal(safeJsonParse("{not valid json"), null);
  assert.equal(safeJsonParse(""), null);
});

test("safeJsonParse returns null for valid JSON that is not an object", () => {
  // asRecord rejects arrays and primitives — only a plain object record passes.
  assert.equal(safeJsonParse("[1,2,3]"), null);
  assert.equal(safeJsonParse('"just a string"'), null);
  assert.equal(safeJsonParse("42"), null);
  assert.equal(safeJsonParse("true"), null);
  assert.equal(safeJsonParse("null"), null);
});

// ---------------------------------------------------------------------------
// numberFromUnknown
// ---------------------------------------------------------------------------

test("numberFromUnknown accepts a positive integer number as-is", () => {
  assert.equal(numberFromUnknown(1), 1);
  assert.equal(numberFromUnknown(42), 42);
});

test("numberFromUnknown rejects a number that is zero, negative, or fractional", () => {
  for (const value of [0, -1, -42, 1.5, -1.5]) {
    assert.equal(
      numberFromUnknown(value),
      null,
      `expected ${value} to be null`
    );
  }
});

// Pinning current behavior: the NUMBER branch checks Number.isInteger, not
// Number.isSafeInteger, so a huge (unsafe) integer-valued number passes
// through unvalidated — unlike the STRING branch below, which does apply the
// safe-integer check. This asymmetry is a real property of the source today.
test("numberFromUnknown does not safe-integer-check a number input, only a string input", () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 2; // still Number.isInteger() === true
  assert.equal(numberFromUnknown(unsafe), unsafe);
  assert.equal(numberFromUnknown(String(unsafe)), null);
});

test("numberFromUnknown converts a digit-only string to a number", () => {
  assert.equal(numberFromUnknown("1"), 1);
  assert.equal(numberFromUnknown("42"), 42);
  // Leading zeros are consumed by Number() — pinning the current behavior.
  assert.equal(numberFromUnknown("007"), 7);
});

test("numberFromUnknown rejects a string that is not all decimal digits", () => {
  for (const value of [
    "0",
    "-5",
    "1.5",
    "1e3",
    " 1",
    "1 ",
    "abc",
    "12abc",
    "",
  ]) {
    assert.equal(
      numberFromUnknown(value),
      null,
      `expected "${value}" to be null`
    );
  }
});

test("numberFromUnknown rejects any other type", () => {
  for (const value of [null, undefined, true, {}, [], Symbol("x")]) {
    assert.equal(numberFromUnknown(value), null);
  }
});

// ---------------------------------------------------------------------------
// localDay / localHour — SQL text builders
// ---------------------------------------------------------------------------

test("localDay renders the local-timezone day bucket expression for a column", () => {
  assert.equal(
    localDay("s.started_at"),
    "strftime('%Y-%m-%d', s.started_at, 'localtime')"
  );
});

test("localHour renders the local-timezone hour bucket expression for a column", () => {
  assert.equal(
    localHour("s.started_at"),
    "CAST(strftime('%H', s.started_at, 'localtime') AS INTEGER)"
  );
});

// ---------------------------------------------------------------------------
// createdArtifactLinksSubquery
// ---------------------------------------------------------------------------

test("createdArtifactLinksSubquery renders a DISTINCT id subquery filtered on the 'created' relation", () => {
  const sql = createdArtifactLinksSubquery();
  assert.ok(
    sql.includes("SELECT DISTINCT artifact_id FROM session_artifact_links")
  );
  assert.ok(sql.includes(`relation = '${ArtifactRefRelation.Created}'`));
});

// ---------------------------------------------------------------------------
// boundedNonNegativeInt
// ---------------------------------------------------------------------------

test("boundedNonNegativeInt passes through an in-range non-negative integer", () => {
  assert.equal(boundedNonNegativeInt(0), 0);
  assert.equal(boundedNonNegativeInt(42), 42);
  assert.equal(boundedNonNegativeInt(PR_INT_MAX), PR_INT_MAX); // inclusive upper bound
});

test("boundedNonNegativeInt rejects null, negative, fractional, and over-max values", () => {
  assert.equal(boundedNonNegativeInt(null), undefined);
  assert.equal(boundedNonNegativeInt(-1), undefined);
  assert.equal(boundedNonNegativeInt(1.5), undefined);
  assert.equal(boundedNonNegativeInt(PR_INT_MAX + 1), undefined);
});

// ---------------------------------------------------------------------------
// parseGitHubPrUrl
// ---------------------------------------------------------------------------

test("parseGitHubPrUrl extracts the repo and PR number from a well-formed URL", () => {
  assert.deepEqual(
    parseGitHubPrUrl(
      "https://github.com/closedloop-ai/closedloop-ai/pull/1234"
    ),
    { ok: true, repoFullName: "closedloop-ai/closedloop-ai", number: 1234 }
  );
});

test("parseGitHubPrUrl tolerates a trailing slash on the PR URL", () => {
  assert.deepEqual(parseGitHubPrUrl("https://github.com/owner/repo/pull/5/"), {
    ok: true,
    repoFullName: "owner/repo",
    number: 5,
  });
});

test("parseGitHubPrUrl refuses a non-github.com host as not-a-PR-URL", () => {
  assert.deepEqual(parseGitHubPrUrl("https://gitlab.com/owner/repo/pull/5"), {
    ok: false,
    refusal: GitHubPrUrlRefusal.NotAPrUrl,
  });
});

test("parseGitHubPrUrl refuses a path that is not an owner/repo/pull/N shape as not-a-PR-URL", () => {
  const notAPrUrl = {
    ok: false,
    refusal: GitHubPrUrlRefusal.NotAPrUrl,
  };
  // wrong type segment (issue, not pull)
  assert.deepEqual(
    parseGitHubPrUrl("https://github.com/owner/repo/issues/5"),
    notAPrUrl
  );
  // missing the pull number entirely
  assert.deepEqual(
    parseGitHubPrUrl("https://github.com/owner/repo/pull"),
    notAPrUrl
  );
  // missing repo segment
  assert.deepEqual(parseGitHubPrUrl("https://github.com/owner"), notAPrUrl);
  // non-numeric PR number
  assert.deepEqual(
    parseGitHubPrUrl("https://github.com/owner/repo/pull/abc"),
    notAPrUrl
  );
});

test("parseGitHubPrUrl refuses an unparseable URL string as not-a-PR-URL", () => {
  assert.deepEqual(parseGitHubPrUrl("not a url"), {
    ok: false,
    refusal: GitHubPrUrlRefusal.NotAPrUrl,
  });
});

// ISS-8882: the ONE refusal a caller must tell apart, because it is the only
// one that names a real repository this store cannot hold — so falling back to
// the session's own repo would file the PR somewhere the URL never said.
test("parseGitHubPrUrl names an over-bound owner/repo slug apart from every other refusal", () => {
  const overBound = `acme/${"a".repeat(REPOSITORY_FULL_NAME_MAX_LENGTH)}`;
  assert.deepEqual(parseGitHubPrUrl(`https://github.com/${overBound}/pull/7`), {
    ok: false,
    refusal: GitHubPrUrlRefusal.RepoPastWireBound,
  });
});

// ---------------------------------------------------------------------------
// normalizeRepoFullName
// ---------------------------------------------------------------------------

test("normalizeRepoFullName trims and returns a valid owner/repo slug", () => {
  assert.equal(normalizeRepoFullName("  owner/repo  "), "owner/repo");
  assert.equal(normalizeRepoFullName("my.org/my-repo_2"), "my.org/my-repo_2");
});

test("normalizeRepoFullName rejects a slug with no slash, an extra path segment, or a non-string", () => {
  for (const value of [
    "ownerrepo",
    "owner/repo/extra",
    "owner//repo",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(
      normalizeRepoFullName(value),
      null,
      `expected ${String(value)} to be null`
    );
  }
});

// ---------------------------------------------------------------------------
// packIdFromSkillName
// ---------------------------------------------------------------------------

test("packIdFromSkillName splits on the first slash or colon separator", () => {
  assert.equal(packIdFromSkillName("mypack/my-skill"), "mypack");
  assert.equal(packIdFromSkillName("mypack:my-skill"), "mypack");
  // first separator wins even when a second one follows.
  assert.equal(packIdFromSkillName("mypack/nested/skill"), "mypack");
});

test("packIdFromSkillName trims the name before searching for a separator", () => {
  assert.equal(packIdFromSkillName("  mypack/my-skill  "), "mypack");
});

test("packIdFromSkillName returns null when there is no separator or it is the first character", () => {
  assert.equal(packIdFromSkillName("no-separator-here"), null);
  assert.equal(packIdFromSkillName("/leading-separator"), null);
  assert.equal(packIdFromSkillName(":leading-separator"), null);
});

// ---------------------------------------------------------------------------
// titleFromId
// ---------------------------------------------------------------------------

test("titleFromId title-cases each word-separator-delimited segment", () => {
  assert.equal(titleFromId("my-id_word test"), "My Id Word Test");
  assert.equal(titleFromId("single"), "Single");
});

test("titleFromId collapses runs of separators and trims leading/trailing ones", () => {
  assert.equal(titleFromId("--my__id//word"), "My Id Word");
});

// Pinning current behavior: an id that is ALL separators produces an empty
// word list, and the `|| id` fallback then returns the id VERBATIM
// (un-title-cased), not an empty string.
test("titleFromId falls back to the raw id when it contains no word characters", () => {
  assert.equal(titleFromId("---"), "---");
  assert.equal(titleFromId(""), "");
});

// ---------------------------------------------------------------------------
// titleFromPlan
// ---------------------------------------------------------------------------

test("titleFromPlan strips a leading markdown heading and returns the first non-blank line", () => {
  assert.equal(
    titleFromPlan("# My Plan Title\n\nBody text here."),
    "My Plan Title"
  );
  assert.equal(
    titleFromPlan("### Deeply Nested Heading\nBody"),
    "Deeply Nested Heading"
  );
});

test("titleFromPlan skips leading blank lines and handles CRLF line breaks", () => {
  assert.equal(titleFromPlan("\r\n\r\n# Title\r\nBody"), "Title");
});

test("titleFromPlan falls back to 'Untitled plan' when every line is blank", () => {
  assert.equal(titleFromPlan(""), "Untitled plan");
  assert.equal(titleFromPlan("   \n\n  \n"), "Untitled plan");
});

test("titleFromPlan truncates a first line longer than 80 characters with an ellipsis", () => {
  const longLine = "x".repeat(90);
  const result = titleFromPlan(longLine);
  assert.equal(result.length, 80);
  assert.equal(result, `${"x".repeat(77)}...`);
});

test("titleFromPlan leaves an 80-character first line untouched", () => {
  const exactLine = "x".repeat(80);
  assert.equal(titleFromPlan(exactLine), exactLine);
});

// ---------------------------------------------------------------------------
// compareIsoDesc / validIso / maxIso / minIso
// ---------------------------------------------------------------------------

test("compareIsoDesc orders the more recent timestamp first (negative result)", () => {
  const newer = "2026-06-20T00:00:00.000Z";
  const older = "2026-06-01T00:00:00.000Z";
  assert.ok(compareIsoDesc(newer, older) < 0);
  assert.ok(compareIsoDesc(older, newer) > 0);
  assert.equal(compareIsoDesc(newer, newer), 0);
});

test("compareIsoDesc treats null and unparseable timestamps as epoch (oldest)", () => {
  const real = "2026-06-20T00:00:00.000Z";
  assert.ok(
    compareIsoDesc(real, null) < 0,
    "a real timestamp sorts before null"
  );
  assert.ok(
    compareIsoDesc(null, real) > 0,
    "null sorts after a real timestamp"
  );
  assert.equal(compareIsoDesc(null, null), 0);
  assert.equal(compareIsoDesc("not-a-date", "also-not-a-date"), 0);
});

test("validIso returns a parseable timestamp unchanged", () => {
  assert.equal(
    validIso("2026-06-20T00:00:00.000Z"),
    "2026-06-20T00:00:00.000Z"
  );
});

test("validIso returns null for unparseable or missing input", () => {
  assert.equal(validIso("not-a-date"), null);
  assert.equal(validIso(""), null);
  assert.equal(validIso(null), null);
  assert.equal(validIso(undefined), null);
});

test("maxIso returns whichever timestamp is chronologically later", () => {
  const newer = "2026-06-20T00:00:00.000Z";
  const older = "2026-06-01T00:00:00.000Z";
  assert.equal(maxIso(newer, older), newer);
  assert.equal(maxIso(older, newer), newer);
});

test("maxIso treats a null operand as older than any real timestamp", () => {
  const real = "2026-06-20T00:00:00.000Z";
  assert.equal(maxIso(real, null), real);
  assert.equal(maxIso(null, real), real);
  assert.equal(maxIso(null, null), null);
});

test("minIso returns whichever timestamp is chronologically earlier", () => {
  const newer = "2026-06-20T00:00:00.000Z";
  const older = "2026-06-01T00:00:00.000Z";
  assert.equal(minIso(newer, older), older);
  assert.equal(minIso(older, newer), older);
});

test("minIso returns the non-null operand when one side is null", () => {
  const real = "2026-06-20T00:00:00.000Z";
  assert.equal(minIso(real, null), real);
  assert.equal(minIso(null, real), real);
  assert.equal(minIso(null, null), null);
});

// ---------------------------------------------------------------------------
// toCanonicalIso
// ---------------------------------------------------------------------------

test("toCanonicalIso reformats a parseable timestamp to canonical UTC 'Z' form", () => {
  assert.equal(
    toCanonicalIso("2026-06-18T08:00:00.000Z"),
    "2026-06-18T08:00:00.000Z"
  );
  // An offset-form input re-expresses to the SAME instant in canonical UTC.
  assert.equal(
    toCanonicalIso("2026-06-18T10:00:00.000+02:00"),
    "2026-06-18T08:00:00.000Z"
  );
});

test("toCanonicalIso returns an unparseable value unchanged", () => {
  assert.equal(toCanonicalIso("not-a-timestamp"), "not-a-timestamp");
  assert.equal(toCanonicalIso(""), "");
});

// ---------------------------------------------------------------------------
// compareLastUsedThenName
// ---------------------------------------------------------------------------

test("compareLastUsedThenName sorts by lastUsedAt descending first", () => {
  const newer = { name: "b", lastUsedAt: "2026-06-20T00:00:00.000Z" };
  const older = { name: "a", lastUsedAt: "2026-06-01T00:00:00.000Z" };
  assert.ok(compareLastUsedThenName(newer, older) < 0);
  assert.ok(compareLastUsedThenName(older, newer) > 0);
});

test("compareLastUsedThenName falls back to name ascending when lastUsedAt ties", () => {
  const a = { name: "alpha", lastUsedAt: null };
  const b = { name: "beta", lastUsedAt: null };
  assert.ok(compareLastUsedThenName(a, b) < 0);
  assert.ok(compareLastUsedThenName(b, a) > 0);
  assert.equal(compareLastUsedThenName(a, a), 0);
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

test("truncate slices a string longer than max, with no ellipsis appended", () => {
  assert.equal(truncate("abcdefgh", 5), "abcde");
});

test("truncate returns a string at or under max unchanged", () => {
  assert.equal(truncate("abcde", 5), "abcde");
  assert.equal(truncate("abc", 5), "abc");
});

test("truncate returns null for a non-string or empty-string value", () => {
  assert.equal(truncate(null, 5), null);
  assert.equal(truncate(undefined, 5), null);
  assert.equal(truncate("", 5), null);
});

// ---------------------------------------------------------------------------
// safe
// ---------------------------------------------------------------------------

test("safe returns the function's return value when it does not throw", () => {
  assert.equal(
    safe(() => 42),
    42
  );
});

test("safe returns undefined when the function throws", () => {
  assert.equal(
    safe(() => {
      throw new Error("boom");
    }),
    undefined
  );
});

// ---------------------------------------------------------------------------
// escapeSqliteLikePattern
// ---------------------------------------------------------------------------

test("escapeSqliteLikePattern backslash-escapes %, _, and \\", () => {
  assert.equal(escapeSqliteLikePattern("100%"), "100\\%");
  assert.equal(escapeSqliteLikePattern("a_b"), "a\\_b");
  assert.equal(escapeSqliteLikePattern("a\\b"), "a\\\\b");
  assert.equal(escapeSqliteLikePattern("50%_off\\sale"), "50\\%\\_off\\\\sale");
});

test("escapeSqliteLikePattern leaves a string with no LIKE metacharacters unchanged", () => {
  assert.equal(escapeSqliteLikePattern("plain text"), "plain text");
});

// ---------------------------------------------------------------------------
// tokenCountValue / optionalTokenCountValue
// ---------------------------------------------------------------------------

test("tokenCountValue reads a valid safe non-negative integer", () => {
  assert.equal(tokenCountValue(42, "input_tokens"), 42);
  assert.equal(tokenCountValue(0, "input_tokens"), 0);
});

test("tokenCountValue treats a missing value as 0", () => {
  assert.equal(tokenCountValue(null, "input_tokens"), 0);
  assert.equal(tokenCountValue(undefined, "input_tokens"), 0);
});

test("tokenCountValue throws InvalidTokenCountError for a negative or fractional value", () => {
  assert.throws(
    () => tokenCountValue(-1, "input_tokens"),
    InvalidTokenCountError
  );
  assert.throws(
    () => tokenCountValue(1.5, "input_tokens"),
    InvalidTokenCountError
  );
});

test("optionalTokenCountValue keeps a missing value as null instead of 0", () => {
  assert.equal(optionalTokenCountValue(null, "input_tokens"), null);
  assert.equal(optionalTokenCountValue(undefined, "input_tokens"), null);
});

test("optionalTokenCountValue reads a valid present value", () => {
  assert.equal(optionalTokenCountValue(7, "input_tokens"), 7);
});

test("optionalTokenCountValue throws InvalidTokenCountError for an out-of-range present value", () => {
  assert.throws(
    () => optionalTokenCountValue(-1, "input_tokens"),
    InvalidTokenCountError
  );
});

// ---------------------------------------------------------------------------
// normalizeTokenUsageCounts
// ---------------------------------------------------------------------------

test("normalizeTokenUsageCounts validates each of the four counters through tokenCountValue", () => {
  const counts: TokenUsageCounts = {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: null as unknown as number, // missing storage value: validated to 0
  };
  assert.deepEqual(normalizeTokenUsageCounts(counts, "ctx"), {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("normalizeTokenUsageCounts includes a normalized cacheWriteTtl only when the input carries one", () => {
  const withTtl: TokenUsageCounts = {
    input: 1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
    cacheWriteTtl: { fiveM: 5, oneH: 10 },
  };
  assert.deepEqual(normalizeTokenUsageCounts(withTtl, "ctx").cacheWriteTtl, {
    fiveM: 5,
    oneH: 10,
  });

  const withoutTtl: TokenUsageCounts = {
    input: 1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
  };
  assert.equal(
    "cacheWriteTtl" in normalizeTokenUsageCounts(withoutTtl, "ctx"),
    false
  );
});

// Pinning current behavior: the function's return type is the four counters
// plus an optional cacheWriteTtl — it does not forward the `inferred` flag
// even though `TokenUsageCounts` carries one, so a caller passing `inferred`
// through this helper silently loses it.
test("normalizeTokenUsageCounts drops the inferred flag rather than passing it through", () => {
  const counts: TokenUsageCounts = {
    input: 1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
    inferred: true,
  };
  const normalized = normalizeTokenUsageCounts(counts, "ctx");
  assert.equal("inferred" in normalized, false);
});

test("normalizeTokenUsageCounts throws when a counter is invalid", () => {
  const counts: TokenUsageCounts = {
    input: -1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
  };
  assert.throws(
    () => normalizeTokenUsageCounts(counts, "ctx"),
    InvalidTokenCountError
  );
});

// ---------------------------------------------------------------------------
// toolInvocationPredicate
// ---------------------------------------------------------------------------

test("toolInvocationPredicate renders a parenthesized NOT-NULL-AND-NOT-EMPTY predicate", () => {
  assert.equal(
    toolInvocationPredicate("events.tool_name"),
    "(events.tool_name IS NOT NULL AND events.tool_name <> '')"
  );
});

// ---------------------------------------------------------------------------
// localTimeZone
// ---------------------------------------------------------------------------

test("localTimeZone returns the host's resolved IANA timezone", () => {
  const expected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(localTimeZone(), expected);
  assert.ok(localTimeZone().length > 0);
});

test("localTimeZone falls back to 'UTC' when Intl throws", () => {
  const original = globalThis.Intl;
  const globalWithIntl = globalThis as unknown as { Intl: typeof Intl };
  globalWithIntl.Intl = {
    DateTimeFormat() {
      throw new Error("Intl unavailable");
    },
  } as unknown as typeof Intl;
  try {
    assert.equal(localTimeZone(), "UTC");
  } finally {
    globalThis.Intl = original;
  }
});

// ---------------------------------------------------------------------------
// coerceDashboardListWindow
// ---------------------------------------------------------------------------

test("coerceDashboardListWindow defaults to maxLimit/0 when opts is undefined", () => {
  assert.deepEqual(coerceDashboardListWindow(undefined, 50), {
    limit: 50,
    offset: 0,
  });
});

test("coerceDashboardListWindow passes through in-range integer values", () => {
  assert.deepEqual(coerceDashboardListWindow({ limit: 20, offset: 40 }, 50), {
    limit: 20,
    offset: 40,
  });
});

test("coerceDashboardListWindow floors limit at 1 and offset at 0", () => {
  assert.deepEqual(coerceDashboardListWindow({ limit: 0, offset: -10 }, 50), {
    limit: 1,
    offset: 0,
  });
  assert.deepEqual(coerceDashboardListWindow({ limit: -5, offset: -1 }, 50), {
    limit: 1,
    offset: 0,
  });
});

test("coerceDashboardListWindow caps limit at maxLimit", () => {
  assert.deepEqual(coerceDashboardListWindow({ limit: 9999 }, 50), {
    limit: 50,
    offset: 0,
  });
});

test("coerceDashboardListWindow truncates a fractional limit toward the request rather than defaulting it", () => {
  // 33.33 truncates to 33 — a NARROW malformed request must not silently
  // widen to the full-page default (this was the ISS-6451 bug).
  assert.deepEqual(coerceDashboardListWindow({ limit: 33.33 }, 100), {
    limit: 33,
    offset: 0,
  });
});

test("coerceDashboardListWindow truncates a fractional offset", () => {
  assert.deepEqual(coerceDashboardListWindow({ offset: 12.9 }, 50), {
    limit: 50,
    offset: 12,
  });
});

test("coerceDashboardListWindow defaults limit and offset when they are absent, NaN, or non-finite", () => {
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    assert.equal(coerceDashboardListWindow({ limit }, 50).limit, 50);
  }
  for (const offset of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    assert.equal(coerceDashboardListWindow({ offset }, 50).offset, 0);
  }
});

test("coerceDashboardListWindow caps a finite offset beyond MAX_SAFE_INTEGER rather than defaulting it to 0", () => {
  const huge = 1e20; // finite per Number.isFinite, but far beyond MAX_SAFE_INTEGER
  assert.equal(
    coerceDashboardListWindow({ offset: huge }, 50).offset,
    Number.MAX_SAFE_INTEGER
  );
});
