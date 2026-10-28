import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClerkUser } from "../profile-identity";
import { useSignInMethodActions } from "../use-sign-in-method-actions";

const AUTHORIZE_HREF = "/connect/github/link?returnTo=%2Facme%2Fsettings";
const GOOGLE_CONSENT_URL = "https://accounts.google.com/consent";

function stubLocation() {
  const assign = vi.fn();
  vi.stubGlobal("location", {
    assign,
    href: "http://localhost:3000/acme/settings",
  });
  return assign;
}

function fakeAccount(provider: string, verificationStatus = "verified") {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
    provider,
    verification: { status: verificationStatus },
  };
}

function fakeUser(options: {
  accounts?: ReturnType<typeof fakeAccount>[];
  createExternalAccount?: ReturnType<typeof vi.fn>;
  reload?: ReturnType<typeof vi.fn>;
}) {
  return {
    createExternalAccount:
      options.createExternalAccount ??
      vi.fn().mockResolvedValue({
        verification: {
          externalVerificationRedirectURL: new URL(GOOGLE_CONSENT_URL),
        },
      }),
    externalAccounts: options.accounts ?? [],
    reload: options.reload ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as ClerkUser;
}

function renderActions(user: ClerkUser | null) {
  return renderHook(() =>
    useSignInMethodActions({ githubAuthorizeHref: AUTHORIZE_HREF, user })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connect", () => {
  it("sends GitHub to the shared authorize seam instead of re-running the link flow here", async () => {
    // `/connect/github/link` has been the sole authorize front door since
    // PLN-1742 M5 and owns the registry sync. Calling `createExternalAccount`
    // here would be a second copy of that flow that skips the sync.
    const assign = stubLocation();
    const createExternalAccount = vi.fn();
    const { result } = renderActions(fakeUser({ createExternalAccount }));

    await act(() => result.current.connect(DesktopSignInProvider.GitHub));

    expect(assign).toHaveBeenCalledWith(AUTHORIZE_HREF);
    expect(createExternalAccount).not.toHaveBeenCalled();
  });

  it("creates a Google external account and follows Clerk's consent redirect", async () => {
    const assign = stubLocation();
    const createExternalAccount = vi.fn().mockResolvedValue({
      verification: {
        externalVerificationRedirectURL: new URL(GOOGLE_CONSENT_URL),
      },
    });
    const { result } = renderActions(fakeUser({ createExternalAccount }));

    await act(() => result.current.connect(DesktopSignInProvider.Google));

    // Deliberate literal, matching the precedent at
    // `connect/github/__tests__/github-connect-redirect-client.test.tsx:44-50`:
    // this is the value that leaves for Clerk, so the assertion has to fail
    // when CLERK_OAUTH_STRATEGY changes rather than move with it.
    expect(createExternalAccount).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "oauth_google" })
    );
    expect(assign).toHaveBeenCalledWith(GOOGLE_CONSENT_URL);
  });

  it("reports an error and navigates nowhere when Clerk returns no consent url", async () => {
    const assign = stubLocation();
    const createExternalAccount = vi
      .fn()
      .mockResolvedValue({ verification: null });
    const { result } = renderActions(fakeUser({ createExternalAccount }));

    await act(() => result.current.connect(DesktopSignInProvider.Google));

    expect(assign).not.toHaveBeenCalled();
    expect(
      result.current.getActionState(DesktopSignInProvider.Google).error
    ).not.toBeNull();
  });

  it("refreshes the user when Clerk created the account but returned no consent url", async () => {
    // Clerk HAS created the account by then, and `createExternalAccount`
    // returns only the new resource. Without this reload the row still reads
    // "not connected" and the next Connect adds a SECOND unverified identity.
    stubLocation();
    const reload = vi.fn().mockResolvedValue(undefined);
    const createExternalAccount = vi
      .fn()
      .mockResolvedValue({ verification: null });
    const { result } = renderActions(
      fakeUser({ createExternalAccount, reload })
    );

    await act(() => result.current.connect(DesktopSignInProvider.Google));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reports an unreconciled state when that post-create refresh also fails", async () => {
    // The account exists and the panel cannot restate the provider, which is a
    // different fact from the plain "we could not start the flow" error.
    stubLocation();
    const reload = vi.fn().mockRejectedValue(new Error("offline"));
    const createExternalAccount = vi
      .fn()
      .mockResolvedValue({ verification: null });
    const { result } = renderActions(
      fakeUser({ createExternalAccount, reload })
    );

    await act(() => result.current.connect(DesktopSignInProvider.Google));

    expect(
      result.current.getActionState(DesktopSignInProvider.Google).unreconciled
    ).toBe(true);
  });

  it("surfaces a rejected Clerk call as the row's error", async () => {
    stubLocation();
    const createExternalAccount = vi.fn().mockRejectedValue({
      errors: [{ longMessage: "That provider is disabled for this instance." }],
    });
    const { result } = renderActions(fakeUser({ createExternalAccount }));

    await act(() => result.current.connect(DesktopSignInProvider.Google));

    expect(
      result.current.getActionState(DesktopSignInProvider.Google).error
    ).toBe("That provider is disabled for this instance.");
  });
});

