/**
 * @file artifact-ref-command-patterns.ts
 * @description The `gh pr …` COMMAND-POSITION patterns the artifact-ref
 * extractor gates on, and the anchor prefix all three build from.
 *
 * Extracted from `artifact-ref-extractor.ts` (ISS-6003) because they are one
 * cohesive unit with one invariant — the anchor must be identical across them,
 * and it must scan linearly — and because that file is over the 1,000-line
 * ceiling and the direction of travel is down.
 */

/**
 * The COMMAND-POSITION anchor every `gh pr …` pattern below shares: a line or
 * `;&|(` start, then optional `KEY=value` env assignments. Declared once because
 * the three patterns are meant to be identical here — the comments used to say
 * they "mirror" each other, which is a spelling that can drift.
 *
 * ISS-6003 — a db-host CPU profile of a boot import against a real 2 GB store
 * attributed 45% of the WHOLE process to this one pattern, under
 * `isPrReviewCommand` ← `extractArtifactRefs` ← `buildImportSessionContext`. Two
 * independent blowups live in the shape it used to have,
 * `(?:^|[;&|(\n\t])\s*(?:\S+=\S+\s+)*`, and both are fixed here:
 *
 *  1. `\S+=\S+` lets a token carrying several `=` split at any one of them, so
 *     each repetition has a choice and the engine explores their product before
 *     it can fail. Ten `a=b=c=d=e=f=g=h` tokens cost **13,521 ms** for one
 *     `.test()`. `[^\s=]+` stops at the first `=`, so each repetition matches
 *     exactly one way. The VALUE is still `\S+`, so `OPTS=a=b=c` is an
 *     assignment exactly as before. The one accepted-set difference is a token
 *     whose FIRST `=` is at index 0 — `=a=b`, `====` — which `\S+=\S+` consumed
 *     as an assignment and this does not. Those are not assignments in any
 *     shell, so nothing real is lost; they are asserted in the test because a
 *     deterministic verdict is what pins this narrowing, a duration is not.
 *
 *  2. The bigger one, and the reason fixing (1) alone did not move the profile:
 *     the pattern is unanchored, so V8 restarts it at every `;&|(`, tab, and
 *     NEWLINE — and an unbounded `*` then walks the assignment group from each
 *     one to the end of the input. A heredoc writing `KEY=value` lines is
 *     therefore quadratic: 500 lines cost 7 ms, 8,000 lines **4,617 ms**, for a
 *     single `.test()`. Bounding the repetition makes each restart O(1) and the
 *     whole scan linear — the same 8,000-line input drops to 4.8 ms, and 32,000
 *     lines (617 KB) to 21 ms.
 *
 * The bound is a real, if remote, narrowing: a command with MORE than
 * {@link MAX_ENV_ASSIGNMENT_PREFIX} env assignments before `gh pr …` no longer
 * classifies. A shell env-assignment prefix is a handful of tokens in practice
 * (`GH_TOKEN=… PAGER=cat gh pr view 42`), so this trades a case nobody writes
 * for a bound on a case transcripts produce constantly.
 */
export const MAX_ENV_ASSIGNMENT_PREFIX = 8;
const SHELL_COMMAND_POSITION_PREFIX = String.raw`(?:^|[;&|(\n\t])\s*(?:[^\s=]+=\S+\s+){0,${MAX_ENV_ASSIGNMENT_PREFIX}}`;

// The ONE `gh pr create` pattern the parsing lane may use, enforced by the
// `no-private-gh-pr-create-matcher` source gate — the comment that used to
// assert this could not, and a second, unanchored copy lived in the extractor
// itself for two releases (ISS-8336), minting branch records for `gh pr create`
// text a session only ever MENTIONED.
//
// Callers test it AFTER stripQuotedContent. The command-position anchor is the
// second, independent defence: it rejects a mention that quote-stripping cannot
// blank — an unquoted doc line (`echo Reminder: gh pr create --head x`), or a
// heredoc runbook line (`Then run gh pr create --head x`) — because the mention
// is SPACE-PRECEDED rather than line-/`;&|(`-anchored. A false negative here is
// safe; a false positive fabricates a record.
//
// A heredoc BODY LINE that is itself line-initial
// (`cat <<EOF\ngh pr create --head x\nEOF`) is indistinguishable from a real
// invocation by position alone, so this pattern still accepts it — and does not
// need to. ISS-8473 neutralizes heredoc bodies one layer earlier, in
// `findNeutralizedSpans`, so the body never reaches any command-shape gate;
// that fix applies equally to `git push` / `git checkout -b` / the commit
// patterns, which minted from the same shape and predate ISS-8336
// (codex-connector, PR #6180).
export const GH_PR_CREATE_REGEX = new RegExp(
  `${SHELL_COMMAND_POSITION_PREFIX}gh\\s+pr\\s+create(?:$|[\\s'"])`
);

// FEA-3585: `gh pr` REVIEW subcommands that operate on a SPECIFIC PR the session
// is reviewing (vs `create`, which authors one). The command-position anchor
// (line/`;&|(` start, optional env assignments) mirrors GH_PR_CREATE_REGEX so an
// `echo "gh pr view 5"` mention does not classify as a review. `merge` is
// intentionally excluded — merging is a landing action on your own PR, not a
// review of someone else's. The reviewed PR's identity (a bare number or a
// github.com URL) is resolved separately from the command tail after this gate,
// so flags between the subcommand and the positional don't need matching here.
export const GH_PR_REVIEW_CMD_RE = new RegExp(
  `${SHELL_COMMAND_POSITION_PREFIX}gh\\s+pr\\s+(?:view|diff|review|checkout|comment)\\b`
);
export const GH_PR_FEEDBACK_WRITE_CMD_RE = new RegExp(
  `${SHELL_COMMAND_POSITION_PREFIX}gh\\s+pr\\s+(?:review|comment)\\b`
);
