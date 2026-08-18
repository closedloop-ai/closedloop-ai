import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vi } from "vitest";
import {
  CloudControlIpcChannel,
  registerCloudControlIpcHandlers,
} from "../src/main/ipc/cloud-control-ipc.js";
import {
  createIpcRegistrar,
  isTrustedSenderDouble,
  TRUSTED_EVENT,
  UNTRUSTED_EVENT,
  UNTRUSTED_SENDER_ERROR,
} from "./helpers/ipc-registrar.js";

// ISS-5300 (PRD-618): `cloud-control-ipc.ts` was reached by no test. Its four
// channels split deliberately — the two SETTERS gate on sender trust, the two
// GETTERS do not — so the suite asserts that split as the contract rather than
// pretending every channel is gated.

type CloudState = { paused: boolean; enabled: boolean };

function registerWithState(
  initial: CloudState,
  isTrustedSender: (sender: unknown) => boolean = isTrustedSenderDouble
) {
  const state: CloudState = { ...initial };
  const setCloudCommandsPaused = vi.fn((paused: boolean) => {
    state.paused = paused;
  });
  const setCloudConnectionEnabled = vi.fn((enabled: boolean) => {
    state.enabled = enabled;
  });
  const harness = createIpcRegistrar();
  registerCloudControlIpcHandlers(harness.registrar, {
    isTrustedSender,
    getCloudCommandsPaused: () => state.paused,
    setCloudCommandsPaused,
    getCloudConnectionEnabled: () => state.enabled,
    setCloudConnectionEnabled,
  });
  return { harness, state, setCloudCommandsPaused, setCloudConnectionEnabled };
}

describe("cloud-control IPC registration", () => {
  test("registers exactly the channels the contract declares", () => {
    const { harness } = registerWithState({ paused: false, enabled: true });
    assert.deepEqual(
      [...harness.channels()].sort(),
      Object.values(CloudControlIpcChannel).sort()
    );
  });
});

describe("cloud-control IPC setter gates", () => {
  test("SetCloudCommandsPaused rejects an untrusted sender before mutating", () => {
    const { harness, state, setCloudCommandsPaused } = registerWithState({
      paused: false,
      enabled: true,
    });

    assert.throws(
      () =>
        harness.invoke(
          CloudControlIpcChannel.SetCloudCommandsPaused,
          UNTRUSTED_EVENT,
          true
        ),
      UNTRUSTED_SENDER_ERROR
    );
    // Negating the gate would let the setter run — the call count, not the
    // throw, is what proves the gate precedes the side effect.
    assert.equal(setCloudCommandsPaused.mock.calls.length, 0);
    assert.equal(state.paused, false);
  });

  test("SetCloudConnectionEnabled rejects an untrusted sender before mutating", () => {
    const { harness, state, setCloudConnectionEnabled } = registerWithState({
      paused: false,
      enabled: true,
    });

    assert.throws(
      () =>
        harness.invoke(
          CloudControlIpcChannel.SetCloudConnectionEnabled,
          UNTRUSTED_EVENT,
          false
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(setCloudConnectionEnabled.mock.calls.length, 0);
    assert.equal(state.enabled, true);
  });
});

describe("cloud-control IPC setter behaviour for a trusted sender", () => {
  test("SetCloudCommandsPaused stores the value and reports it back", () => {
    const { harness, state, setCloudCommandsPaused } = registerWithState({
      paused: false,
      enabled: true,
    });

    const result = harness.invoke(
      CloudControlIpcChannel.SetCloudCommandsPaused,
      TRUSTED_EVENT,
      true
    );

    assert.equal(setCloudCommandsPaused.mock.calls.length, 1);
    assert.deepEqual(setCloudCommandsPaused.mock.calls[0], [true]);
    assert.equal(state.paused, true);
    assert.deepEqual(result, { paused: true });
  });

  test("SetCloudCommandsPaused coerces a truthy non-boolean payload", () => {
    const { harness, setCloudCommandsPaused } = registerWithState({
      paused: false,
      enabled: true,
    });

    // The handler does `Boolean(paused)`. A renderer sending a string must
    // reach the setter as a real boolean, not as the raw payload.
    const result = harness.invoke(
      CloudControlIpcChannel.SetCloudCommandsPaused,
      TRUSTED_EVENT,
      "yes"
    );

    assert.deepEqual(setCloudCommandsPaused.mock.calls[0], [true]);
    assert.deepEqual(result, { paused: true });
  });

  test("SetCloudConnectionEnabled coerces a falsy non-boolean payload", () => {
    const { harness, setCloudConnectionEnabled } = registerWithState({
      paused: false,
      enabled: true,
    });

    const result = harness.invoke(
      CloudControlIpcChannel.SetCloudConnectionEnabled,
      TRUSTED_EVENT,
      0
    );

    assert.deepEqual(setCloudConnectionEnabled.mock.calls[0], [false]);
    assert.deepEqual(result, { enabled: false });
  });

  test("the setter reports the store's post-set value, not the requested one", () => {
    // The handler's comment says the setter is the source of truth: it reads
    // back through the getter after setting. A store that refuses the write
    // must therefore be reported honestly rather than echoed.
    const harness = createIpcRegistrar();
    const setCloudConnectionEnabled = vi.fn((_enabled: boolean) => {
      // Refuses the write — e.g. policy-pinned off.
    });
    registerCloudControlIpcHandlers(harness.registrar, {
      isTrustedSender: isTrustedSenderDouble,
      getCloudCommandsPaused: () => false,
      setCloudCommandsPaused: () => undefined,
      getCloudConnectionEnabled: () => false,
      setCloudConnectionEnabled,
    });

    const result = harness.invoke(
      CloudControlIpcChannel.SetCloudConnectionEnabled,
      TRUSTED_EVENT,
      true
    );

    assert.equal(setCloudConnectionEnabled.mock.calls.length, 1);
    // Echoing the request would return `{ enabled: true }` and lie to the UI.
    assert.deepEqual(result, { enabled: false });
  });
});

describe("cloud-control IPC getters are ungated by design", () => {
  test("GetCloudCommandsPaused answers an untrusted sender", () => {
    // Documenting the real contract: these are local reads with no renderer
    // input, and the module does not gate them. Asserting the reachable
    // behaviour keeps the suite honest instead of inventing a gate.
    const { harness } = registerWithState({ paused: true, enabled: false });

    assert.equal(
      harness.invoke(
        CloudControlIpcChannel.GetCloudCommandsPaused,
        UNTRUSTED_EVENT
      ),
      true
    );
  });

  test("GetCloudConnectionEnabled answers an untrusted sender", () => {
    const { harness } = registerWithState({ paused: true, enabled: false });

    assert.equal(
      harness.invoke(
        CloudControlIpcChannel.GetCloudConnectionEnabled,
        UNTRUSTED_EVENT
      ),
      false
    );
  });
});
