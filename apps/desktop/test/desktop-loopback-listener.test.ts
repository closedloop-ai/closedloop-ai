import assert from "node:assert/strict";
import { test } from "node:test";
import { startDesktopLoopbackListener } from "../src/main/desktop-loopback-listener.js";

test("binds 127.0.0.1 on an ephemeral port and delivers the callback params", async () => {
  const listener = await startDesktopLoopbackListener();
  try {
    const url = new URL(listener.redirectUri);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/cb");
    assert.ok(Number(url.port) > 0);

    const waiting = listener.waitForCallback(new AbortController().signal);
    const res = await fetch(
      `${listener.redirectUri}?code=the-code&state=the-state`
    );
    assert.equal(res.status, 200);
    await res.text();

    assert.deepEqual(await waiting, { code: "the-code", state: "the-state" });
  } finally {
    await listener.close();
  }
});

test("responds 404 to non-callback paths without delivering a callback", async () => {
  const listener = await startDesktopLoopbackListener();
  try {
    const { origin } = new URL(listener.redirectUri);
    const res = await fetch(`${origin}/not-the-callback`);
    assert.equal(res.status, 404);
    await res.text();

    // The real callback still resolves afterwards.
    const waiting = listener.waitForCallback(new AbortController().signal);
    await fetch(`${listener.redirectUri}?code=c&state=s`).then((r) => r.text());
    assert.deepEqual(await waiting, { code: "c", state: "s" });
  } finally {
    await listener.close();
  }
});

test("waitForCallback resolves null when the signal aborts", async () => {
  const listener = await startDesktopLoopbackListener();
  try {
    const controller = new AbortController();
    const waiting = listener.waitForCallback(controller.signal);
    controller.abort();

    assert.equal(await waiting, null);
  } finally {
    await listener.close();
  }
});

test("delivers a callback that arrived before waitForCallback was called", async () => {
  const listener = await startDesktopLoopbackListener();
  try {
    await fetch(`${listener.redirectUri}?code=early&state=st`).then((r) =>
      r.text()
    );

    assert.deepEqual(
      await listener.waitForCallback(new AbortController().signal),
      { code: "early", state: "st" }
    );
  } finally {
    await listener.close();
  }
});

test("close is idempotent and frees the port", async () => {
  const listener = await startDesktopLoopbackListener();
  const { origin } = new URL(listener.redirectUri);

  await listener.close();
  await listener.close();

  await assert.rejects(fetch(`${origin}/cb`));
});
