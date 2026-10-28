import { BrowserSessionErrorCode } from "@repo/api/src/types/browser-session";
import { ApiError } from "../../../../shared/api/api-error";
import {
  classifySettingsPanelError,
  SettingsPanelDataState,
} from "../../lib/settings-panel-data-state";

/**
 * What a failed browser-session revoke actually means (PLN-1915 Step 3).
 *
 * The route answers three CODED refusals and they are not interchangeable: the
 * caller's own current session (409), a session that is gone or was never
 * theirs (404), and a provider it could not reach (503). A generic "that didn't
 * work" would tell a user to retry the first one forever, and would report the
 * second — where the outcome they asked for has already happened — as a failure.
 *
 * Pure, so every branch is reachable without mounting the panel.
 */

export type BrowserSessionRevokeOutcome =
  /** A coded refusal this domain answers for in its own words. */
  | { kind: "coded"; code: BrowserSessionErrorCode; message: string }
  /** Everything else, handed to the shared write-outcome alert. */
  | { kind: "state"; state: SettingsPanelDataState };

/**
 * Keyed EXHAUSTIVELY by the contract's code set so a new refusal fails `tsc`
 * here rather than arriving in production as an unexplained failure.
 *
 * `ProviderUnavailable` is deliberately `null`: it comes back as a 503, which
 * the canonical classification already turns into `Unavailable`, and
 * `SettingsWriteOutcomeAlert` owns that sentence for every Settings panel. A
 * second wording here would be the same outcome said two ways.
 */
const BROWSER_SESSION_REVOKE_MESSAGE: Record<
  BrowserSessionErrorCode,
  string | null
> = {
  [BrowserSessionErrorCode.CurrentSessionNotRevocable]:
    "That's the session you're signed in with right now. Use Sign out to end it. Nothing was changed.",
  [BrowserSessionErrorCode.SessionNotFound]:
    "That session is no longer active, so there was nothing to sign out. The list has been refreshed.",
  [BrowserSessionErrorCode.ProviderUnavailable]: null,
};

const BROWSER_SESSION_ERROR_CODES: readonly string[] = Object.values(
  BrowserSessionErrorCode
);

/**
 * The neutral refusal sentence for this domain.
 *
 * Revoke carries NO role gate — the route scopes every session to the
 * authenticated caller — so telling a user to ask an admin would send them
 * after a permission nobody holds.
 */
export const BROWSER_SESSION_REVOKE_FORBIDDEN_MESSAGE =
  "You aren't allowed to sign that session out. Nothing was changed.";

/**
 * Canonical classification first, code-specific override second, and the
 * override applies ONLY to the generic `Failed` family. A 403 or a 503 keeps
 * its canonical meaning whatever code travelled with it, so a category label
 * can never demote a real authorization or availability answer.
 */
export function classifyBrowserSessionRevokeError(
  error: unknown
): BrowserSessionRevokeOutcome {
  const state = classifySettingsPanelError(error);
  if (state !== SettingsPanelDataState.Failed) {
    return { kind: "state", state };
  }
  const code = toBrowserSessionErrorCode(
    error instanceof ApiError ? error.code : undefined
  );
  const message = code === null ? null : BROWSER_SESSION_REVOKE_MESSAGE[code];
  if (code === null || message === null) {
    return { kind: "state", state };
  }
  return { kind: "coded", code, message };
}

/**
 * Membership-checked rather than a bare index: the code is server-supplied, and
 * a plain-object lookup on `__proto__` or `constructor` would answer with
 * something that is not a message.
 */
function toBrowserSessionErrorCode(
  value: unknown
): BrowserSessionErrorCode | null {
  return typeof value === "string" &&
    BROWSER_SESSION_ERROR_CODES.includes(value)
    ? (value as BrowserSessionErrorCode)
    : null;
}
