import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isRendererRecentlyActive } from "../src/main/renderer-activity-window.js";

const WINDOW_MS = 750;

describe("ISS-4711 renderer-activity window (hasRecentRendererRead backing)", () => {
  test("a recent trusted DB read alone keeps the renderer active with no user input", () => {
    // wongk PR #4184: the whole point of the fix — a hands-off-keyboard
    // auto-refreshing list issues a DB read (no user-input event), and that must
    // still count as active so the rebuild holds its full pause.
    const now = 10_000;
    assert.equal(isRendererRecentlyActive(now, now - 100, 0, WINDOW_MS), true);
  });

  test("a recent user input alone keeps the renderer active with no DB read", () => {
    const now = 10_000;
    assert.equal(isRendererRecentlyActive(now, 0, now - 100, WINDOW_MS), true);
  });

  test("a stale DB read outside the window with no user input reads as idle", () => {
    // Precisely the case the fix must NOT falsely report active: the list stopped
    // reading and the user's hands are off the keyboard → idle fast path.
    const now = 10_000;
    assert.equal(
      isRendererRecentlyActive(now, now - WINDOW_MS, 0, WINDOW_MS),
      false
    );
  });

  test("uses the more recent of the two signals (DB read newer than a stale input)", () => {
    const now = 10_000;
    // User input is stale, DB read is fresh — the max must win → active.
    assert.equal(
      isRendererRecentlyActive(now, now - 10, now - 5000, WINDOW_MS),
      true
    );
  });

  test("both signals absent (initial zero timestamps) reads as idle", () => {
    const now = 10_000;
    assert.equal(isRendererRecentlyActive(now, 0, 0, WINDOW_MS), false);
  });

  test("the window boundary is exclusive (exactly windowMs old is idle)", () => {
    const now = 10_000;
    assert.equal(
      isRendererRecentlyActive(
        now,
        now - WINDOW_MS,
        now - WINDOW_MS,
        WINDOW_MS
      ),
      false
    );
    assert.equal(
      isRendererRecentlyActive(now, now - (WINDOW_MS - 1), 0, WINDOW_MS),
      true
    );
  });
});
