/**
 * Shared contract constants for the desktop gateway operations that run git.
 */

/**
 * Finite deadline applied to every `git` child process the gateway spawns. A
 * git command can otherwise hang indefinitely on a stalled remote, a blocking
 * credential helper, a hook, an fsmonitor daemon, or a wedged child — holding a
 * gateway request open forever. Every gateway git `exec` passes this as its
 * `timeoutMs` so a hung command fails fast instead of leaking a request.
 */
export const GIT_GATEWAY_EXEC_TIMEOUT_MS = 120_000;

/**
 * A ref beginning with `-` is parsed by git as an option (`checkout -f`
 * discards local changes), and git itself refuses such a branch name, so the
 * gateway routes that pass a caller's branch refs to git reject them with this.
 * The codex review route also returns it for `baseBranch` (ISS-11193).
 */
export const BRANCH_NAME_LEADING_HYPHEN_ERROR =
  "branchName must not start with a hyphen";

/**
 * A ref git would parse as an option rather than a commit-ish.
 *
 * Dropping the shell closes shell-metacharacter injection but not ARGUMENT
 * injection: `execFile` still hands git a literal string, and a positional ref
 * beginning with `-` (`--force`, `-D`, `--lock`) is read by git's option parser.
 * Every gateway path that passes a caller's ref to git checks it with this.
 */
export function isOptionLikeRef(ref: string): boolean {
  return ref.startsWith("-");
}
