import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatUpdateBlockedBannerMessage,
  formatUpdateBlockedDialogBody,
  formatUpdateBlockedManualStepsBody,
  guardUpdateDownloadPromise,
  isAppTranslocated,
  isReadOnlyVolumeUpdateError,
  UPDATE_BLOCKED_BANNER_MESSAGE,
  UPDATE_BLOCKED_DIALOG_BODY,
  UPDATE_BLOCKED_DIALOG_TITLE,
  UPDATE_BLOCKED_LATER_BUTTON,
  UPDATE_BLOCKED_MOVE_BUTTON,
} from "../src/main/update-install-blocked.js";

const TRANSLOCATED_EXEC_PATH =
  "/private/var/folders/zd/fz0vybgn72921mzm4y311nw40000gn/T/AppTranslocation/1A77CB6F-BA60-44E6-B001-2EBF85F96647/d/Closedloop.app/Contents/MacOS/Closedloop";

const SQUIRREL_READONLY_MESSAGE =
  "Cannot update while running on a read-only volume. The application is on a read-only volume. Please move the application and try again. If you're on macOS Sierra or later, you'll need to move the application out of the Downloads directory. See https://github.com/Squirrel/Squirrel.Mac/issues/182 for more information.";

const UNDEFINED_PATTERN = /undefined/;
const STEP_QUIT_PATTERN = /1\. Quit Closedloop/;
const STEP_DRAG_PATTERN =
  /2\. Drag Closedloop\.app into your Applications folder/;
const STEP_RELAUNCH_PATTERN = /3\. Relaunch it from Applications/;
const VERSION_INSTALLS_AUTOMATICALLY_PATTERN =
  /Version 0\.16\.181 will then install automatically\./;
const INSTALL_AUTOMATICALLY_PATTERN = /install automatically/;
const NON_FATAL_LOG_PATTERN = /Update download\/staging failed \(non-fatal\)/;
const READ_ONLY_VOLUME_PATTERN = /read-only volume/;
const PLAIN_STRING_REASON_PATTERN = /plain-string-reason/;

test("isAppTranslocated: darwin translocated exec path is detected", () => {
  assert.equal(isAppTranslocated("darwin", TRANSLOCATED_EXEC_PATH), true);
});

test("isAppTranslocated: darwin /Applications install is not translocated", () => {
  assert.equal(
    isAppTranslocated(
      "darwin",
      "/Applications/Closedloop.app/Contents/MacOS/Closedloop"
    ),
    false
  );
});

test("isAppTranslocated: non-darwin platforms never report translocation", () => {
  assert.equal(isAppTranslocated("linux", TRANSLOCATED_EXEC_PATH), false);
  assert.equal(isAppTranslocated("win32", TRANSLOCATED_EXEC_PATH), false);
});

test("isReadOnlyVolumeUpdateError: matches the Squirrel.Mac staging error", () => {
  assert.equal(isReadOnlyVolumeUpdateError(SQUIRREL_READONLY_MESSAGE), true);
});

test("isReadOnlyVolumeUpdateError: is case-insensitive", () => {
  assert.equal(
    isReadOnlyVolumeUpdateError("cannot update on READ-ONLY VOLUME"),
    true
  );
});

test("isReadOnlyVolumeUpdateError: ignores unrelated updater errors", () => {
  assert.equal(
    isReadOnlyVolumeUpdateError("net::ERR_INTERNET_DISCONNECTED"),
    false
  );
  assert.equal(
    isReadOnlyVolumeUpdateError(
      'Cannot download "https://example.com/x.zip.blockmap", status 404'
    ),
    false
  );
});

