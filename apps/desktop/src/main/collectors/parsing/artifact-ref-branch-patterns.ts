/**
 * @file artifact-ref-branch-patterns.ts
 * @description The git/`gh` patterns the artifact-ref extractor reads a working
 * BRANCH out of — command shapes, their success-output shapes, and the global
 * clones used for position-checked scanning.
 *
 * Extracted from `artifact-ref-extractor.ts` (ISS-8336) on the same grounds as
 * its two siblings: `artifact-ref-command-patterns.ts` (ISS-6003) and
 * `artifact-ref-shell-quotes.ts` (ISS-7571). They are one cohesive unit of pure
 * module-level patterns with no extractor dependencies, and that file is over
 * the 1,000-line ceiling where the direction of travel is down.
 *
 * The `gh pr create` COMMAND pattern deliberately does NOT live here — it is the
 * canonical `GH_PR_CREATE_REGEX` in `artifact-ref-command-patterns.ts`, and the
 * `no-private-gh-pr-create-matcher` source gate refuses a second spelling of it
 * anywhere in this directory. What lives here is its OUTPUT shape, which names a
 * branch and is not a command matcher.
 */
import { MonitoredSessionCliRefMethod } from "./monitored-session-activity.js";

// Git commands that reveal the working branch (session.gitBranch is stale —
// set once at session start and never updated when the user creates worktrees,
// checks out branches, or pushes to different remotes mid-session).
export const GIT_WORKTREE_ADD_RE =
  /git\s+worktree\s+add\s+(?:"[^"]+"|'[^']+'|\S+)\s+(?:-b\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/;
export const GIT_CHECKOUT_RE =
  /git\s+(?:checkout|switch)\s+(?:-[bBc]\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/;
export const GIT_PUSH_BRANCH_RE =
  /git\s+push\s+(?:(?:-[a-zA-Z]+|--[\w-]+(?:=\S+)?)\s+)*(?:origin|upstream)\s+(?:"([^"]+)"|'([^']+)'|([^\s:;&|]+))/;
export const GIT_PUSH_CMD_RE = /git\s+push\b/;
// Branch deletion pushes nothing to attribute — never push evidence.
export const GIT_PUSH_DELETE_RE = /\s(?:-d|--delete)\b/;
// Success output names the remote ref: "abc123..def456  feat/x -> feat/x",
// "* [new branch]  feat/x -> feat/x", or with -u "branch 'feat/x' set up to
// track ...". Resolves HEAD/long-flag pushes the command regex can't name.
export const GIT_PUSH_OUTPUT_REF_RE =
  /^\s*[+*!=]?\s*(?:\[[^\]]+\]|\S+\.{2,3}\S+)\s+(\S+)\s+->\s+(\S+)/m;
export const GIT_PUSH_UPSTREAM_OUTPUT_RE =
  /branch\s+'([^']+)'\s+set\s+up\s+to\s+track/;
// gh pr create success output (stderr): "Creating pull request for feat/x
// into main in owner/repo". Group 1 is the head ref straight from gh itself,
// the strongest created-PR head-branch evidence (FEA-2531). Group 2 is the BASE
// ref on the same line (ISS-8175) — the only base evidence a local clone holds
// for a PR it opened, and gh's own report rather than a derivation.
export const GH_PR_CREATE_HEAD_OUTPUT_RE =
  /Creating pull request for (\S+) into (\S+)/;
// gh pr create --head/-H flag names the head branch in the command itself.
export const GH_PR_HEAD_FLAG_RE =
  /(?:^|\s)(?:--head|-H)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g;
// Global clones of the branch-command patterns for position-checked scanning:
// a non-global .match() only ever sees the FIRST occurrence, which may sit
// inside a quoted argument while a real git command follows later.
export const GIT_WORKTREE_ADD_ALL_RE = new RegExp(
  GIT_WORKTREE_ADD_RE.source,
  "g"
);
export const GIT_CHECKOUT_ALL_RE = new RegExp(GIT_CHECKOUT_RE.source, "g");
export const GIT_PUSH_BRANCH_ALL_RE = new RegExp(
  GIT_PUSH_BRANCH_RE.source,
  "g"
);

// `git worktree add --detach <path>` checks out a detached HEAD, so it names no
// branch at all. Without this the leading `\S+` path slot eats the FLAG and the
// capture lands on the destination path (ISS-8751).
const GIT_WORKTREE_DETACH_RE = /(?:^|\s)--detach\b/;

// `git checkout <token>` is irreducibly ambiguous: git resolves it as a branch
// when that ref exists and as a path to restore when it does not, and a parser
// holding only the command text cannot tell which happened. A trailing
// ALPHABETIC extension is the one shape that is effectively never a branch —
// `git checkout pnpm-lock.yaml` restores a file (ISS-8751). Numeric suffixes are
// deliberately excluded so `release/2.0` still reads as a branch. Measured over
// the golden corpus: 1 phantom removed, 0 of 15 real branches lost.
const GIT_CHECKOUT_PATH_ARG_RE = /\.[a-z]{2,6}$/i;

// Branch-revealing commands whose branch is named in the command itself, as
// regex capture group 1 ?? 2 ?? 3 (the quoted/unquoted-name alternatives).
export const BRANCH_COMMAND_PATTERNS: ReadonlyArray<{
  re: RegExp;
  method: string;
  reject?: (branch: string) => boolean;
  skip?: (strippedCmd: string) => boolean;
}> = [
  // git worktree add <path> [-b] <branch>
  {
    re: GIT_WORKTREE_ADD_ALL_RE,
    method: MonitoredSessionCliRefMethod.GitWorktreeAdd,
    skip: (strippedCmd) => GIT_WORKTREE_DETACH_RE.test(strippedCmd),
  },
  // git checkout/switch [-b] <branch>
  {
    re: GIT_CHECKOUT_ALL_RE,
    method: MonitoredSessionCliRefMethod.GitCheckout,
    reject: (b) => b === "." || GIT_CHECKOUT_PATH_ARG_RE.test(b),
  },
  // git push [flags] origin <branch>. HEAD is resolved from the push OUTPUT
  // (detectBranchesInOutput), never taken as a branch name; deletes are skipped.
  // The skip runs on the quote-stripped command so a `--delete` inside e.g. a
  // commit -m body cannot suppress a chained real push.
  {
    re: GIT_PUSH_BRANCH_ALL_RE,
    method: MonitoredSessionCliRefMethod.GitPush,
    reject: (b) => b === "HEAD",
    skip: (strippedCmd) => GIT_PUSH_DELETE_RE.test(strippedCmd),
  },
];
