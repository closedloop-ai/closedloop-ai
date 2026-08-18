/**
 * @file claude-live-hook-flag.ts
 * @description FEA-3729 kill switch for the Claude live hook capture path.
 *
 * Claude is the only harness with a live-hook capture channel. Now that the
 * watcher + parser path produces the same NormalizedSession data, the hook is
 * redundant, so it is gated OFF here. Flipping this constant to `true` restores
 * the full hook path — no other code is removed.
 *
 * While disabled:
 *   - `getActiveCollectionMode("claude", …)` resolves to `"watcher"` (the master
 *     hook toggle reports disabled), so the JSONL watcher + parser own capture,
 *     matching every other harness.
 *   - the master hook toggle is inert (`setAgentMonitorHooksEnabled(true)` is a
 *     no-op that keeps reporting disabled).
 *   - boot self-heals by uninstalling any Closedloop hook entries a prior build
 *     wrote into `~/.claude/settings.json`, so stale hook commands stop firing.
 *   - the in-process hook listener drops any Claude payload it still receives.
 *
 * This is a deliberately plain build-time constant, not a runtime feature flag:
 * the gate is temporary and we'll decide whether to remove the hook code later.
 */
export const CLAUDE_LIVE_HOOK_ENABLED = false;

/** Predicate form for wiring into the hook lifecycle and listener guards. */
export function isClaudeLiveHookEnabled(): boolean {
  return CLAUDE_LIVE_HOOK_ENABLED;
}