test("blocked update dialog copy matches the friendly requested strings", () => {
  assert.equal(
    UPDATE_BLOCKED_DIALOG_TITLE,
    "Move Closedloop to finish updating"
  );
  assert.equal(UPDATE_BLOCKED_MOVE_BUTTON, "Move & Update");
  assert.equal(UPDATE_BLOCKED_LATER_BUTTON, "Later");
  assert.equal(
    formatUpdateBlockedDialogBody("0.16.181"),
    UPDATE_BLOCKED_DIALOG_BODY
  );
  assert.equal(
    formatUpdateBlockedDialogBody(),
    "Move Closedloop to the Applications folder and the latest version will install automatically. You won't need to do this again."
  );
  assert.doesNotMatch(formatUpdateBlockedDialogBody(), UNDEFINED_PATTERN);
});

test("blocked update banner copy matches the warning message exactly", () => {
  assert.equal(
    UPDATE_BLOCKED_BANNER_MESSAGE,
    "Updates are paused — Move Closedloop to the Applications folder to turn on automatic updates."
  );
  assert.equal(
    formatUpdateBlockedBannerMessage("0.16.181"),
    UPDATE_BLOCKED_BANNER_MESSAGE
  );
  assert.equal(
    formatUpdateBlockedBannerMessage(),
    UPDATE_BLOCKED_BANNER_MESSAGE
  );
  assert.doesNotMatch(formatUpdateBlockedBannerMessage(), UNDEFINED_PATTERN);
});

test("formatUpdateBlockedManualStepsBody: lists the manual steps", () => {
  const body = formatUpdateBlockedManualStepsBody();
  assert.match(body, STEP_QUIT_PATTERN);
  assert.match(body, STEP_DRAG_PATTERN);
  assert.match(body, STEP_RELAUNCH_PATTERN);
  assert.doesNotMatch(body, UNDEFINED_PATTERN);
});

test("formatUpdateBlockedManualStepsBody: mentions the pending version when known", () => {
  const withVersion = formatUpdateBlockedManualStepsBody("0.16.181");
  assert.match(withVersion, VERSION_INSTALLS_AUTOMATICALLY_PATTERN);
  const withoutVersion = formatUpdateBlockedManualStepsBody();
  assert.doesNotMatch(withoutVersion, INSTALL_AUTOMATICALLY_PATTERN);
});

test("guardUpdateDownloadPromise: tolerates a null check result", () => {
  const logged: string[] = [];
  guardUpdateDownloadPromise(null, (message) => logged.push(message));
  assert.deepEqual(logged, []);
});

test("guardUpdateDownloadPromise: tolerates a result without a download", () => {
  const logged: string[] = [];
  guardUpdateDownloadPromise({}, (message) => logged.push(message));
  guardUpdateDownloadPromise({ downloadPromise: null }, (message) =>
    logged.push(message)
  );
  assert.deepEqual(logged, []);
});

test("guardUpdateDownloadPromise: a rejected download logs instead of escaping as an unhandled rejection", async () => {
  const logged: string[] = [];
  guardUpdateDownloadPromise(
    { downloadPromise: Promise.reject(new Error(SQUIRREL_READONLY_MESSAGE)) },
    (message) => logged.push(message)
  );
  // Let the rejection settle. If the guard failed to attach a handler, the
  // node:test runner itself would fail this test with an unhandled rejection.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logged.length, 1);
  assert.match(logged[0], NON_FATAL_LOG_PATTERN);
  assert.match(logged[0], READ_ONLY_VOLUME_PATTERN);
});

test("guardUpdateDownloadPromise: stringifies non-Error rejection reasons", async () => {
  const logged: string[] = [];
  guardUpdateDownloadPromise(
    { downloadPromise: Promise.reject("plain-string-reason") },
    (message) => logged.push(message)
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logged.length, 1);
  assert.match(logged[0], PLAIN_STRING_REASON_PATTERN);
});

test("guardUpdateDownloadPromise: a successful download logs nothing", async () => {
  const logged: string[] = [];
  guardUpdateDownloadPromise(
    { downloadPromise: Promise.resolve(["/tmp/update.zip"]) },
    (message) => logged.push(message)
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logged, []);
});
