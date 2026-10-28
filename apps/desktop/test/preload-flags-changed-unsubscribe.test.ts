/**
 * ISS-7595 — `onFlagsChanged` was the one subscribe bridge in
 * `createDesktopApi` that returned nothing, so no renderer caller could detach
 * its `desktop:flags-changed` listener. Every sibling bridge
 * (`onDesktopAuthStateChanged`, `onSyncConsentRecordChanged`,
 * `onExistingUserResolutionChanged`, …) already returns an unsubscribe fn.
 *
 * This is the boundary the renderer suite cannot reach: a provider test drives
 * a test double, so it proves the provider CALLS what the bridge returns and
 * nothing about whether the real bridge's return value detaches anything.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { createDesktopApi } from "../src/main/preload-common.js";

const FLAGS_CHANGED_CHANNEL = "desktop:flags-changed";

type Listener = (...args: never[]) => void;

/**
 * A stub that keeps real per-channel listener bookkeeping, so "the listener
 * count does not grow" is asserted against registrations rather than against a
 * call count that a no-op `removeListener` would satisfy just as well. `emit`
 * dispatches to every listener still registered on the channel, which is what
 * makes "only the surviving subscriber fires" observable.
 */
function createIpcStub() {
  const listeners = new Map<string, Listener[]>();
  return {
    listenerCount: (channel: string) => listeners.get(channel)?.length ?? 0,
    emit: (channel: string) => {
      for (const listener of [...(listeners.get(channel) ?? [])]) {
        (listener as () => void)();
      }
    },
    ipc: {
      invoke: () => Promise.resolve(undefined),
      send: () => undefined,
      on: (channel: string, listener: Listener) => {
        const existing = listeners.get(channel) ?? [];
        existing.push(listener);
        listeners.set(channel, existing);
      },
      removeListener: (channel: string, listener: Listener) => {
        const existing = listeners.get(channel) ?? [];
        const index = existing.indexOf(listener);
        if (index !== -1) {
          existing.splice(index, 1);
        }
        listeners.set(channel, existing);
      },
    },
  };
}

test("onFlagsChanged returns an unsubscribe that detaches the listener", () => {
  const { ipc, listenerCount } = createIpcStub();

  const unsubscribe = createDesktopApi(ipc).onFlagsChanged(() => undefined);

  assert.equal(typeof unsubscribe, "function");
  assert.equal(listenerCount(FLAGS_CHANGED_CHANNEL), 1);

  unsubscribe();

  assert.equal(listenerCount(FLAGS_CHANGED_CHANNEL), 0);
});

test("repeated subscribe/unsubscribe cycles leave no listener behind", () => {
  const { ipc, listenerCount } = createIpcStub();
  const desktopApi = createDesktopApi(ipc);

  // Three full cycles, each with its OWN callback — the identity the
  // unsubscribe closes over has to be the one that was registered, so a bridge
  // that removed by channel alone (or removed the wrong closure) would leave
  // the count climbing here even though the single-cycle case above passed.
  for (let cycle = 0; cycle < 3; cycle++) {
    const unsubscribe = desktopApi.onFlagsChanged(() => undefined);
    assert.equal(listenerCount(FLAGS_CHANGED_CHANNEL), 1);
    unsubscribe();
    assert.equal(listenerCount(FLAGS_CHANGED_CHANNEL), 0);
  }
});

test("unsubscribing one subscriber leaves a concurrent subscriber attached", () => {
  // Every case above holds exactly one live subscriber, so a remover that
  // cleared the whole channel — or removed whichever callback registered last
  // — would satisfy all of them and still silently detach an unrelated caller.
  // Two concurrent subscribers is the population that tells those apart.
  const { ipc, listenerCount, emit } = createIpcStub();
  const desktopApi = createDesktopApi(ipc);
  let notifiedA = 0;
  let notifiedB = 0;

  const unsubscribeA = desktopApi.onFlagsChanged(() => {
    notifiedA++;
  });
  desktopApi.onFlagsChanged(() => {
    notifiedB++;
  });
  assert.equal(listenerCount(FLAGS_CHANGED_CHANNEL), 2);

  unsubscribeA();

  assert.equal(listenerCount(FLAGS_CHANGED_CHANNEL), 1);

  emit(FLAGS_CHANGED_CHANNEL);

  assert.equal(notifiedA, 0);
  assert.equal(notifiedB, 1);
});

test("the subscribed callback still fires on a desktop:flags-changed push", () => {
  // The unsubscribe is only worth having if the subscription still works:
  // registering a wrapper and returning a remover for a DIFFERENT function
  // would satisfy every case above.
  const { ipc, listenerCount, emit } = createIpcStub();
  let notified = 0;

  createDesktopApi(ipc).onFlagsChanged(() => {
    notified++;
  });

  assert.equal(listenerCount(FLAGS_CHANGED_CHANNEL), 1);

  emit(FLAGS_CHANGED_CHANNEL);

  assert.equal(notified, 1);
});
