"use client";

import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { CLERK_OAUTH_STRATEGY } from "@repo/app/shared/lib/clerk-oauth-strategy";
import { useCallback, useRef, useState } from "react";
import { describeClerkError } from "./clerk-error-message";
import type { ClerkExternalAccount, ClerkUser } from "./profile-identity";

/**
 * @file use-sign-in-method-actions.ts
 * @description The real connect / disconnect / retry mutations behind the
 * Settings Profile sign-in rows (ISS-8364). The prototype's overflow control is
 * decorative; this is the half that actually calls Clerk, and it exists as its
 * own module so the failure and reconciliation states are testable without a
 * render.
 *
 * GitHub connect deliberately NAVIGATES rather than calling
 * `createExternalAccount` here. `/connect/github/link` has been the sole
 * authorize front door since PLN-1742 M5 and already owns consent, the
 * `clerk-link` registry sync, and the `insufficient_scope` re-authorize. A
 * second implementation of that flow would be a copy that drifts, and it would
 * skip the registry sync outright. Google has no server-side registry, so it
 * connects in place — the asymmetry is the point, not an oversight.
 */

export type SignInMethodActionState = {
  pending: boolean;
  error: string | null;
  /**
   * A `destroy()` that succeeded followed by a `reload()` that did not. The row
   * knows the account is gone but cannot restate the user's identities, so it
   * says so instead of asserting a confident "disconnected" it did not observe.
   */
  unreconciled: boolean;
};

const IDLE_ACTION_STATE: SignInMethodActionState = {
  pending: false,
  error: null,
  unreconciled: false,
};

export type UseSignInMethodActionsInput = {
  /** `undefined` while Clerk loads — hooks run before the body's ready guard. */
  user: ClerkUser | null | undefined;
  /** From `useGitHubAuthorizeHref` — the one connect seam, never rebuilt here. */
  githubAuthorizeHref: string;
};

export type UseSignInMethodActions = {
  getActionState: (provider: string) => SignInMethodActionState;
  connect: (provider: string) => Promise<void>;
  disconnect: (provider: string) => Promise<void>;
  retry: (provider: string) => Promise<void>;
};

/**
 * EVERY identity this row's actions operate on. A row is about a PROVIDER, not
 * about one Clerk identity, and Clerk can hold several accounts for the same
 * provider. Acting on only the one the row DISPLAYS leaves the rest in place,
 * so "Disconnect GitHub" reports a removal the user still sees connected on the
 * next render — the stale-state defect AC3 forbids.
 */
function accountsFor(
  user: ClerkUser | null | undefined,
  provider: string
): ClerkExternalAccount[] {
  if (!user) {
    return [];
  }
  return user.externalAccounts.filter(
    (account) => account.provider === provider
  );
}

type ClerkOauthStrategy =
  (typeof CLERK_OAUTH_STRATEGY)[keyof typeof CLERK_OAUTH_STRATEGY];

/**
 * `Object.hasOwn`, never `in`: an unfiltered provider string must not resolve
 * `"constructor"` or another inherited key to a strategy.
 */
function isClerkOauthProvider(
  provider: string
): provider is keyof typeof CLERK_OAUTH_STRATEGY {
  return Object.hasOwn(CLERK_OAUTH_STRATEGY, provider);
}

function clerkStrategyFor(provider: string): ClerkOauthStrategy | null {
  return isClerkOauthProvider(provider) ? CLERK_OAUTH_STRATEGY[provider] : null;
}

const UNSUPPORTED_PROVIDER_MESSAGE =
  "This sign-in method can't be changed from here yet.";

const NO_REDIRECT_MESSAGE =
  "We couldn't start the sign-in flow. Try again in a moment.";

// Kept distinct from the unsupported-provider message: "we could not read your
// account" and "we do not support that provider" send a user to different
// remedies, and this hook must not answer one with the other.
const NO_USER_MESSAGE =
  "We couldn't read your account. Reload the page and try again.";

