import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
  createDesktopMainFeatureFlagAssignmentStore,
  publishDesktopMainFeatureFlagAssignmentStore,
} from "../src/main/auth/desktop-feature-flag-assignment.js";
import { createCoachingPackController } from "../src/main/packs/coaching-pack-controller.js";
import {
  DESKTOP_AGENT_COACHING_PACKS_FEATURE_FLAG_KEY,
  DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY,
  type FlagKey,
} from "../src/shared/feature-flags.js";

/**
 * ISS-8792 — `agentCoachingTips` is read by the RENDERER as well
 * (`sessions-v2-view.tsx`), so main must take the same verdict it does: the
 * signed-in account's PostHog assignment. `agentCoachingPacks` has no renderer
 * read, so it stays a persisted desktop-local setting.
 *
 * Every case sets the two sources to DISAGREE, which is the only way to tell
 * which one is actually consulted. A test that set them alike would pass
 * against either wiring.
 */

const SUBJECT = "user-1";

function harness(assignmentFlags: Record<string, boolean>) {
  const settings: Record<string, boolean> = {};
  const getFlagCalls: string[] = [];
  const controller = createCoachingPackController({
    getFlag: (key: FlagKey) => {
      getFlagCalls.push(key);
      return settings[key] === true;
    },
    getUserDataDir: () => mkdtempSync(path.join(tmpdir(), "coaching-")),
  });
  const store = createDesktopMainFeatureFlagAssignmentStore({
    fetchAssignment: () =>
      Promise.resolve({
        userId: SUBJECT,
        resolved: true,
        flags: assignmentFlags,
      }),
    retryDelaysMs: [],
  });
  publishDesktopMainFeatureFlagAssignmentStore(store);
  return { controller, store, settings, getFlagCalls };
}

afterEach(() => {
  publishDesktopMainFeatureFlagAssignmentStore(null);
});

describe("coaching flag sources (ISS-8792)", () => {
  test("tips follow the ASSIGNMENT, not the persisted setting", async () => {
    const { controller, store, settings, getFlagCalls } = harness({
      [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true,
    });
    // The two sources disagree: the setting says OFF, the account says ON.
    settings[DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY] = false;
    await store.resolveFor(SUBJECT);

    assert.equal(controller.isTipsEnabled(), true);
    // And the settings store was never asked for the tips key at all — the read
    // was REPLACED, not supplemented with a second answer that could drift.
    assert.equal(
      getFlagCalls.includes(DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY),
      false
    );
  });

  test("tips close when the account's verdict closes, whatever the setting says", async () => {
    const { controller, store, settings } = harness({});
    settings[DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY] = true;
    await store.resolveFor(SUBJECT);

    assert.equal(controller.isTipsEnabled(), false);
  });

  test("tips are CLOSED while no verdict has arrived", () => {
    const { controller, settings } = harness({
      [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true,
    });
    settings[DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY] = true;

    // Nothing resolved: unresolved is closed, so a boot-time read cannot open
    // a gate the signed-in account may not actually hold.
    assert.equal(controller.isTipsEnabled(), false);
  });

  test("packs still read the persisted SETTING, nested inside tips", async () => {
    const { controller, store, settings, getFlagCalls } = harness({
      [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true,
    });
    await store.resolveFor(SUBJECT);

    // Tips open, packs setting off ⇒ packs closed.
    settings[DESKTOP_AGENT_COACHING_PACKS_FEATURE_FLAG_KEY] = false;
    assert.equal(controller.isPacksEnabled(), false);

    // Same assignment, packs setting on ⇒ packs open. Only the SETTING moved,
    // so this pins that packs is still setting-driven and was not swept onto
    // the assignment with its parent.
    settings[DESKTOP_AGENT_COACHING_PACKS_FEATURE_FLAG_KEY] = true;
    assert.equal(controller.isPacksEnabled(), true);
    assert.equal(
      getFlagCalls.includes(DESKTOP_AGENT_COACHING_PACKS_FEATURE_FLAG_KEY),
      true
    );
  });
});
