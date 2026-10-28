import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import type { DesktopSessionTokens } from "./desktop-session-client.js";

/**
 * ISS-11345: what a caller supplies to make a browser sign-in wait for the user
 * to confirm the account before it is adopted. The system browser chooses the
 * account, so on a shared browser the redeemed session can belong to someone
 * else; confirming is the only point Desktop's user gets to see who.
 */
export type DesktopSignInConfirmation = {
  /**
   * Fired once the account is known and the run is waiting on the user. The
   * user is still in the browser at that moment, so this is where the window
   * that must be answered is brought forward.
   */
  onAwaitingConfirmation?: () => void;
};

/**
 * Whether the identity read with the redeemed access token describes the SAME
 * user and org the redeem returned. Anything else — no identity, or one for a
 * different account — means the user cannot be shown who they would become,
 * so the caller must not adopt the session.
 */
export function isRedeemedAccount(
  account: DesktopIdentity | null,
  tokens: DesktopSessionTokens
): account is DesktopIdentity {
  return (
    account !== null &&
    account.userId === tokens.userId &&
    account.organizationId === tokens.organizationId
  );
}

/**
 * The user's answer to one confirmation: `true` only when `confirm` is called
 * before `signal` aborts. A cancel, a sign-out, or a superseding sign-in all
 * abort the run, and every one of them reads as "not confirmed".
 */
export function waitForSignInConfirmation(signal: AbortSignal): {
  decision: Promise<boolean>;
  confirm: () => void;
} {
  let settle: (confirmed: boolean) => void = () => undefined;
  const decision = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const onAbort = () => settle(false);
  if (signal.aborted) {
    settle(false);
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    decision,
    confirm: () => {
      signal.removeEventListener("abort", onAbort);
      settle(!signal.aborted);
    },
  };
}
