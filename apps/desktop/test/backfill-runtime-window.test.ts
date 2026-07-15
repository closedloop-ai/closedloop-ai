/**
 * Unit tests for apps/desktop/src/main/collectors/parsing/backfill-runtime-window.ts
 *
 * Covers notifyDbChanged's crash-safety: it must never throw on a torn-down
 * renderer, including the case where reading `.webContents` on a
 * destroyed-but-not-null window throws "Object has been destroyed" from the
 * native getter before the send guard runs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DbChangedWindow,
  notifyDbChanged,
} from "../src/main/collectors/parsing/backfill-runtime-window.js";

type SendCall = { channel: string; payload: unknown };

function fakeWindow(opts: {
  contentsDestroyed?: boolean;
  webContentsThrows?: Error;
  throwOnSend?: Error;
  calls?: SendCall[];
  // Incremented on every send entry, before any throw — lets a test assert the
  // send path was actually reached even when the send itself throws.
  attempts?: { count: number };
}): DbChangedWindow {
  if (opts.webContentsThrows) {
    const window = {};
    Object.defineProperty(window, "webContents", {
      get() {
        throw opts.webContentsThrows;
      },
    });
    return window as DbChangedWindow;
  }
  return {
    webContents: {
      isDestroyed: () => opts.contentsDestroyed === true,
      send: (channel, payload) => {
        if (opts.attempts) {
          opts.attempts.count += 1;
        }
        if (opts.throwOnSend) {
          throw opts.throwOnSend;
        }
        opts.calls?.push({ channel, payload });
      },
    },
  };
}

test("notifyDbChanged is a no-op when the window is gone", () => {
  assert.doesNotThrow(() => notifyDbChanged(null));
});

test("notifyDbChanged skips a destroyed webContents", () => {
  const calls: SendCall[] = [];
  notifyDbChanged(fakeWindow({ contentsDestroyed: true, calls }));
  assert.equal(calls.length, 0);
});

test("notifyDbChanged sends to a healthy renderer", () => {
  const calls: SendCall[] = [];
  notifyDbChanged(fakeWindow({ calls }));
  assert.deepEqual(calls, [{ channel: "desktop:db:changed", payload: {} }]);
});

test("notifyDbChanged attempts the send then swallows the disposed-frame error", () => {
  const attempts = { count: 0 };
  const window = fakeWindow({
    attempts,
    throwOnSend: new Error(
      "Render frame was disposed before WebFrameMain could be accessed"
    ),
  });
  assert.doesNotThrow(() => notifyDbChanged(window));
  // Proves the throw was swallowed at the send, not short-circuited earlier.
  assert.equal(attempts.count, 1);
});

test("notifyDbChanged swallows a throwing webContents getter on a torn-down window", () => {
  const window = fakeWindow({
    webContentsThrows: new Error("Object has been destroyed"),
  });
  assert.doesNotThrow(() => notifyDbChanged(window));
});
