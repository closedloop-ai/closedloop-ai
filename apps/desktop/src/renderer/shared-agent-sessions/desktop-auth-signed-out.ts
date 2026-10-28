// A VALUE import, not `import type`: `DesktopAuthStatus` is a const object and
// the comparisons below read its members at runtime.
import { DesktopAuthStatus } from "../../shared/contracts";

/**
 * Is the durable desktop session in a TERMINAL signed-out state?
 *
 * `SignedOut` and `RefreshFailed` are terminal. The transient `Loading`
 * (pre-restore) and the in-flight `OpeningBrowser` / `AwaitingRedirect` /
 * `Exchanging` are NOT: treating them as signed out puts an ask in front of a
 * user who is mid-restore or mid-OAuth, and leaves the control live during a
 * handoff that is already running.
 *
 * Hoisted out of the Sessions slice (ISS-7866 review) because it now has two
 * consumers and they MUST agree. `resolveGitHubGateConnected` turns a `false`
 * here into a hard, evidence-bearing "not connected" — so a surface that
 * derives its own strict `status === "authenticated"` instead of calling this
 * will assert a definite GitHub disconnect for the whole sign-in handoff and
 * prompt a user who is in the middle of connecting. That is exactly what the
 * Sessions strip did before ISS-7866 and what the Insights provider did after
 * it, from opposite sides of the same missing owner.
 */
export function isDesktopAuthSignedOut(status: DesktopAuthStatus): boolean {
  return (
    status === DesktopAuthStatus.SignedOut ||
    status === DesktopAuthStatus.RefreshFailed
  );
}

/**
 * Has the session reached a state we can reason from at all?
 *
 * `isDesktopAuthSignedOut` answers "is this user signed out", and its `false`
 * covers two very different things: genuinely signed in, and mid-flight. That
 * conflation is fine for choosing an empty state and WRONG for gating an ask —
 * `resolveGitHubGateConnected` treats a settled `authenticated: false` as hard
 * evidence, so a handoff read as "signed in" hands it a stale GitHub status and
 * it renders an actionable Connect CTA on top of a connect already running
 * (whitlockk, ISS-7866 review). A second click there only yields
 * `already_in_progress`.
 *
 * Settled means terminal: `Authenticated`, `SignedOut`, `RefreshFailed`.
 * `Loading` (pre-restore) and the in-flight `OpeningBrowser` /
 * `AwaitingRedirect` / `Exchanging` are not — whatever GitHub status we hold
 * during those is about to be replaced.
 */
export function isDesktopAuthSettled(status: DesktopAuthStatus): boolean {
  return (
    status === DesktopAuthStatus.Authenticated ||
    status === DesktopAuthStatus.SignedOut ||
    status === DesktopAuthStatus.RefreshFailed
  );
}
