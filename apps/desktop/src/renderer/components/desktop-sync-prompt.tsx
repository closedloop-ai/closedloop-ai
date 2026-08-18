import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import {
  type BridgeStore,
  createBridgeStore,
} from "../shared-agent-sessions/bridge-store";
import { useDesktopAuth } from "../shared-agent-sessions/desktop-auth-provider";
import type { DesktopExistingUserResolution } from "../types/desktop-api";

/**
 * Non-blocking, one-time "Sign in with GitHub to sync" prompt for an existing
 * user (PRD-532 §8 / M6): someone who already has an `sk_live_*` API key but no
 * first-party Clerk/GitHub desktop session.
 *
 * The main process ({@link DesktopSessionManager}) derives the resolution state
 * from the live auth status + API-key presence: a present key with no session
 * makes `kind` become `prompt`. This banner surfaces that as a dismissible
 * prompt — it NEVER hard-blocks: local + existing API-key access keep working
 * whether the user signs in, dismisses, or ignores it.
 *
 * The prompt is the ONLY path from an API key to a session. A silent background
 * mint used to run first and sign the user in with no involvement; it was
 * removed because it also re-authenticated users who had just signed out.
 *
 * The prompt renders whenever the main-process resolution is `prompt` and the
 * user has not dismissed it — there is no separate feature gate. Browser sign-in
 * is always available (first-party desktop auth graduated to always-on,
 * FEA-4133), and the unified GitHub-first onboarding flow is always-on (the
 * `unified-auth-onboarding` flag was graduated and removed, FEA-3999).
 *
 * SECURITY: only the advisory `{ kind, dismissed }` state crosses IPC — never a
 * token, refresh token, or the API key. Sign-in reuses the main-process browser
 * OAuth flow; no credential is minted or handled here.
 */

const RESOLUTION_NONE: DesktopExistingUserResolution = {
  kind: "none",
  dismissed: false,
};

/** Whether the main-process existing-user bridge is exposed (false in partial test stubs). */
function hasResolutionBridge(): boolean {
  return typeof window.desktopApi?.getExistingUserResolution === "function";
}

type ResolutionStore = BridgeStore<DesktopExistingUserResolution>;

/**
 * External store mirroring the main-process resolution into the renderer (see
 * {@link createBridgeStore} for the shared wiring/teardown contract). Both the
 * initial and bridge-absent snapshots are `none` so a partial test stub settles
 * without ever rendering the prompt.
 */
function createResolutionStore(): ResolutionStore {
  return createBridgeStore<DesktopExistingUserResolution>({
    hasBridge: hasResolutionBridge,
    // hasResolutionBridge() gates this call, so the optional-chained pull is
    // always defined when invoked.
    pull: () =>
      window.desktopApi.getExistingUserResolution?.() ??
      RESOLUTION_NONE_PROMISE,
    subscribe: (onChange) =>
      window.desktopApi.onExistingUserResolutionChanged?.(onChange),
    initial: RESOLUTION_NONE,
    fallback: RESOLUTION_NONE,
  });
}

const RESOLUTION_NONE_PROMISE: Promise<DesktopExistingUserResolution> =
  Promise.resolve(RESOLUTION_NONE);

export function DesktopSyncPrompt() {
  const { beginSignIn } = useDesktopAuth();
  const [signingIn, setSigningIn] = useState(false);

  // One store per mount; the lazy-init ref keeps subscribe/getSnapshot stable so
  // useSyncExternalStore doesn't re-subscribe on render.
  const storeRef = useRef<ResolutionStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createResolutionStore();
  }
  const store = storeRef.current;
  const resolution = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const handleSignIn = useCallback(async () => {
    setSigningIn(true);
    try {
      // Reuses the main-process browser OAuth flow. A failed/cancelled attempt
      // leaves the prompt in place (the user keeps API-key access either way);
      // a success flips the main-process status to authenticated, which pushes a
      // `none` resolution and clears the prompt.
      await beginSignIn();
    } finally {
      setSigningIn(false);
    }
  }, [beginSignIn]);

  const handleDismiss = useCallback(() => {
    // Persist the one-time dismissal in main; the pushed resolution is the source
    // of truth and will settle this prompt to `none`.
    window.desktopApi.dismissExistingUserPrompt?.().catch(() => undefined);
  }, []);

  // Never hard-block: render nothing unless main says prompt (and it's not
  // dismissed). Browser sign-in is always available and the onboarding flow is
  // always-on, so there is no separate feature gate.
  if (resolution.kind !== "prompt" || resolution.dismissed) {
    return null;
  }

  return (
    <div
      className="flex shrink-0 items-center justify-center gap-3 border-b bg-[var(--muted)]/40 px-4 py-2 text-[var(--foreground)] text-sm"
      role="status"
    >
      <span className="truncate">
        {signingIn
          ? "Opening your browser to sign in…"
          : "Sign in with GitHub to sync this device to your account. Your local access keeps working either way."}
      </span>
      <Button
        disabled={signingIn}
        onClick={handleSignIn}
        size="sm"
        variant="default"
      >
        Sign in with GitHub
      </Button>
      <Button
        disabled={signingIn}
        onClick={handleDismiss}
        size="sm"
        variant="ghost"
      >
        Not now
      </Button>
    </div>
  );
}
