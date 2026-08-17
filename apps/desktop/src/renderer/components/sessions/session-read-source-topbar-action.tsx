import { useAgentSessionDetail } from "@repo/app/agents/hooks/use-agent-sessions";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { DESKTOP_SESSION_DETAIL_READ_SOURCE_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import { AppCoreReadSourceBadge } from "../app-core-read-source-badge";

/**
 * ISS-5607: the read-source badge for the session DETAIL route, rendered in the
 * Topbar's `actions` slot beside the "Sessions / <name>" breadcrumb.
 *
 * It lives here rather than in a strip above the pane for the reason Branch
 * detail already puts its comments toggle here: the badge qualifies the record
 * the breadcrumb names, the Topbar row is the one that already exists to hold
 * route-owned controls, and a band of our own would add permanent chrome above a
 * pane whose pinned block FEA-4025 deliberately keeps small. A full-width strip
 * would also not line up with anything — the loaded pane is a centered 1000px
 * column (`.sd3-doc`), so a right-aligned pill in a full-width band drifts
 * hundreds of pixels away from the content it describes on a wide window.
 *
 * Mounted inside the app-core stack, so `useAgentSessionDetail` reads the SAME
 * cache entry the pane below is rendering. It is a pure OBSERVER of that entry —
 * see the `enabled: false` below for why that is enforced rather than assumed.
 *
 * The badge is withheld until that read has actually produced a row. The source
 * is derived from the app-core mode, which is always answerable — but "which
 * store would serve this" is not the same claim as "this is where these rows
 * came from", and the shared pane renders a skeleton, a not-found and a provider
 * error over which the second claim is simply false. A pill reading "Showing the
 * data synced to your workspace" above "Session not found" states that a read
 * succeeded when none did (`ReadSourceBadge` treats an unattributable source as
 * render-nothing for the same reason).
 */
export function SessionReadSourceTopbarAction({
  sessionId,
}: Readonly<{
  /** The session-detail route's id, or null on every other route. */
  sessionId: string | null;
}>) {
  if (!sessionId) {
    return null;
  }
  return <SessionReadSourceBadge sessionId={sessionId} />;
}

function SessionReadSourceBadge({
  sessionId,
}: Readonly<{ sessionId: string }>) {
  // `…Optional` because the desktop shell also renders in tests and Storybook,
  // which mount no flag provider.
  const enabled = useFeatureFlagEnabledOptional(
    DESKTOP_SESSION_DETAIL_READ_SOURCE_FEATURE_FLAG_KEY
  );
  // `enabled: false` — this is an OBSERVER of the pane's cache entry, never a
  // second reader of it (wongk cid 3776137731). This component mounts in the
  // Topbar, OUTSIDE the lazy detail boundary, so it commits before the pane and
  // an enabled observer would be the one to open the read. That matters because
  // `applyDesktopSessionsListPollDefaults` puts `refetchInterval: 5s` and
  // `refetchOnMount: "always"` on the `details()` key prefix, and both are
  // PER-OBSERVER: two observers on one key means two out-of-phase 5 s timers and
  // a second forced read on the later mount, so a badge that only describes the
  // pane's read would have been doubling it. Disabled, it still subscribes to
  // the entry and re-renders on every cache update, which is all it needs — and
  // it is inert with the Labs flag OFF, as a closed-by-default gate requires.
  const { data } = useAgentSessionDetail(sessionId, { enabled: false });
  if (!(enabled && data)) {
    return null;
  }
  return <AppCoreReadSourceBadge surfaceLabel="session" />;
}