export function useSignInMethodActions(
  input: UseSignInMethodActionsInput
): UseSignInMethodActions {
  const { user, githubAuthorizeHref } = input;
  const [states, setStates] = useState<
    ReadonlyMap<string, SignInMethodActionState>
  >(() => new Map());
  // A ref, not the state above: React batches the setState, so two clicks in
  // one tick would both read `pending: false` and fire two Clerk calls. The
  // latch has to be readable synchronously to stop the second. It holds the
  // in-flight PROMISE rather than a marker, so a second caller waits on the
  // first outcome instead of getting a resolved promise — which a confirm
  // dialog would read as success and close on, mid-destroy.
  const inFlight = useRef<Map<string, Promise<void>>>(new Map());

  const patch = useCallback(
    (provider: string, next: Partial<SignInMethodActionState>) => {
      setStates((previous) => {
        const merged = new Map(previous);
        merged.set(provider, {
          ...(previous.get(provider) ?? IDLE_ACTION_STATE),
          ...next,
        });
        return merged;
      });
    },
    []
  );

  const getActionState = useCallback(
    (provider: string) => states.get(provider) ?? IDLE_ACTION_STATE,
    [states]
  );

  const run = useCallback(
    (provider: string, action: () => Promise<void>): Promise<void> => {
      const existing = inFlight.current.get(provider);
      if (existing !== undefined) {
        return existing;
      }
      patch(provider, { pending: true, error: null, unreconciled: false });
      const started = (async () => {
        try {
          await action();
        } catch (error) {
          patch(provider, { error: describeClerkError(error) });
        } finally {
          inFlight.current.delete(provider);
          patch(provider, { pending: false });
        }
      })();
      inFlight.current.set(provider, started);
      return started;
    },
    [patch]
  );

  /**
   * Restates the user from Clerk after a mutation, and records `unreconciled`
   * when that refresh fails. The mutation DID happen; only our copy of the user
   * is stale, so the row says it cannot restate the provider rather than
   * asserting a confident state it never observed.
   */
  const reconcileUser = useCallback(
    async (currentUser: ClerkUser, provider: string) => {
      try {
        await currentUser.reload();
      } catch {
        patch(provider, { unreconciled: true });
      }
    },
    [patch]
  );

  /**
   * Removes every identity for this provider and reports how many went. The
   * count is what decides whether a FAILED destroy still left our copy of the
   * user stale, so the loop is sequential: `Promise.all` would keep deleting
   * after the first rejection and lose that count.
   */
  const destroyProviderAccounts = useCallback(
    async (currentUser: ClerkUser, provider: string): Promise<number> => {
      let destroyed = 0;
      try {
        for (const account of accountsFor(currentUser, provider)) {
          await account.destroy();
          destroyed += 1;
        }
      } catch (error) {
        if (destroyed > 0) {
          await reconcileUser(currentUser, provider);
        }
        throw error;
      }
      return destroyed;
    },
    [reconcileUser]
  );

  const startOauthConnect = useCallback(
    async (provider: string) => {
      if (!user) {
        throw new Error(NO_USER_MESSAGE);
      }
      const strategy = clerkStrategyFor(provider);
      if (strategy === null) {
        throw new Error(UNSUPPORTED_PROVIDER_MESSAGE);
      }
      const created = await user.createExternalAccount({
        redirectUrl: globalThis.location.href,
        strategy,
      });
      const redirectUrl =
        created.verification?.externalVerificationRedirectURL ?? null;
      if (redirectUrl === null) {
        // Clerk HAS created the account by this point; only the consent URL is
        // missing. `createExternalAccount` returns the new resource without
        // refreshing `user.externalAccounts`, so skipping this leaves the row
        // reading "not connected" and the next Connect adds a SECOND unverified
        // identity for the same provider.
        await reconcileUser(user, provider);
        throw new Error(NO_REDIRECT_MESSAGE);
      }
      globalThis.location.assign(redirectUrl.href);
    },
    [reconcileUser, user]
  );

  const connect = useCallback(
    (provider: string) =>
      run(provider, async () => {
        if (provider === DesktopSignInProvider.GitHub) {
          globalThis.location.assign(githubAuthorizeHref);
          return;
        }
        await startOauthConnect(provider);
      }),
    [githubAuthorizeHref, run, startOauthConnect]
  );

  const disconnect = useCallback(
    (provider: string) =>
      run(provider, async () => {
        if (!user) {
          return;
        }
        const destroyed = await destroyProviderAccounts(user, provider);
        if (destroyed > 0) {
          await reconcileUser(user, provider);
        }
      }),
    [destroyProviderAccounts, reconcileUser, run, user]
  );

  const retry = useCallback(
    (provider: string) =>
      run(provider, async () => {
        if (provider === DesktopSignInProvider.GitHub) {
          // The link page destroys the stale account and recreates it; doing
          // it here too would race that page for the same resource.
          globalThis.location.assign(githubAuthorizeHref);
          return;
        }
        // Refuse BEFORE the destroy. Reversing these two lines is how a
        // provider we cannot re-create gets deleted and then reported as
        // "can't be changed from here" — the identity is already gone by
        // then, and this panel has no way to put it back.
        if (clerkStrategyFor(provider) === null) {
          throw new Error(UNSUPPORTED_PROVIDER_MESSAGE);
        }
        if (!user) {
          throw new Error(NO_USER_MESSAGE);
        }
        const destroyed = await destroyProviderAccounts(user, provider);
        try {
          await startOauthConnect(provider);
        } catch (error) {
          if (destroyed > 0) {
            await reconcileUser(user, provider);
          }
          throw error;
        }
      }),
    [
      destroyProviderAccounts,
      githubAuthorizeHref,
      reconcileUser,
      run,
      startOauthConnect,
      user,
    ]
  );

  return { getActionState, connect, disconnect, retry };
}
