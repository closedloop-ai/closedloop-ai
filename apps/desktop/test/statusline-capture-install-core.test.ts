/**
 * @file statusline-capture-install-core.test.ts
 * @description Exercises the electron-free statusline-capture install/compose
 * transforms (FEA-3492 / PRD-539): identity, wrapping a pre-existing user
 * statusLine, idempotent repair, and exact opt-out restore.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOurStatusLineEntry,
  isOurStatusLineEntry,
  planInstall,
  planUninstall,
  STATUSLINE_SCRIPT_FILENAME,
  statusLineCommandOf,
} from "../src/main/session-limits/statusline-capture-install-core.js";

const OUR_COMMAND = `ELECTRON_RUN_AS_NODE=1 "/Apps/CL.app/exe" "/data/statusline/${STATUSLINE_SCRIPT_FILENAME}"`;

test("isOurStatusLineEntry: matches only our capture script command", () => {
  assert.equal(
    isOurStatusLineEntry({ type: "command", command: OUR_COMMAND }),
    true
  );
  assert.equal(
    isOurStatusLineEntry({
      type: "command",
      command: `/data/statusline/${STATUSLINE_SCRIPT_FILENAME}`,
    }),
    true
  );
  assert.equal(
    isOurStatusLineEntry({
      type: "command",
      command: ".claude/scripts/statusLine.sh",
    }),
    false
  );
  assert.equal(isOurStatusLineEntry(null), false);
  assert.equal(isOurStatusLineEntry({ type: "command" }), false);
});

test("statusLineCommandOf: extracts the shell command or null", () => {
  assert.equal(statusLineCommandOf({ command: "x.sh" }), "x.sh");
  assert.equal(statusLineCommandOf({ command: "" }), null);
  assert.equal(statusLineCommandOf({}), null);
  assert.equal(statusLineCommandOf(undefined), null);
});

test("planInstall: no prior statusLine -> installs ours, no wrapped command", () => {
  const result = planInstall({
    settings: { hooks: { Stop: [] } },
    storedBackup: null,
    ourCommand: OUR_COMMAND,
  });
  assert.deepEqual(
    result.nextSettings.statusLine,
    buildOurStatusLineEntry(OUR_COMMAND)
  );
  // Other settings preserved.
  assert.deepEqual(result.nextSettings.hooks, { Stop: [] });
  assert.equal(result.wrappedCommand, null);
  assert.equal(result.backupToStore, null);
});

test("planInstall: wraps an existing user statusLine (never clobbers)", () => {
  const userEntry = {
    type: "command",
    command: ".claude/scripts/statusLine.sh",
  };
  const result = planInstall({
    settings: { statusLine: userEntry },
    storedBackup: null,
    ourCommand: OUR_COMMAND,
  });
  // Our entry takes the statusLine slot...
  assert.deepEqual(
    result.nextSettings.statusLine,
    buildOurStatusLineEntry(OUR_COMMAND)
  );
  // ...but the user's command is preserved for composition + restore.
  assert.equal(result.wrappedCommand, ".claude/scripts/statusLine.sh");
  assert.deepEqual(result.backupToStore, userEntry);
});

test("planInstall: repair keeps stored backup, wraps from it (no self-recursion)", () => {
  const userEntry = { type: "command", command: "user.sh" };
  // settings already carry OUR entry (a repair after an app move).
  const result = planInstall({
    settings: { statusLine: buildOurStatusLineEntry(OUR_COMMAND) },
    storedBackup: userEntry,
    ourCommand: OUR_COMMAND,
  });
  assert.deepEqual(
    result.nextSettings.statusLine,
    buildOurStatusLineEntry(OUR_COMMAND)
  );
  // Wrapped command comes from the stored backup, not our own entry.
  assert.equal(result.wrappedCommand, "user.sh");
  assert.deepEqual(result.backupToStore, userEntry);
});

test("planUninstall: restores the prior config exactly", () => {
  const userEntry = { type: "command", command: "user.sh", padding: 0 };
  const result = planUninstall({
    settings: { statusLine: buildOurStatusLineEntry(OUR_COMMAND), extra: 1 },
    storedBackup: userEntry,
  });
  assert.equal(result.removed, true);
  assert.deepEqual(result.nextSettings.statusLine, userEntry);
  assert.equal(result.nextSettings.extra, 1);
});

test("planUninstall: deletes statusLine when there was no prior config", () => {
  const result = planUninstall({
    settings: { statusLine: buildOurStatusLineEntry(OUR_COMMAND) },
    storedBackup: null,
  });
  assert.equal(result.removed, true);
  assert.equal("statusLine" in result.nextSettings, false);
});

test("planUninstall: leaves a user-replaced statusLine untouched", () => {
  const userEntry = { type: "command", command: "brand-new.sh" };
  const result = planUninstall({
    settings: { statusLine: userEntry },
    storedBackup: { type: "command", command: "old.sh" },
  });
  assert.equal(result.removed, false);
  assert.deepEqual(result.nextSettings.statusLine, userEntry);
});
