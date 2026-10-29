/**
 * @file artifact-ref-extractor-version.ts
 * @description The artifact-reference extractor's version constant and its
 * changelog, split out of `artifact-ref-extractor.ts` (ISS-7258).
 *
 * Same shape as `engine/data-revision.ts`, and for the same reason: the constant
 * is small and the history behind it is not, so keeping the two together buries
 * the extractor's actual logic under ~200 lines of prose that only ever grows.
 * The history is load-bearing rather than decorative — each entry records WHY a
 * bump re-derives already-imported sessions, which is the only way to tell a
 * legitimate bump from one that silently strands persisted rows.
 *
 * Bump policy lives in `apps/desktop/AGENTS.md` under "Idempotent Re-Processing:
 * Revision Constants". In short: bump when extraction semantics change (new
 * artifact kinds, relation classification, patterns, confidence), and add an
 * entry below saying what re-derives and why.
 */

// PRD-486: bumped 2 → 3 for the new GIT_COMMIT_SUBJECT_RE regex and the commit
// `message`/`committedAt` fields. The bump makes the backfill re-derive already-
// imported sessions, so their pre-existing commit artifacts get committed_at/title
// filled (otherwise they stay NULL and never render a rail dot). Per AGENTS.md
// §Idempotent Re-Processing, EXTRACTOR_VERSION must bump when a new regex is added.
// Bumped 3 → 4: 'created' PR refs now carry the head branch active at `gh pr
// create` time (NormalizedToolUse.gitBranch), so the backfill re-derives links
// and PR head-ref attribution for already-imported sessions.
// Bumped 4 → 5: multi-harness shell-tool detection — shellCommand() now
// normalizes array-shaped commands (e.g. Codex's ["git","push",...]) so the
// branch/commit/PR regexes run on harnesses that don't pass a bare string. The
// bump re-derives already-imported sessions whose array-shaped git calls were
// previously dropped.
// Bumped 5 → 6: created-PR heads historically rejected conventional default
// names from the unreliable tool gitBranch fallback. ISS-5828 removes the name
// heuristic while retaining the stronger rule that CWD context is never a head.
// Bumped 6 → 7 (FEA-2531): branch refs now split by evidence — write methods
// (git_push/gh_pr_create/git_commit) emit `relation: "created"`, read methods
// (git_checkout/git_worktree_add) and the session start branch stay `workspace`;
// a failed push (tu.isError) emits no branch ref — see the 9 → 10 bump below,
// which extends this from git_push to every push method; branch refs stamp their
// own event time (tu.timestamp) instead of scan time; the start-branch ref's
// method is renamed to "start_branch". The bump re-derives already-imported
// sessions so their branch links carry the new relation/method/time.
// Bumped 7 → 8 (FEA-2531 hardening): (a) shell-quote-aware git detection —
// the branch/commit/push regexes no longer match git text embedded inside
// ANOTHER command's quoted argument (rg patterns, inline `-e` scripts), the
// source of phantom pushed branches like `feat/x','git`; (b) tightened
// isValidBranchName rejects quote/comma/shell-metacharacter debris;
// (c) created-PR head refs resolve from the session's own write evidence
// (gh pr create output/--head flag, else the nearest preceding branch write)
// BEFORE falling back to per-line tu.gitBranch, which is CWD-derived and
// wrong for every worktree session. The bump re-derives history: poisoned
// branch links drop on delete-then-reinsert, and worktree-created PRs heal
// their pull_requests.branch_name via the import-authoritative upsert.
// Bumped 8 → 9: v8 resolved created-PR head branches during backfill but the
// backfill persists only link rows + push markers — the resolved head ref
// never reached pull_requests.branch_name for already-imported sessions, so
// historical worktree PRs stayed unlinked on the Branches page.
// persistArtifactLinks now fill-only writes the re-derived head branch to the
// created session's pull_requests row; the bump re-runs the backfill so the
// fill lands everywhere.
// Bumped 9 → 10 (FEA-2789): the FEA-2531 failed-push gate now covers every push
// method, not just git_push — a failed `gh pr create` (tu.isError) mints no
// branch ref and is no created-PR head evidence, exactly as a failed `git push`.
// The bump re-derives already-imported sessions so phantom "created"/pushed
// branches minted by past failed `gh pr create` calls drop on the backfill's
// delete-and-rederive (and their first_pushed_at push markers clear with them).
// Bumped 10 → 11 (FEA-2791): the FEA-2531 shell-quote-aware git detection now
// covers argv-shaped commands too — a bundled non-first argv element with
// internal whitespace (Codex's `["rg", "git push origin feat/x"]`) is treated as
// a quoted argument, so command text inside one arg no longer matches the push
// (or unanchored commit) regex and mints a phantom `feat/x` branch or phantom
// commit refs from echoed SHAs. The bump re-derives already-imported sessions so
// such phantom branch/commit links (and push markers) drop on the backfill's
// delete-and-rederive.
// Bumped 11 → 12: commit refs now carry the branch they landed on, parsed from
// the `[<branch> <sha>]` git-commit summary line with the SAME regex +
// isValidBranchName gate as the branch-detection pass (the branch was previously
// captured only for the branch ref and discarded for the commit ref). The cloud
// commit contract requires a branch and the desktop sync payload drops a
// branchless commit ref, so every desktop commit was silently dropped before
// reaching CommitDetail. The bump re-derives already-imported sessions so their
// commit artifacts get branch_name filled and finally sync.
// Bumped 12 → 13: the commit-subject parse now requires the short-sha inside the
// summary-line bracket, so it stops grabbing husky/lint-staged status lines
// (`[STARTED] …`, `[COMPLETED] …`) as the commit message. The bump re-derives
// already-imported sessions so their commit artifacts get the real subject.
// Bumped 13 → 14: commit refs are now minted ONLY for the sha in a `[<branch>
// <sha>] <subject>` summary line (GIT_COMMIT_SUMMARY_RE), not for every hex token
// in the output, and branch + sha + subject are read PER summary line from the
// same match (GIT_COMMIT_SUMMARY_RE, matchAll) rather than once for the whole
// output. The v11 branch attachment made both prior behaviours unsafe: (a) a
// noise sha (a husky/lint-staged stash-backup sha, a tree/object hash)
// co-occurring with a real summary line inherited that commit's branch, cleared
// the sync gate, and upserted a phantom CommitDetail that never reconciles with a
// push webhook; (b) a second commit in the same output (two `git commit` runs, a
// rebase/cherry-pick echo) was mislabeled with the FIRST line's branch, joining
// it to the wrong branch row. The bump re-derives already-imported sessions so
// those spurious/branchless/mislabeled commit artifacts heal on the backfill's
// delete-and-rederive (this also clears the ~pre-existing local over-mint noise).
// Bumped 15 → 16 (FEA-3585): PR-review sessions now mint a `reviewed`-relation
// PR ref for the PR named on a `gh pr view/diff/review/checkout/comment <n>`
// command — a bare-number positional (previously producing NO ref, so a merely-
// mentioned PR URL was linked instead) or a URL positional (previously mislabeled
// `referenced`). The bump re-derives already-imported sessions so historical
// review sessions drop the wrong `referenced` link and gain the correct
// `reviewed` one on the backfill's delete-and-rederive.
// Bumped 16 → 17 (FEA-3627): the PR / commit / branch passes (and the created-PR
// head-branch write-evidence collector) now ALSO scan sidecar sub-agent tool
// uses (`session.subagents[].toolUses`), attributing a Task-spawned sub-agent's
// `gh pr create` / `git commit` / `git push` to the PARENT session — previously
// those tool uses were merged only into `subagent.toolUses`, never
// `session.toolUses`, so sub-agent-authored PRs, commits, and branches (and the
// LOC that follows from their commit/branch refs) were silently dropped from the
// parent's landed code. In-line sidechain tool uses are deduped by tool-use id
// so they are not double-counted. The bump re-derives already-imported
// orchestrator/night-crew sessions so their sub-agent PR/branch/commit links —
// and the LOC git enrichment derives from them — finally attach to the parent.
// Bumped 17 → 18 (FEA-3420): `session.subagents[]` now also includes Claude
// WORKFLOW agents nested under subagents/workflows/<id>/agent-*.jsonl, which the
// parser's previously one-level discovery never folded in. Because
// `collectSessionToolUses` scans `session.subagents[].toolUses`, a nested
// workflow sub-agent's `gh pr create` / `git commit` / `git push` now attributes
// to the parent too (deduped by tool-use id, same no-double-count guard). The
// bump re-derives already-imported sessions so their nested-workflow PR/branch/
// commit links attach to the parent on the backfill's delete-and-rederive.
// Bumped 18 → 19 (FEA-3635): a CREATED pull_request ref now stamps its
// `observedAt` from the create tool-use event time (tu.timestamp) instead of the
// scan/import `now` — mirroring the branch and commit passes. This anchors the
// "PR #N opened" timeline dot to the transcript turn where the PR was opened
// (the pre-enrichment fallback in session-artifact-markers, below the
// authoritative pull_requests.opened_at), instead of bunching every PR marker at
// the synthetic per-import scan time. `referenced` PR mentions keep scan-time
// observedAt (they mint no marker), so a later re-mention can't move the open
// dot. The bump re-derives already-imported sessions so their created-PR links
// gain the transcript-anchored observed_at on the delete-and-rederive backfill.
// FEA-3803 adds optional lifecycle sync metadata without backfilling historical
// layer2 stores, so the extractor version stays at 19.
// Bumped 19 → 20 (FEA-3851): a reviewed PR's method is now computed PER
// SUB-COMMAND SEGMENT of a bundled command (`gh pr view <A> && gh pr review
// <B>`) instead of from the whole command string. A merely-VIEWED PR no longer
// inherits a sibling `gh pr review`'s `pr_review_feedback_command` method (the
// over-attribution that minted a wrong cloud `ReviewFeedback` boundary), and a
// failing unrelated sibling sub-command no longer demotes a genuine feedback
// write (the mirror under-count). The bump re-derives already-imported sessions
// so their reviewed-PR link methods are corrected on the backfill's
// delete-and-rederive.
// Bumped 20 → 21 (FEA-3851 review fixes): (1) the sub-command splitter no
// longer treats a redirection `&` (`2>&1`, `>&2`, `&>file`) or an escaped `\&`
// as a control operator, so a lone failed `gh pr review 42 --approve 2>&1` stays
// ONE segment and is correctly demoted to read-only instead of splitting into
// two and dodging the isError demotion. (2) A feedback write under a
// whole-command error is promoted only when a later segment is chained AFTER it
// with `&&` (proving it exited 0 before the failing suffix), replacing the
// weaker `segments.length > 1` check that promoted a failing `A && gh pr review B`
// even though B never ran or itself failed. The bump re-derives already-imported
// sessions so their reviewed-PR link methods are corrected on the backfill's
// delete-and-rederive.
//
// Bumped 21 → 22 (FEA-4137): the artifact formerly called "Feature" is now
// "Issue". The slug regex accepts the canonical `ISS-` prefix and the URL regex
// accepts the canonical `/issues/` route path, alongside the retained `FEA-` /
// `/features/` compat aliases (both resolve to the same numeric identity). The
// bump re-derives already-imported sessions so any ISS-###/`/issues/` refs they
// contain are picked up on the backfill's delete-and-rederive.
//
// Bumped 22 → 23 (ISS-5236): `observed_at` is no longer the import wall clock —
// every ref carries its own transcript event instant where it has one, else the
// session's `startedAt` (see artifact-ref-observed-at.ts).
//
// This bump alone is NOT all-corpus convergence, and must not be read as it. It
// drives `artifact-link-backfill.ts`, which enumerates transcript FILES: that
// reaches only the three file-per-session harnesses that file lists, and it
// deliberately preserves `launch_metadata` links. The `DATA_REVISION` 68 → 69
// bump landed alongside is the harness-generic path that does converge the
// corpus, and its changelog entry (`docs/desktop-data-revision-history.md`)
// carries the full reasoning for both.
//
// Bumped 23 → 24 (ISS-5764 + ISS-5763): the `prose_mention` pass mints weak
// referenced PR/branch refs from prose adjacent to PR or branch vocabulary.
// It reads session messages plus parent/sidecar non-shell input and delegation
// output, then re-derives historical prose-only links on backfill.
// Bumped 24 → 25 (ISS-6060): exact user and agent Branch/PR activity now rides
// bounded link evidence; DATA_REVISION 76 provides all-harness convergence.
// Bumped 25 → 26 (ISS-8268): shell-command recognition is structural
// (isShellCommandToolUse) — an MCP tool carrying an explicit `command`/`cmd`
// input field now emits git_push/gh_pr_create/commit refs instead of prose
// mentions, so historical shell-through-MCP sessions re-derive and their
// ISS-8148-deferred branches can materialize on the next sync.
//
// Bumped 26 → 27 (ISS-8336): the two branch-minting `gh pr create` gates ran on
// a private, unanchored copy of the pattern, so an unquoted MENTION — a doc line,
// or a runbook line inside a heredoc body that is not line-initial — minted a
// branch with `gh_pr_create` push evidence. Both now gate on the canonical
// command-position-anchored regex. The bump is what REMOVES the already-persisted
// phantoms: links are delete-then-reinsert, so a ref the new version no longer
// emits drops out of every link-driven surface on the re-derive. Without it the
// fix would only apply to newly-imported sessions and the fabricated branches
// already in the graph would survive.
//
// As at revision 23 above, THIS BUMP ALONE IS NOT ALL-CORPUS CONVERGENCE. It
// drives `artifact-link-backfill.ts`, which enumerates transcript FILES for the
// three file-per-session harnesses it lists (claude, codex, cursor); a copilot or
// opencode session already sealed at the current `DATA_REVISION` is not stale to
// anything and would keep its fabricated `gh_pr_create` branch links forever
// (whitlockk, PR #6180). `DATA_REVISION` 90 → 91 lands alongside as the
// harness-generic path — it re-imports through `importSessionWithTx`, which
// re-derives `session_artifact_links` for EVERY harness — and its changelog entry
// (`docs/desktop-data-revision-history.md`) carries the reasoning for both.
//
// Bumped 27 → 28 (ISS-8338 + ISS-8432): PR numbers are bounded to Prisma Int
// storage and terminal-hyphen prose branch fragments no longer mint refs.
// `DATA_REVISION` 91 → 92 is paired for the all-harness re-derive path; this
// extractor bump covers the artifact-link backfill lane.
//
// Bumped 28 → 29 (ISS-8175): a `created` PR ref now carries the BASE ref gh
// itself named in its create output, so already-imported sessions re-derive and
// their PR rows stop rendering an unknown base. Re-derivation reads that same gh
// line, never the owning Branch's current base (the unsound shape ISS-8155's
// migration refused). This bump has the same reach gap as revisions 23 and 27
// above — the backfill it drives enumerates transcript FILES for the three
// file-per-session harnesses only — so `DATA_REVISION` 92 → 93 lands alongside
// as the harness-generic path; see its changelog entry.
//
// Bumped 29 → 30 (ISS-8751): `GIT_COMMIT_BRANCH_RE` now keys on the real commit
// summary shape (`[<branch> <7-40 hex>]`) rather than a single leading hex
// digit, so a `git commit` summary line no longer mints a branch ref out of
// whatever word precedes the sha — 53 captures corpus-wide fall to 4, with no
// real branch lost. Already-imported sessions must re-derive or they keep
// serving the phantom `#lc` branch link this narrowing exists to remove. (An
// earlier draft of this entry also claimed `pnpm-lock.yaml` and `/tmp/nrev-...`;
// those come from the checkout and worktree passes, which this revision does not
// touch — see revision 31.) Same reach gap as revisions 23, 27, 28 and 29
// above — the backfill this drives enumerates transcript FILES for the three
// file-per-session harnesses only — so `DATA_REVISION` 95 → 96 lands alongside
// as the harness-generic path; see its changelog entry.
//
// Bumped 30 → 31 (ISS-8751 siblings): the two remaining passes that read a PATH
// as a branch. `git worktree add --detach <path>` names no branch at all, but
// the pattern's leading path slot ate the FLAG and captured the destination, so
// `/tmp/nrev-...` was minted; `isValidBranchName` now also enforces git's own
// rule that a ref may not BEGIN with `/` (only the trailing case was checked),
// which closes that shape at every emission site. `git checkout <file>` is
// irreducibly ambiguous — `pnpm-lock.yaml` is a legal branch name, so no
// validator can reject it — and is now rejected where the ambiguity lives, by
// the one shape that is effectively never a branch: a trailing alphabetic
// extension. Measured corpus-wide: 2 phantoms removed, 0 of 20 real branches
// lost. Both are READ methods, so neither reached the Branches surface or drew
// token attribution, but both were persisted. Same reach gap as revisions 23,
// 27, 28, 29 and 30 above, so `DATA_REVISION` 96 → 97 lands alongside as the
// harness-generic path; see its changelog entry.
//
// Bumped 31 → 32 (ISS-9860): the monitored-activity carrier written into
// `session_artifact_links.evidence` is no longer capped at 50 events per target
// / 100 per session, so already-imported sessions must re-derive to recover the
// events the caps dropped. Same reach gap as revisions 23 and 27-31 above — the
// backfill enumerates transcript FILES for Claude/Codex/Cursor only — so
// `DATA_REVISION` 100 → 101 lands alongside; see its ledger entry.
// Bumped 32 → 33 (ISS-8473): a heredoc BODY is neutralized before any
// command-shape gate runs, the way a quoted span already was. A body is data
// the shell feeds to stdin and never executes, but a body line that BEGINS with
// a command was positionally indistinguishable from a real invocation, so
// `cat <<EOF\ngh pr create --head feat/x\nEOF` minted `feat/x` — and so did the
// same shape around `git push` and `git checkout -b`, which predate the
// ISS-8336 command-position anchor and were never scoped by it. The fix is one
// `findNeutralizedSpans` composition point shared by every site that builds
// spans, so the gh/git/commit patterns cannot diverge on what counts as data.
// This bump REMOVES records: fewer branch records, all of them phantom, with no
// real branch losing its evidence. That last clause is load-bearing and was not
// free — a `<<` the scanner wrongly reads as an opener finds no terminator, and
// the unterminated fallback then blanks the REST OF THE COMMAND, deleting real
// pushes. So a `<<` is an opener only in command position: arithmetic
// expansion (`$((1 << 20))`), a shell comment (`# a << b`), a quoted argument
// (tracked across lines, not per line), a herestring (`<<<`) and an UNQUOTED
// numeric delimiter are all excluded, and a command after the terminator stays
// visible. Two more ways that last clause was false, both found in review of
// PR #7209 and fixed before release: the quote scan ran over the raw command,
// so an apostrophe inside a body (`cat <<EOF\ndon't\nEOF\ngit push …`) opened
// an unterminated quote that swallowed the real push — bodies are now resolved
// first and the quote scan runs with them already inert; and a delimiter word
// carrying a quoted fragment (`<<E"OF"`) read as `E`, never found its
// terminator, and blanked the rest of the command — the word is now parsed with
// shell quote removal, which is also why a QUOTED numeric delimiter (`<<"2"`)
// is a real heredoc while an unquoted `2` stays an arithmetic operand.
// Each exclusion is pinned by a case in artifact-ref-shell-quotes.test.ts that
// asserts the following line's branch SURVIVES. Same reach gap as
// revisions 23 and 27–31 above — the backfill this drives enumerates transcript
// FILES for the three file-per-session harnesses only — so `DATA_REVISION`
// 101 → 102 lands alongside as the harness-generic path; see its changelog
// entry.
// Bumped 33 → 34 (ISS-12855): `CLOSEDLOOP_URL_RE` accepts the canonical
// `/documents/` route that every in-app link and MCP `webUrl` now emits
// (`https://app.closedloop.ai/<org>/documents/<slug>`); the retired per-type
// paths stay accepted for links already in transcripts. The route segment is
// discarded as before — the artifact is the captured typed slug — so no type
// is inferred from the path. The bump re-derives already-imported sessions so
// a `/documents/` URL ingested since the route change gains its `url_match`
// ref: a new `output` ref for a URL in tool output, and, for a URL in message
// text or tool input, the bare-slug `slug_match_in_prose` ref the slug pass
// already minted is superseded by `url_match` on dedup. Refs are only gained
// or strengthened, none removed. Same reach gap as revisions 23 and 27–33
// above — the backfill this drives enumerates transcript FILES for the three
// file-per-session harnesses only — so `DATA_REVISION` 110 → 111 lands
// alongside as the harness-generic path; see its ledger entry.
export const EXTRACTOR_VERSION = 34;
