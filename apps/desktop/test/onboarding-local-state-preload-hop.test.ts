/**
 * @file onboarding-local-state-preload-hop.test.ts
 * @description ISS-8376 — the ONE link nothing else covers: the
 * `createOnboardingLocalStateDesktopApi` spread in `preload-common.ts` that
 * names the channel.
 *
 * The ticket's brief names this trap directly: a shared IPC channel union
 * derives from a SIDE LIST, so a new channel can typecheck and still never
 * dispatch. Both ends of this feature have their own suites — the registrar is
 * driven directly by `onboarding-local-state-ipc.test.ts`, the adapter against a
 * stubbed `window.desktopApi` — and both stay green if the spread is dropped or
 * aimed at a channel main does not register, while every shipped build answers
 * "no handler registered".
 *
 * `desktop-db-ipc-channel-parity.test.ts` does NOT cover this: its scope is the
 * `DbGuardedChannel` prefixes only, and this is a plain `desktop:` channel. So
 * this suite is the only guard.
 *
 * The chain runs in one pass: the REAL `createDesktopApi` → an `ipcRenderer`
 * stand-in wired to the REAL registered `ipcMain` handler → the REAL source →
 * the REAL boundary parser the renderer adapter uses. The only test double is
 * the IPC transport edge.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  type OnboardingLocalStateIpcDeps,
  registerOnboardingLocalStateIpcHandlers,
} from "../src/main/ipc/onboarding-local-state-ipc.js";
import { createOnboardingLocalStateSource } from "../src/main/onboarding/onboarding-local-state-source.js";
import { createDesktopApi } from "../src/main/preload-common.js";
import {
  ONBOARDING_INVENTORY_NO_REVISION,
  OnboardingInventoryStatus,
} from "../src/shared/onboarding-local-state-contract.js";
import { parseOnboardingLocalState } from "../src/shared/onboarding-local-state-parse.js";

const TRUSTED_SENDER = { id: "trusted-renderer" };

const UNTRUSTED_SENDER_PATTERN = /untrusted sender/;

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

function makeDeps(
  overrides: Partial<OnboardingLocalStateIpcDeps> = {}
): OnboardingLocalStateIpcDeps {
  return {
    isTrustedSender: (sender) => sender === TRUSTED_SENDER,
    isRendererWindowGone: () => false,
    source: createOnboardingLocalStateSource({
      transcriptStateDir: () => "/tmp/iss-8376-state",
      getComputeTargetId: () => "ct-01",
      // Never resolves: pins the pre-sweep answer, which is the state every
      // machine is in when the analysis step first mounts.
      runSweep: () => new Promise(() => undefined),
    }),
    ...overrides,
  };
}

/**
 * Everything between the two process edges, wired the way
 * `desktop-ipc-registration.ts` wires it. The renderer never sees a handler
 * map — only what `createDesktopApi` composed.
 */
function createHop(overrides: Partial<OnboardingLocalStateIpcDeps> = {}) {
  const handlers = new Map<string, IpcHandler>();
  const invokedChannels: string[] = [];

  registerOnboardingLocalStateIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    makeDeps(overrides)
  );

  const desktopApi = createDesktopApi({
    // The transport edge: carry the channel to the registered main handler
    // exactly as Electron's `ipcRenderer.invoke` would.
    invoke: (channel: string, ...args: unknown[]) => {
      invokedChannels.push(channel);
      const handler = handlers.get(channel);
      if (!handler) {
        return Promise.reject(
          new Error(`no main handler registered for ${channel}`)
        );
      }
      return Promise.resolve(handler({ sender: TRUSTED_SENDER }, ...args));
    },
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
  });

  return { desktopApi, invokedChannels };
}

describe("onboarding local-state preload hop (ISS-8376)", () => {
  test("createDesktopApi composes getOnboardingLocalState onto the channel main registers", async () => {
    const { desktopApi, invokedChannels } = createHop();

    assert.equal(
      typeof desktopApi.getOnboardingLocalState,
      "function",
      "createDesktopApi must expose getOnboardingLocalState; a dropped spread ships as a missing bridge"
    );

    const payload = await desktopApi.getOnboardingLocalState?.();

    // Independent literal, not the exported constant: a channel renamed on the
    // preload side only must fail here rather than pass by construction.
    assert.deepEqual(invokedChannels, ["desktop:get-onboarding-local-state"]);
    assert.ok(payload, "the handler answered");
  });

  test("the payload crossing the preload hop satisfies the renderer's boundary parser", async () => {
    const { desktopApi } = createHop();

    const parsed = parseOnboardingLocalState(
      await desktopApi.getOnboardingLocalState?.()
    );

    assert.notEqual(
      parsed,
      null,
      "the shipped producer's payload must clear the renderer's own parser"
    );
    assert.equal(parsed?.computeTargetId, "ct-01");
    // Before the sweep lands there is no measurement — and that is reported as
    // its own state, never as a zero byte count.
    assert.equal(
      parsed?.inventory.status,
      OnboardingInventoryStatus.Unavailable
    );
    assert.equal(
      parsed?.analysisEta.inventoryRevision,
      ONBOARDING_INVENTORY_NO_REVISION
    );
  });

  test("the attemptId the renderer sends is echoed back through the real hop", async () => {
    const { desktopApi } = createHop();

    const parsed = parseOnboardingLocalState(
      await desktopApi.getOnboardingLocalState?.({ attemptId: "attempt-7" })
    );

    // The echo is what lets the renderer drop a reply belonging to a superseded
    // attempt; without it that guard has nothing to compare.
    assert.equal(parsed?.attemptId, "attempt-7");
  });

  test("an absent compute target crosses the hop omitted, never null", async () => {
    const { desktopApi } = createHop({
      source: createOnboardingLocalStateSource({
        transcriptStateDir: () => "/tmp/iss-8376-state",
        getComputeTargetId: () => null,
        runSweep: () => new Promise(() => undefined),
      }),
    });

    const payload = (await desktopApi.getOnboardingLocalState?.()) as Record<
      string,
      unknown
    >;

    assert.equal(
      Object.hasOwn(payload, "computeTargetId"),
      false,
      "an absent identity must be omitted; null reads as present-but-empty on a skewed peer"
    );
    assert.notEqual(parseOnboardingLocalState(payload), null);
  });

  test("an untrusted sender is refused on the channel main registers", () => {
    const handlers = new Map<string, IpcHandler>();
    registerOnboardingLocalStateIpcHandlers(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      makeDeps({ isTrustedSender: () => false })
    );

    const handler = handlers.get("desktop:get-onboarding-local-state");
    if (!handler) {
      throw new Error("the channel was never registered");
    }
    assert.throws(
      () => handler({ sender: { id: "someone-else" } }),
      UNTRUSTED_SENDER_PATTERN
    );
  });
});
