/**
 * @file codex-burst-window.ts
 * @description The leading window of a Codex rollout whose records a resume
 * may have replayed (`rebaseReplayedBurst` in `@repo/lib/harness/codex`). One
 * read for the desktop Codex parser shell and the GenAI request bridge; it sits
 * outside `main/collectors/` because the bridge is on the boot path, which the
 * `boot-no-design-system-runtime` depcruise rule keeps out of `collectors/`.
 */
export function codexBurstWindowMs(): number {
  const value = process.env.SYMPHONY_CODEX_BURST_WINDOW_MS;
  return Number(typeof value === "string" && value.length > 0 ? value : "5000");
}