describe("in-flight latching", () => {
  it("makes exactly one Clerk call when two clicks land in the same tick", async () => {
    // The latch has to be a ref, not state: React batches the pending update,
    // so both handlers would read `pending: false` and both would fire.
    stubLocation();
    let release: (() => void) | undefined;
    const createExternalAccount = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ verification: null });
      })
    );
    const { result } = renderActions(fakeUser({ createExternalAccount }));

    let both: Promise<unknown> | undefined;
    act(() => {
      both = Promise.all([
        result.current.connect(DesktopSignInProvider.Google),
        result.current.connect(DesktopSignInProvider.Google),
      ]);
    });
    release?.();
    await act(async () => {
      await both;
    });

    expect(createExternalAccount).toHaveBeenCalledTimes(1);
  });

  it("latches per provider, leaving the other row usable", async () => {
    stubLocation();
    let release: (() => void) | undefined;
    const createExternalAccount = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ verification: null });
      })
    );
    const { result } = renderActions(fakeUser({ createExternalAccount }));

    let pending: Promise<unknown> | undefined;
    act(() => {
      pending = result.current.connect(DesktopSignInProvider.Google);
    });

    await waitFor(() => {
      expect(
        result.current.getActionState(DesktopSignInProvider.Google).pending
      ).toBe(true);
    });
    expect(
      result.current.getActionState(DesktopSignInProvider.GitHub).pending
    ).toBe(false);

    release?.();
    await act(async () => {
      await pending;
    });
  });
});

