/** How often the watch re-reads the account's GitHub connection. */
const DEFAULT_POLL_INTERVAL_MS = 5000;
/** How long a connect the user walked away from is watched before giving up. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type GitHubConnectReturnWatchDeps = {
  /**
   * The account's GitHub data connection: `true`/`false` when read, `undefined`
   * when the read failed or answered for no account. Must not throw.
   */
  readConnected: () => Promise<boolean | undefined>;
  /**
   * Called at `start()`; the predicate it returns says whether the signed-in
   * account is still the one that opened the connect. A sign-out or account
   * switch ends the watch, so another account's connection never counts.
   */
  captureAccount: () => () => boolean;
  /** Show, focus and activate the Desktop window. */
  bringWindowToFront: () => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export type GitHubConnectReturnWatch = {
  /** Watch a connect that was just handed to the browser, replacing any prior one. */
  start: () => void;
  stop: () => void;
};

/**
 * Brings Desktop back to the front once a GitHub connect it opened in the
 * browser lands (operator report, 2026-10-10: "once github connects; we need
 * to go back to the desktop and complete first time onboarding").
 *
 * The connect finishes on the web linking page, which has no channel back to
 * this process: `closedloop://` is payload-free and browsers drop it without a
 * user gesture. So the main process watches the one thing it can read, the
 * account's GitHub connection, and activates the window once it reads
 * connected — the same activation sign-in uses (ISS-10412
 * `returnFromBrowserSignIn`).
 *
 * The caller asks only when the reader is not connected. A first post-handoff
 * read can already report the connection this click completed, so it must
 * activate too. A failed read counts as no answer, and the watch ends at
 * {@link DEFAULT_TIMEOUT_MS} so an abandoned connect does not poll forever.
 */
export function createGitHubConnectReturnWatch(
  deps: GitHubConnectReturnWatchDeps
): GitHubConnectReturnWatch {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    generation += 1;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const start = () => {
    stop();
    const watched = generation;
    const deadline = Date.now() + timeoutMs;
    const sameAccount = deps.captureAccount();

    const tick = async () => {
      timer = null;
      const connected = await deps.readConnected();
      if (watched !== generation) {
        return;
      }
      if (!sameAccount()) {
        stop();
        return;
      }
      if (connected === true) {
        stop();
        deps.bringWindowToFront();
        return;
      }
      if (Date.now() >= deadline) {
        stop();
        return;
      }
      timer = setTimeout(() => {
        tick().catch(() => undefined);
      }, pollIntervalMs);
      timer.unref?.();
    };

    tick().catch(() => undefined);
  };

  return { start, stop };
}
