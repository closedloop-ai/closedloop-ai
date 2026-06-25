/**
 * Unit tests for PLN-740 D5: managed-key revival limitation hint state.
 *
 * Covers:
 *   - shouldShowManagedKeyHint pure function (5 scenarios)
 *   - SettingsStore getter/setter defaults
 *   - DEFAULT_DESKTOP_SETTINGS null defaults for hint fields
 *
 * The dismiss IPC handler's security model (reading provenance from
 * main-process apiKeyStore, not renderer args) is enforced by a code
 * comment in the handler and verified by manual test T-5.3.
 * These unit tests do NOT attempt to test ipcMain.handle callbacks directly.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  SettingsStore,
  shouldShowManagedKeyHint,
} from "../src/main/settings-store.js";
import { DEFAULT_DESKTOP_SETTINGS } from "../src/shared/contracts.js";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "managed-key-hint-test-"));
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// shouldShowManagedKeyHint pure function (AC-010)
// ---------------------------------------------------------------------------

describe("PLN-740 T-3.4: shouldShowManagedKeyHint", () => {
  test("(a) USER_CREATED + never dismissed → true", () => {
    assert.equal(
      shouldShowManagedKeyHint("USER_CREATED", null, null),
      true,
      "should show when USER_CREATED and never dismissed"
    );
  });

  test("(b) DESKTOP_MANAGED + never dismissed → false", () => {
    assert.equal(
      shouldShowManagedKeyHint("DESKTOP_MANAGED", null, null),
      false,
      "should not show when DESKTOP_MANAGED"
    );
  });

  test("(c) USER_CREATED + dismissed while lastSeenProvenance=USER_CREATED → false", () => {
    assert.equal(
      shouldShowManagedKeyHint(
        "USER_CREATED",
        "2024-01-01T00:00:00Z",
        "USER_CREATED"
      ),
      false,
      "should not show when dismissed while USER_CREATED (no regression)"
    );
  });

  test("(d) USER_CREATED + dismissed while lastSeenProvenance=DESKTOP_MANAGED (regression) → true", () => {
    // User dismissed while DESKTOP_MANAGED, then key regressed to USER_CREATED.
    // The hint should re-appear.
    assert.equal(
      shouldShowManagedKeyHint(
        "USER_CREATED",
        "2024-01-01T00:00:00Z",
        "DESKTOP_MANAGED"
      ),
      true,
      "should re-show after provenance regression (was DESKTOP_MANAGED when dismissed)"
    );
  });

  test("(e) regression re-show: USER_CREATED → DESKTOP_MANAGED → USER_CREATED → true", () => {
    // Simulate: dismissed while USER_CREATED (lastSeenProvenance=USER_CREATED),
    // then switched to DESKTOP_MANAGED, then switched back to USER_CREATED.
    // Since lastSeenProvenance is USER_CREATED (not DESKTOP_MANAGED), the regression
    // detection depends on the dismiss handler updating lastSeenProvenance when
    // the user re-dismisses after the DESKTOP_MANAGED period.
    // This test covers the case where lastSeenProvenance was updated to DESKTOP_MANAGED
    // during the pairing phase, then provenance reverted.
    assert.equal(
      shouldShowManagedKeyHint(
        "USER_CREATED",
        "2024-06-01T00:00:00Z",
        "DESKTOP_MANAGED"
      ),
      true,
      "hint must re-appear when lastSeenProvenance was DESKTOP_MANAGED (regression detected)"
    );
  });

  test("null provenance: treated as non-DESKTOP_MANAGED → show when never dismissed", () => {
    assert.equal(
      shouldShowManagedKeyHint(null, null, null),
      true,
      "null provenance treated same as USER_CREATED (non-managed)"
    );
  });

  test("null provenance + dismissed while USER_CREATED → false", () => {
    assert.equal(
      shouldShowManagedKeyHint(null, "2024-01-01T00:00:00Z", "USER_CREATED"),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// SettingsStore getter/setter defaults (AC-010)
// ---------------------------------------------------------------------------

describe("PLN-740 T-3.4: SettingsStore managedKeyHint getters/setters", () => {
  test("getManagedKeyHintDismissedAt() returns null by default", () => {
    const store = new SettingsStore({
      cwd: tempRoot,
      name: "hint-test-defaults",
    });
    assert.equal(
      store.getManagedKeyHintDismissedAt(),
      null,
      "dismissedAt must be null on fresh install"
    );
  });

  test("setManagedKeyHintDismissedAt + getManagedKeyHintDismissedAt roundtrip", () => {
    const store = new SettingsStore({
      cwd: tempRoot,
      name: "hint-test-dismissed-at",
    });
    const ts = "2025-03-15T12:00:00Z";
    store.setManagedKeyHintDismissedAt(ts);
    assert.equal(store.getManagedKeyHintDismissedAt(), ts);
  });

  test("getManagedKeyHintLastSeenProvenance() returns null by default", () => {
    const store = new SettingsStore({
      cwd: tempRoot,
      name: "hint-test-prov-default",
    });
    assert.equal(
      store.getManagedKeyHintLastSeenProvenance(),
      null,
      "lastSeenProvenance must be null on fresh install"
    );
  });

  test("setManagedKeyHintLastSeenProvenance + getter roundtrip (DESKTOP_MANAGED)", () => {
    const store = new SettingsStore({
      cwd: tempRoot,
      name: "hint-test-prov-managed",
    });
    store.setManagedKeyHintLastSeenProvenance("DESKTOP_MANAGED");
    assert.equal(
      store.getManagedKeyHintLastSeenProvenance(),
      "DESKTOP_MANAGED"
    );
  });

  test("setManagedKeyHintLastSeenProvenance + getter roundtrip (USER_CREATED)", () => {
    const store = new SettingsStore({
      cwd: tempRoot,
      name: "hint-test-prov-user",
    });
    store.setManagedKeyHintLastSeenProvenance("USER_CREATED");
    assert.equal(store.getManagedKeyHintLastSeenProvenance(), "USER_CREATED");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_DESKTOP_SETTINGS null defaults (AC-010)
// ---------------------------------------------------------------------------

describe("PLN-740 T-3.4: DEFAULT_DESKTOP_SETTINGS null defaults", () => {
  test("managedKeyHintDismissedAt defaults to null", () => {
    assert.equal(
      DEFAULT_DESKTOP_SETTINGS.managedKeyHintDismissedAt,
      null,
      "DEFAULT_DESKTOP_SETTINGS.managedKeyHintDismissedAt must be null for fresh installs"
    );
  });

  test("managedKeyHintLastSeenProvenance defaults to null", () => {
    assert.equal(
      DEFAULT_DESKTOP_SETTINGS.managedKeyHintLastSeenProvenance,
      null,
      "DEFAULT_DESKTOP_SETTINGS.managedKeyHintLastSeenProvenance must be null for fresh installs"
    );
  });
});