describe("disconnect", () => {
  it("hands a second select the in-flight promise instead of an instant resolve", async () => {
    // Disconnect fires on menu select with no confirm step, so a double click
    // lands two calls in one tick. The second must ride the first destroy(),
    // not report done while it is still running.
    stubLocation();
    let release: (() => void) | undefined;
    const account = fakeAccount(DesktopSignInProvider.GitHub);
    account.destroy.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      })
    );
    const { result } = renderActions(fakeUser({ accounts: [account] }));

    let settled = false;
    let both: Promise<unknown> | undefined;
    act(() => {
      const first = result.current.disconnect(DesktopSignInProvider.GitHub);
      const second = result.current.disconnect(DesktopSignInProvider.GitHub);
      both = Promise.all([first, second]).then(() => {
        settled = true;
      });
    });

    await waitFor(() => {
      expect(account.destroy).toHaveBeenCalledTimes(1);
    });
    expect(settled).toBe(false);

    release?.();
    await act(async () => {
      await both;
    });
    expect(settled).toBe(true);
  });

  it("destroys the account and then reloads the user, in that order", async () => {
    stubLocation();
    const order: string[] = [];
    const account = fakeAccount(DesktopSignInProvider.GitHub);
    account.destroy.mockImplementation(() => {
      order.push("destroy");
      return Promise.resolve();
    });
    const reload = vi.fn().mockImplementation(() => {
      order.push("reload");
      return Promise.resolve();
    });
    const { result } = renderActions(fakeUser({ accounts: [account], reload }));

    await act(() => result.current.disconnect(DesktopSignInProvider.GitHub));

    expect(order).toEqual(["destroy", "reload"]);
  });

  it("destroys EVERY identity for the provider, not only the one the row shows", async () => {
    // A row is about a PROVIDER. Acting on just the displayed account leaves
    // the other identity in place, so the dialog reports a removal the user can
    // still see on the next render.
    stubLocation();
    const stale = fakeAccount(DesktopSignInProvider.GitHub, "unverified");
    const live = fakeAccount(DesktopSignInProvider.GitHub, "verified");
    const { result } = renderActions(fakeUser({ accounts: [stale, live] }));

    await act(() => result.current.disconnect(DesktopSignInProvider.GitHub));

    expect(live.destroy).toHaveBeenCalledTimes(1);
    expect(stale.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys both of TWO VERIFIED accounts for one provider, and no other provider's", async () => {
    // The display rule prefers a verified account, so with two of them it
    // returns the first. A mutation reusing that choice removes one identity,
    // reports success, and leaves the provider connected.
    stubLocation();
    const first = fakeAccount(DesktopSignInProvider.Google, "verified");
    const second = fakeAccount(DesktopSignInProvider.Google, "verified");
    const untouched = fakeAccount(DesktopSignInProvider.GitHub, "verified");
    const { result } = renderActions(
      fakeUser({ accounts: [first, second, untouched] })
    );

    await act(() => result.current.disconnect(DesktopSignInProvider.Google));

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).toHaveBeenCalledTimes(1);
    expect(untouched.destroy).not.toHaveBeenCalled();
  });

  it("refreshes the user when only SOME of the identities were removed", async () => {
    // One identity is gone and one is not. Reporting the bare failure would
    // leave the row asserting an account that no longer exists.
    stubLocation();
    const removed = fakeAccount(DesktopSignInProvider.Google, "verified");
    const kept = fakeAccount(DesktopSignInProvider.Google, "verified");
    kept.destroy.mockRejectedValue({
      errors: [{ longMessage: "You cannot remove your last sign-in method." }],
    });
    const reload = vi.fn().mockResolvedValue(undefined);
    const { result } = renderActions(
      fakeUser({ accounts: [removed, kept], reload })
    );

    await act(async () => {
      await expect(
        result.current.disconnect(DesktopSignInProvider.Google)
      ).resolves.toBeUndefined();
    });

    expect(removed.destroy).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(
      result.current.getActionState(DesktopSignInProvider.Google).error
    ).toBe("You cannot remove your last sign-in method.");
  });

  it("makes no Clerk call for a provider the user holds no account for", async () => {
    stubLocation();
    const reload = vi.fn();
    const { result } = renderActions(fakeUser({ accounts: [], reload }));

    await act(() => result.current.disconnect(DesktopSignInProvider.GitHub));

    expect(reload).not.toHaveBeenCalled();
  });

  it("resolves after recording the error on the row, never rejecting into the menu", async () => {
    // The caller is a menu `onSelect`, which nothing awaits. A rejection here
    // would be an unhandled promise; the row's error state is the only place
    // the refusal can land.
    stubLocation();
    const account = fakeAccount(DesktopSignInProvider.GitHub);
    account.destroy.mockRejectedValue({
      errors: [{ longMessage: "You cannot remove your last sign-in method." }],
    });
    const reload = vi.fn();
    const { result } = renderActions(fakeUser({ accounts: [account], reload }));

    await act(async () => {
      await expect(
        result.current.disconnect(DesktopSignInProvider.GitHub)
      ).resolves.toBeUndefined();
    });

    expect(
      result.current.getActionState(DesktopSignInProvider.GitHub).error
    ).toBe("You cannot remove your last sign-in method.");
    expect(reload).not.toHaveBeenCalled();
  });

  it("reports an unreconciled removal when the reload fails after a successful destroy", async () => {
    stubLocation();
    const account = fakeAccount(DesktopSignInProvider.GitHub);
    const reload = vi.fn().mockRejectedValue(new Error("network down"));
    const { result } = renderActions(fakeUser({ accounts: [account], reload }));

    await act(() => result.current.disconnect(DesktopSignInProvider.GitHub));

    const state = result.current.getActionState(DesktopSignInProvider.GitHub);
    expect(account.destroy).toHaveBeenCalledTimes(1);
    expect(state.unreconciled).toBe(true);
    expect(state.error).toBeNull();
  });
});

