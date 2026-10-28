import assert from "node:assert/strict";
import { DESKTOP_DEEP_LINK_URL } from "@repo/api/src/types/desktop-deep-link";
import { test } from "vitest";
import { startDesktopLoopbackListener } from "../src/main/auth/desktop-loopback-listener.js";
import { isAllowedDeepLink } from "../src/main/lifecycle/deep-link.js";

const RE_CALLBACK_LINK = /<a href="([^"]+)"/;

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

    assert.deepEqual(await waiting, {
      code: "the-code",
      state: "the-state",
      error: null,
      accountCreated: false,
      desktopBootstrap: false,
    });
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
    assert.deepEqual(await waiting, {
      code: "c",
      state: "s",
      error: null,
      accountCreated: false,
      desktopBootstrap: false,
    });
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
      {
        code: "early",
        state: "st",
        error: null,
        accountCreated: false,
        desktopBootstrap: false,
      }
    );
  } finally {
    await listener.close();
  }
});

test("delivers the additive Desktop bootstrap marker", async () => {
  const listener = await startDesktopLoopbackListener();
  try {
    const waiting = listener.waitForCallback(new AbortController().signal);
    await fetch(
      `${listener.redirectUri}?code=c&state=s&desktop_bootstrap=1`
    ).then((response) => response.text());
    assert.equal((await waiting)?.desktopBootstrap, true);
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

// ISS-10412 — the fallback for an OS that refuses the desktop's own activation.
// Asserting the href against the app's REAL deny policy is the point: a link
// carrying a path or query renders identically and is silently refused on
// arrival, so a page that looks correct would still hand the user a dead
// control.
test("the callback page offers a link the deep-link policy accepts", async () => {
  const listener = await startDesktopLoopbackListener();
  try {
    const body = await fetch(`${listener.redirectUri}?code=c&state=s`).then(
      (res) => res.text()
    );

    const href = RE_CALLBACK_LINK.exec(body)?.[1];
    assert.equal(href, DESKTOP_DEEP_LINK_URL);
    assert.equal(isAllowedDeepLink(href ?? ""), true);
  } finally {
    await listener.close();
  }
});

test("delivers an OAuth error callback so a cancel is not silence", async () => {
  // The web consent screen reports a cancel by redirecting here with `error`
  // and no `code`. Before this the listener dropped the param and the session
  // manager could not tell a cancel from a browser that never came back.
  const listener = await startDesktopLoopbackListener();
  try {
    const controller = new AbortController();
    const waiting = listener.waitForCallback(controller.signal);
    await fetch(`${listener.redirectUri}?error=access_denied&state=the-state`);
    assert.deepEqual(await waiting, {
      code: null,
      state: "the-state",
      error: "access_denied",
      accountCreated: false,
      desktopBootstrap: false,
    });
  } finally {
    await listener.close();
  }
});

test("reads the ISS-10913 account_created marker off the callback", async () => {
  const listener = await startDesktopLoopbackListener();
  try {
    const waiting = listener.waitForCallback(new AbortController().signal);
    await fetch(
      `${listener.redirectUri}?code=c&state=s&account_created=1`
    ).then((r) => r.text());

    assert.deepEqual(await waiting, {
      code: "c",
      state: "s",
      error: null,
      accountCreated: true,
      desktopBootstrap: false,
    });
  } finally {
    await listener.close();
  }
});

test("treats an unrecognized account_created value as no creation observed", async () => {
  // The marker is a closed wire value: a stale spelling or a guess must not
  // fabricate a creation. The REPEATED-key case is pinned separately below —
  // this sentence used to claim it too, and did not test it (marisolashgrove).
  const listener = await startDesktopLoopbackListener();
  try {
    const waiting = listener.waitForCallback(new AbortController().signal);
    await fetch(
      `${listener.redirectUri}?code=c&state=s&account_created=yes`
    ).then((r) => r.text());

    assert.equal((await waiting)?.accountCreated, false);
  } finally {
    await listener.close();
  }
});

test("reads the FIRST value of a repeated account_created key", async () => {
  // `searchParams.get` takes the first, so an appended second copy cannot
  // displace the real one — the same first-value rule the web-side resolvers
  // follow, and the reason a smuggled `&account_created=1` cannot promote a
  // callback that already said otherwise.
  const listener = await startDesktopLoopbackListener();
  try {
    const waiting = listener.waitForCallback(new AbortController().signal);
    await fetch(
      `${listener.redirectUri}?code=c&state=s&account_created=0&account_created=1`
    ).then((r) => r.text());

    assert.equal((await waiting)?.accountCreated, false);
  } finally {
    await listener.close();
  }
});

test("reads a repeated key that leads with the marker as a creation", async () => {
  // The other order, so the case pins first-value semantics rather than a
  // coincidental false.
  const listener = await startDesktopLoopbackListener();
  try {
    const waiting = listener.waitForCallback(new AbortController().signal);
    await fetch(
      `${listener.redirectUri}?code=c&state=s&account_created=1&account_created=0`
    ).then((r) => r.text());

    assert.equal((await waiting)?.accountCreated, true);
  } finally {
    await listener.close();
  }
});
