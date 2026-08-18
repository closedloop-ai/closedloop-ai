/**
 * Shared contract constants for the desktop git gateway operations
 * (`git-action`, `git-branches`, `git-diff`, `git-worktree`).
 */

/**
 * Finite deadline applied to every `git` child process the gateway spawns. A
 * git command can otherwise hang indefinitely on a stalled remote, a blocking
 * credential helper, a hook, an fsmonitor daemon, or a wedged child — holding a
 * gateway request open forever. Every gateway git `exec` passes this as its
 * `timeoutMs` so a hung command fails fast instead of leaking a request.
 */
export const GIT_GATEWAY_EXEC_TIMEOUT_MS = 120_000;
