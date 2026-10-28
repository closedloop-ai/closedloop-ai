/**
 * @file onboarding-local-state-ipc.test.ts
 * @description ISS-8376 — the handler's sender gate and the fact its refusal
 * states.
 *
 * ISS-8776 established that "untrusted sender" and "renderer window is gone" are
 * a DIFFERENT FACT, not a softer one. This channel is polled by the onboarding
 * analysis step, so a teardown during onboarding is a REACHABLE state — exactly
 * the shape that produced four "untrusted sender" lines on
 * `desktop:get-runtime-status` and named a renderer-identity defect that did not
 * exist. These cases pin that the guard did not widen and that the two facts
 * stay apart.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  type OnboardingLocalStateIpcDeps,
  registerOnboardingLocalStateIpcHandlers,
} from "../src/main/ipc/onboarding-local-state-ipc.js";
import { createOnboardingLocalStateSource } from "../src/main/onboarding/onboarding-local-state-source.js";
import {
  RENDERER_WINDOW_GONE_MESSAGE,
  UNTRUSTED_IPC_SENDER_MESSAGE,
} from "../src/shared/ipc-refusal-messages.js";
import {
  ONBOARDING_LOCAL_STATE_CHANNEL,
  OnboardingInventoryStatus,
} from "../src/shared/onboarding-local-state-contract.js";

const RENDERER = { id: "trusted-renderer" };
const FOREIGN = { id: "someone-else" };

const UNTRUSTED_PATTERN = new RegExp(UNTRUSTED_IPC_SENDER_MESSAGE);
const WINDOW_GONE_PATTERN = new RegExp(RENDERER_WINDOW_GONE_MESSAGE);

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

function register(overrides: Partial<OnboardingLocalStateIpcDeps> = {}) {
  const handlers = new Map<string, IpcHandler>();
  registerOnboardingLocalStateIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender: (sender) => sender === RENDERER,
      isRendererWindowGone: () => false,
      source: createOnboardingLocalStateSource({
        transcriptStateDir: () => "/tmp/iss-8376",
        getComputeTargetId: () => "ct-01",
        runSweep: () => new Promise(() => undefined),
      }),
      ...overrides,
    }
  );
  const handler = handlers.get(ONBOARDING_LOCAL_STATE_CHANNEL);
  if (!handler) {
    throw new Error(
      `${ONBOARDING_LOCAL_STATE_CHANNEL} was never registered — the registrar is the subject of every case below`
    );
  }
  return handler;
}

describe("onboarding local-state IPC (ISS-8376)", () => {
  test("the trusted renderer gets the snapshot", () => {
    const payload = register()({ sender: RENDERER }) as {
      inventory: { status: string };
    };

    assert.equal(
      payload.inventory.status,
      OnboardingInventoryStatus.Unavailable
    );
  });

  test("a foreign sender is refused as untrusted, window alive", () => {
    assert.throws(() => register()({ sender: FOREIGN }), UNTRUSTED_PATTERN);
  });

  test("a teardown refusal names the teardown, not an untrusted sender", () => {
    // The app's OWN renderer, polling this channel during the app's own exit,
    // must not be described as an untrusted sender.
    const handler = register({
      isTrustedSender: () => false,
      isRendererWindowGone: () => true,
    });

    assert.throws(() => handler({ sender: RENDERER }), WINDOW_GONE_PATTERN);
  });

  test("the window-gone probe cannot GRANT access — only label a refusal", () => {
    // If the label ever became part of the decision, this is the case that
    // catches it.
    const handler = register({
      isTrustedSender: () => false,
      isRendererWindowGone: () => true,
    });

    assert.throws(
      () => handler({ sender: FOREIGN }),
      WINDOW_GONE_PATTERN,
      "a mislabelled refusal is still a refusal"
    );
  });

  test("an over-long attemptId is refused rather than echoed verbatim", () => {
    // The echo is copied into every response, so an unbounded renderer-supplied
    // string must not ride along.
    const payload = register()(
      { sender: RENDERER },
      { attemptId: "x".repeat(500) }
    ) as { attemptId?: string };

    assert.equal(Object.hasOwn(payload, "attemptId"), false);
  });

  test("the echoed attemptId is the trimmed value that was judged", () => {
    // Trimming to decide emptiness and echoing the raw string would hand the
    // renderer a value this handler never actually tested.
    const payload = register()(
      { sender: RENDERER },
      { attemptId: "  attempt-5  " }
    ) as { attemptId?: string };

    assert.equal(payload.attemptId, "attempt-5");
  });

  test("a non-string attemptId is ignored rather than echoed", () => {
    // The echo is what the renderer's attempt guard compares against, so a
    // garbage value must not become one.
    const payload = register()({ sender: RENDERER }, { attemptId: 42 }) as {
      attemptId?: string;
    };

    assert.equal(Object.hasOwn(payload, "attemptId"), false);
  });

  test("a supplied attemptId is echoed verbatim", () => {
    const payload = register()(
      { sender: RENDERER },
      { attemptId: "attempt-3" }
    ) as { attemptId?: string };

    assert.equal(payload.attemptId, "attempt-3");
  });
});
