import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";

const GIT_INTERNAL_REFS = new Set([
  "FETCH_HEAD",
  "HEAD",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REBASE_HEAD",
]);

const BARE_SHA_RE = /^[0-9a-f]{8,40}$/;

// FEA-2531 hardening: characters that are either invalid in git ref names
// (whitespace, ~ ^ : ? * [ ] \ and control chars) or shell/quoting debris the
// command regexes can capture when git-command text is embedded inside
// ANOTHER command's quoted argument (rg patterns, inline `-e` scripts).
// Quotes, backtick, comma, and shell metacharacters are technically legal in
// some positions of a git ref but never appear in real branch names —
// rejecting them kills the `feat/x','git` phantom-branch class at every
// emission site (command, output, and start-branch refs alike).
const INVALID_BRANCH_CHAR_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are precisely what git forbids in ref names
  /[\s~^:?*[\]\\'"`,;|&<>(){}$\u0000-\u001f\u007f]/;

export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > BRANCH_NAME_MAX_LENGTH) {
    return false;
  }
  if (GIT_INTERNAL_REFS.has(name)) {
    return false;
  }
  if (name.startsWith("origin/")) {
    return false;
  }
  if (name.startsWith("refs/")) {
    return false;
  }
  if (BARE_SHA_RE.test(name)) {
    return false;
  }
  if (INVALID_BRANCH_CHAR_RE.test(name)) {
    return false;
  }
  // Remaining git check-ref-format rules that show up as captured debris.
  if (name.startsWith("-") || name.startsWith(".")) {
    return false;
  }
  if (name.endsWith(".") || name.endsWith("/") || name.endsWith(".lock")) {
    return false;
  }
  // git check-ref-format: a ref can neither BEGIN nor end with `/`, nor hold
  // consecutive slashes. The end and the interior were covered; the start was
  // not, so an absolute path passed as a branch name — `git worktree add
  // --detach /tmp/x` minted `branch::/tmp/x` (ISS-8751).
  if (name.startsWith("/") || name.includes("//")) {
    return false;
  }
  if (name.includes("..") || name.includes("@{")) {
    return false;
  }
  return true;
}
