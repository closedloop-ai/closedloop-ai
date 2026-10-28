import {
  OnboardingAccountMode as Mode,
  OnboardingFailureReason as Reason,
} from "@repo/api/src/types/onboarding-analytics.ts";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred.js";
import {
  createLoopbackStub,
  createManager,
  installTempRoot,
} from "./helpers/desktop-session-manager-fixtures.js";

installTempRoot();

function setup() {
  const stub = createLoopbackStub();
  const analytics = { register: vi.fn(), failed: vi.fn() };
  const { manager } = createManager({
    browserSignIn: stub.deps,
    beginSignInAnalytics: () => analytics,
  });
  return { ...stub, manager, analytics };
}

describe("ISS-11127 sign-in failure analytics", () => {
  it.each([false, true])(
    "preserves creation=%s when redeem fails",
    async (created) => {
      const { state, manager, analytics } = setup();
      state.callbackValue.accountCreated = created;
      state.redeemResult = { ok: false, error: "network", retryable: true };
      await manager.beginBrowserSignIn();
      expect(analytics.failed).toHaveBeenCalledExactlyOnceWith(
        created ? [Mode.Created, Mode.LoggedOut] : [Mode.CreationUnconfirmed],
        Reason.ExchangeFailed
      );
    }
  );
  it.each([
    "descriptorThrows",
    "listenerStartRejects",
    "openShouldThrow",
  ] as const)("classifies %s before browser opens", async (field) => {
    const { state, manager, analytics } = setup();
    state[field] = true;
    await manager.beginBrowserSignIn();
    expect(analytics.failed).toHaveBeenCalledExactlyOnceWith(
      [Mode.CreationUnattempted],
      field === "openShouldThrow" ? Reason.OpenFailed : Reason.StartFailed
    );
  });
  it("reports timeout without inventing creation", async () => {
    const { state, manager, analytics } = setup();
    state.callbackGate = deferred<void>();
    state.timeoutFires = true;
    await manager.beginBrowserSignIn();
    expect(analytics.failed).toHaveBeenCalledExactlyOnceWith(
      [Mode.CreationUnconfirmed],
      Reason.RedirectTimeout
    );
    state.callbackGate.resolve();
  });
  it("rejects a mismatched callback's creation marker", async () => {
    const { state, manager, analytics } = setup();
    state.callbackValue.state = "other-run";
    state.callbackValue.accountCreated = true;
    await manager.beginBrowserSignIn();
    expect(analytics.failed).toHaveBeenCalledExactlyOnceWith(
      [Mode.CreationUnconfirmed],
      Reason.StateMismatch
    );
  });
  it("reports expired code", async () => {
    const { state, manager, analytics } = setup();
    state.redeemResult = { ok: false, error: "invalid", retryable: false };
    await manager.beginBrowserSignIn();
    expect(analytics.failed).toHaveBeenCalledExactlyOnceWith(
      [Mode.CreationUnconfirmed],
      Reason.Expired
    );
  });
  it.each(["cancel", "signOut"] as const)(
    "keeps creation on %s during redeem, once",
    async (action) => {
      const { state, manager, analytics } = setup();
      state.callbackValue.accountCreated = true;
      let signedOut = Promise.resolve();
      state.onRedeem = () => {
        if (action === "cancel") {
          manager.cancelSignIn();
        } else {
          signedOut = manager.signOut();
        }
      };
      await manager.beginBrowserSignIn();
      await signedOut;
      expect(analytics.failed).toHaveBeenCalledExactlyOnceWith(
        [Mode.Created, Mode.LoggedOut],
        Reason.Cancelled
      );
    }
  );
  it("counts the browser as opened once the open is requested", async () => {
    const { state, manager, analytics } = setup();
    state.openGate = deferred<void>();
    const signIn = manager.beginBrowserSignIn();
    await vi.waitFor(() => expect(state.openCalls).toHaveLength(1));
    manager.cancelSignIn();
    state.openGate.resolve(undefined);
    await signIn;
    expect(analytics.failed).toHaveBeenCalledExactlyOnceWith(
      [Mode.CreationUnconfirmed],
      Reason.Cancelled
    );
  });
  it("reports browser consent cancellation", async () => {
    const { state, manager, analytics } = setup();
    state.callbackValue.error = "access_denied";
    state.callbackValue.code = null;
    await manager.beginBrowserSignIn();
    expect(analytics.failed).toHaveBeenCalledExactlyOnceWith(
      [Mode.CreationUnconfirmed],
      Reason.Cancelled
    );
  });
  it("does not report a successful or rejected duplicate run", async () => {
    const { manager, analytics } = setup();
    expect(await manager.beginBrowserSignIn()).toEqual({ ok: true });
    await manager.beginBrowserSignIn();
    expect(analytics.failed).not.toHaveBeenCalled();
  });
  it("registers the challenge before the browser opens the authorize URL", async () => {
    const { state, manager, analytics } = setup();
    const opensAtRegister: number[] = [];
    analytics.register.mockImplementation(() => {
      opensAtRegister.push(state.openCalls.length);
    });
    await manager.beginBrowserSignIn();
    expect(opensAtRegister).toEqual([0]);
    expect(state.openCalls).toHaveLength(1);
    const openedChallenge = new URL(state.openCalls[0]).searchParams.get(
      "code_challenge"
    );
    expect(analytics.register).toHaveBeenCalledExactlyOnceWith(openedChallenge);
  });
  it("opens and authenticates despite a throwing registration port", async () => {
    const { state, manager, analytics } = setup();
    analytics.register.mockImplementation(() => {
      throw new Error("registration failed");
    });
    expect(await manager.beginBrowserSignIn()).toEqual({ ok: true });
    expect(state.openCalls).toHaveLength(1);
  });
});

it("a superseded run reports once and cannot report for the succeeding run", async () => {
  const { state, deps } = createLoopbackStub();
  const first = { register: vi.fn(), failed: vi.fn() };
  const second = { register: vi.fn(), failed: vi.fn() };
  const beginAnalytics = vi
    .fn()
    .mockReturnValueOnce(first)
    .mockReturnValueOnce(second);
  const entered = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  deps.redeem = async () => {
    calls += 1;
    if (calls === 1) {
      entered.resolve();
      await release.promise;
      return { ok: false, error: "network", retryable: true };
    }
    return state.redeemResult;
  };
  const { manager } = createManager({
    browserSignIn: deps,
    beginSignInAnalytics: beginAnalytics,
  });
  state.callbackValue.accountCreated = true;
  const pending = manager.beginBrowserSignIn();
  await entered.promise;
  manager.cancelSignIn();
  state.callbackValue.accountCreated = false;
  expect(await manager.beginBrowserSignIn()).toEqual({ ok: true });
  release.resolve();
  expect(await pending).toEqual({ ok: false, reason: "cancelled" });
  expect(first.failed).toHaveBeenCalledExactlyOnceWith(
    [Mode.Created, Mode.LoggedOut],
    Reason.Cancelled
  );
  expect(second.failed).not.toHaveBeenCalled();
});
