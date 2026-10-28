import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import { useEffect, useState } from "react";

/**
 * The desktop renderer's GitHub integration status, read over IPC.
 *
 * Deliberately NOT `@repo/app`'s `useGitHubIntegrationStatus`: that hook calls
 * `useApiClient()`, which throws without an `<AuthAdapterProvider>` ancestor.
 * Mounting it in a broadly-rendered desktop view takes down every test site
 * that never needed an API client — the same class of break `useDesktopAuth`
 * caused on the branch views (ISS-5958). The main process already answers this
 * question over IPC with no provider stack at all.
 *
 * Extracted from `desktop-insights-provider.tsx` (ISS-7869), which owned the
 * only copy of this reader, so the Sessions strip and the Insights tiles ask
 * the main process the same question the same way.
 */
export function readDesktopGitHubIntegrationStatus(): Promise<GitHubIntegrationStatus | null> {
  return readOptionalDesktopGitHubIntegrationStatus().catch(() => null);
}

/**
 * This desktop account's GitHub integration status, or `null` once a read has
 * landed with nothing to report. `undefined` means the read has not landed.
 *
 * The STATUS, not just a boolean, because two different questions come off it
 * and they must not be answered by two different reads (ISS-5958): whether to
 * ask at all (`resolveGitHubDataConnected`), and whether the ask says Connect or
 * Reconnect (`resolveGitHubConnectAction`). A surface that let the connect hook
 * fetch its own status put those on sources that disagree whenever the second
 * is unresolved.
 */
export function useDesktopGitHubIntegrationStatus():
  | GitHubIntegrationStatus
  | null
  | undefined {
  const [status, setStatus] = useState<
    GitHubIntegrationStatus | null | undefined
  >(undefined);
  useEffect(() => {
    let cancelled = false;
    // ISS-7866 review (tamsinb): a request-SEQUENCE guard, not just a cancel
    // flag. `cancelled` only covers unmount; it does nothing about two reads in
    // flight at once, which is exactly what focus + visibilitychange produce
    // when a user alt-tabs back. Without this an older response can land last
    // and overwrite a newer one — re-lighting the ask after a connect that
    // already succeeded. Carried over from `DesktopInsightsProvider`, which had
    // it before this hook was extracted out of it and dropped it in the move.
    let nextSequence = 0;
    let lastAppliedSequence = 0;
    const read = () => {
      nextSequence += 1;
      const sequence = nextSequence;
      readDesktopGitHubIntegrationStatus()
        .then((next) => {
          if (cancelled || sequence < lastAppliedSequence) {
            return;
          }
          lastAppliedSequence = sequence;
          setStatus(next);
        })
        .catch(() => {
          // `readDesktopGitHubIntegrationStatus` already folds failure to null;
          // this keeps an unexpected rejection from surfacing as an unhandled
          // one and leaves the state UNKNOWN, which is the honest answer.
        });
    };
    read();
    // ISS-7866 review: re-read when the window comes back. The connect handoff
    // finishes in the BROWSER, so without this the only read is the mount read
    // and the ask never clears — a user who connects successfully returns to a
    // strip still telling them to connect. `DesktopInsightsProvider` already
    // refreshes on the same two events for the same reason; this is the Sessions
    // strip catching up rather than a new mechanism.
    const refreshIfVisible = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      read();
    };
    globalThis.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      cancelled = true;
      globalThis.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, []);
  return status;
}

async function readOptionalDesktopGitHubIntegrationStatus(): Promise<GitHubIntegrationStatus | null> {
  // `desktopApi` is absent in a renderer mounted before the preload bridge
  // lands (and in test sites that never stub it), so the whole chain is
  // optional rather than only the method.
  return await (window.desktopApi?.getGitHubIntegrationStatus?.() ??
    Promise.resolve(null));
}