describe("retry", () => {
  it("sends a stale GitHub account back to the link page, which owns destroy-and-recreate", async () => {
    const assign = stubLocation();
    const account = fakeAccount(DesktopSignInProvider.GitHub);
    const { result } = renderActions(fakeUser({ accounts: [account] }));

    await act(() => result.current.retry(DesktopSignInProvider.GitHub));

    expect(assign).toHaveBeenCalledWith(AUTHORIZE_HREF);
    expect(account.destroy).not.toHaveBeenCalled();
  });

  it("refuses an unsupported provider WITHOUT destroying its account", async () => {
    // The blocker this guard exists for: destroy-then-validate deleted a
    // sign-in identity the panel has no strategy to re-create, then reported
    // "can't be changed from here" about an account that was already gone.
    stubLocation();
    const account = fakeAccount("gitlab");
    const createExternalAccount = vi.fn();
    const { result } = renderActions(
      fakeUser({ accounts: [account], createExternalAccount })
    );

    await act(() => result.current.retry("gitlab"));

    expect(account.destroy).not.toHaveBeenCalled();
    expect(createExternalAccount).not.toHaveBeenCalled();
    expect(result.current.getActionState("gitlab").error).not.toBeNull();
  });

  it("refreshes the user when the re-create fails after the destroy succeeded", async () => {
    // The account is gone at that point, so leaving the stale user in place
    // would keep the row asserting an identity that no longer exists.
    stubLocation();
    const account = fakeAccount(DesktopSignInProvider.Google);
    const reload = vi.fn().mockResolvedValue(undefined);
    const createExternalAccount = vi
      .fn()
      .mockRejectedValue(new Error("network down"));
    const { result } = renderActions(
      fakeUser({ accounts: [account], createExternalAccount, reload })
    );

    await act(() => result.current.retry(DesktopSignInProvider.Google));

    expect(account.destroy).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(
      result.current.getActionState(DesktopSignInProvider.Google).error
    ).toBe("network down");
  });

  it("reports an unreconciled state when the post-destroy reload also fails", async () => {
    // Destroy succeeded, re-create failed, refresh failed: the panel cannot say
    // what this provider's state is, and a bare "that failed" would imply the
    // account survived.
    stubLocation();
    const account = fakeAccount(DesktopSignInProvider.Google, "unverified");
    const reload = vi.fn().mockRejectedValue(new Error("offline"));
    const createExternalAccount = vi
      .fn()
      .mockRejectedValue(new Error("network down"));
    const { result } = renderActions(
      fakeUser({ accounts: [account], createExternalAccount, reload })
    );

    await act(() => result.current.retry(DesktopSignInProvider.Google));

    const state = result.current.getActionState(DesktopSignInProvider.Google);
    expect(account.destroy).toHaveBeenCalledTimes(1);
    expect(state.unreconciled).toBe(true);
  });

  it("destroys a stale Google account before creating a fresh one", async () => {
    // Clerk will not verify an existing unverified account retroactively, so
    // recreating without destroying leaves the stale one in place forever.
    // The ORDER is the contract, so it is asserted: call counts alone stay
    // green if the two awaits are swapped or run through Promise.all.
    const assign = stubLocation();
    const order: string[] = [];
    const account = fakeAccount(DesktopSignInProvider.Google);
    account.destroy.mockImplementation(() => {
      order.push("destroy");
      return Promise.resolve();
    });
    const createExternalAccount = vi.fn().mockImplementation(() => {
      order.push("create");
      return Promise.resolve({
        verification: {
          externalVerificationRedirectURL: new URL(GOOGLE_CONSENT_URL),
        },
      });
    });
    const { result } = renderActions(
      fakeUser({ accounts: [account], createExternalAccount })
    );

    await act(() => result.current.retry(DesktopSignInProvider.Google));

    expect(order).toEqual(["destroy", "create"]);
    expect(assign).toHaveBeenCalledWith(GOOGLE_CONSENT_URL);
  });

  it("clears every stale identity for the provider before creating a fresh one", async () => {
    // Leaving a duplicate behind keeps the row reading "not finished" after a
    // retry that did complete, because the derivation still sees an unverified
    // account for the provider.
    const assign = stubLocation();
    const first = fakeAccount(DesktopSignInProvider.Google, "unverified");
    const second = fakeAccount(DesktopSignInProvider.Google, "unverified");
    const { result } = renderActions(fakeUser({ accounts: [first, second] }));

    await act(() => result.current.retry(DesktopSignInProvider.Google));

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(GOOGLE_CONSENT_URL);
  });

  it("refuses a provider whose name collides with an Object prototype member", async () => {
    // `"constructor" in CLERK_OAUTH_STRATEGY` is TRUE. If the strategy lookup
    // used `in` rather than `Object.hasOwn`, this would hand Clerk the Object
    // constructor as a sign-in strategy. `"gitlab"` cannot catch that — it is
    // absent under either form.
    stubLocation();
    const createExternalAccount = vi.fn();
    const { result } = renderActions(fakeUser({ createExternalAccount }));

    await act(() => result.current.connect("constructor"));

    expect(createExternalAccount).not.toHaveBeenCalled();
    expect(result.current.getActionState("constructor").error).not.toBeNull();
  });
});
