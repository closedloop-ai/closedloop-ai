import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { TriangleAlert } from "lucide-react";
import { type ReactNode, useCallback } from "react";
import { useTerminalAgentMonitorStatus } from "../hooks/use-ingest-progress";

/**
 * ISS-4834 (Parker copy pass): effect first, cause second, and the button
 * carries the action so the strip never says it twice. No "database", no
 * "migration", no version numbers - the user's read is that their history and
 * sync stopped, and that a newer version of the app is what reopens them.
 *
 * "unavailable", not "paused": nothing here is paused. "Paused" is the word the
 * Settings connection strip already uses for a stop the user CHOSE and can undo
 * (`connection-status-section.tsx` renders "Paused" for remote commands), so
 * reusing it here would read as something the user can resume themselves. They
 * cannot - only updating the app reopens this.
 *
 * Still kept short, but as copy discipline rather than as truncation insurance:
 * the strip wraps to two lines instead of truncating (see the render below), so
 * the second sentence - the only part that says WHY - can no longer be the first
 * thing cut on a narrow window.
 */
export const DB_AHEAD_BANNER_MESSAGE =
  "Agent Monitor history and cloud sync are unavailable. Your data was saved by a newer version of this app.";

/**
 * ISS-4714: when the local SQLite store carries a migration this app build does
 * not know about — a DB created by a NEWER Desktop build (a downgrade, a stale
 * auto-update, or dev running behind) — the migration runner refuses to open the
 * DB and the ENTIRE local runtime (parsing, and therefore transcript / component
 * cloud sync) is dead. Previously this failed silently with only a log line.
 *
 * This pinned banner surfaces that state prominently and honestly: your data is
 * newer than this app, so update to recover. It renders nothing in every other
 * runtime state (starting, ready, or any other failure the user already sees via
 * its own surface), and clears on the next runtime-status poll once the app is
 * updated and the DB opens.
 *
 * It is a sibling-shaped AppShell banner row (matching UpdateBanner /
 * DesktopSessionExpiredBanner / OptInDistributionsBanner): a centered message
 * in the shared destructive red wash, an inline action, `role="status"`,
 * no inner card — so it sits in the same rhythm as the other bars in the stack.
 * The action recovers the state (the one refusal a user fixes by updating), so
 * this highest-severity banner is not the only mute one; it triggers an update
 * CHECK rather than a relaunch, since relaunching the SAME too-old build would
 * not resolve the refusal.
 *
 * The leading TriangleAlert (ISS-4834) is the non-color severity channel, the
 * same mark `UpdateBanner` uses for its blocked state. The red wash alone
 * carries severity by color only (WCAG 1.4.1), which a red-blind user does not
 * get; the icon is `aria-hidden` because the sentence already says it.
 *
 * The mark is toned with `--destructive` rather than inheriting the strip's
 * `--foreground`, or it renders as a neutral glyph that looks stray next to the
 * wash. `UpdateBanner` gets this for free by toning its WHOLE blocked strip
 * `--warning-foreground`; that trick does NOT transfer here, because
 * `--destructive-foreground` is `oklch(1 0 0)` in both themes (the on-solid-fill
 * white) and would be unreadable over a 10% wash. So the icon carries the tone
 * and the sentence keeps `--foreground` for body contrast.
 */
export function AgentMonitorDbAheadBanner(): ReactNode {
  const status = useTerminalAgentMonitorStatus();

  const handleCheckForUpdate = useCallback(() => {
    // Best-effort: the updater surfaces its own progress via UpdateBanner. A
    // missing method (older preload / test stub) must not throw synchronously.
    window.desktopApi?.checkForUpdate?.().catch(() => undefined);
  }, []);

  if (!status?.dbAhead) {
    return null;
  }

  return (
    <div
      className="flex shrink-0 items-center justify-center gap-3 border-b bg-[var(--destructive)]/10 px-4 py-2 text-[var(--foreground)] text-sm"
      role="status"
    >
      <TriangleAlert
        aria-hidden="true"
        className="size-3.5 shrink-0 text-[var(--destructive)]"
      />
      <span className="min-w-0">{DB_AHEAD_BANNER_MESSAGE}</span>
      <Button
        className="shrink-0"
        onClick={handleCheckForUpdate}
        size="sm"
        variant="default"
      >
        Check for updates
      </Button>
    </div>
  );
}
