import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildAllowedDirectories,
  isRiskyAllowedDirectory,
} from "../src/shared/sandbox-policy.js";

test("blank sandbox returns empty allowlist", () => {
  assert.deepEqual(buildAllowedDirectories(""), []);
});

test("null sandbox returns empty allowlist", () => {
  assert.deepEqual(buildAllowedDirectories(null), []);
});

test("undefined sandbox returns empty allowlist", () => {
  assert.deepEqual(buildAllowedDirectories(undefined), []);
});

test("whitespace-only sandbox returns empty allowlist", () => {
  assert.deepEqual(buildAllowedDirectories("   "), []);
});

test("normal sandbox returns single-entry list", () => {
  assert.deepEqual(buildAllowedDirectories("/Users/foo/Source"), [
    "/Users/foo/Source",
  ]);
});

test("tilde expansion resolves to homedir", () => {
  const expected = [path.join(os.homedir(), "Source")];
  assert.deepEqual(buildAllowedDirectories("~/Source"), expected);
});

test("risky allowed directories include broad user and system roots", () => {
  assert.equal(isRiskyAllowedDirectory("/"), true);
  assert.equal(isRiskyAllowedDirectory(os.homedir()), true);
  assert.equal(isRiskyAllowedDirectory("/System/Library"), true);
  assert.equal(isRiskyAllowedDirectory("/private"), true);
  assert.equal(isRiskyAllowedDirectory("/private/etc"), true);
  assert.equal(isRiskyAllowedDirectory("/private/var/log"), true);
  assert.equal(
    isRiskyAllowedDirectory(path.join(os.homedir(), "Source")),
    false
  );
});

// FEA-3641: the onboarding-ipc (CompleteOnboarding) and settings-ipc
// (UpdateSettings) handlers gate sandbox selection on this predicate. Pin the
// exact values those selection points must reject so a sandbox can never
// silently resolve to ~ / /Users/<name> (which lets the browser/search stat
// TCC-protected folders).
test("risky guard rejects ~ and /Users/<name> at every selection point", () => {
  assert.equal(isRiskyAllowedDirectory("~"), true);
  assert.equal(isRiskyAllowedDirectory("/Users/andrew"), true);
  assert.equal(isRiskyAllowedDirectory("/Users"), true);
  assert.equal(isRiskyAllowedDirectory("/home/andrew"), true);
  // A trailing slash must not defeat the guard.
  assert.equal(isRiskyAllowedDirectory("/Users/andrew/"), true);
  // A concrete workspace under home is accepted.
  assert.equal(isRiskyAllowedDirectory("/Users/andrew/Source"), false);
});

test("risky guard rejects TCC-protected roots and descendants", () => {
  assert.equal(
    isRiskyAllowedDirectory(path.join(os.homedir(), "Documents")),
    true
  );
  assert.equal(
    isRiskyAllowedDirectory(path.join(os.homedir(), "Documents", "workspace")),
    true
  );
  assert.equal(
    isRiskyAllowedDirectory(path.join(os.homedir(), "Source")),
    false
  );
});

// The macOS filesystem is case-insensitive, so a differently-cased protected
// path (`~/documents`) points at the same folder as `~/Documents` and must not
// slip past the risky-dir guard. Case-sensitive `===` would have let it through.
test("risky guard rejects differently-cased TCC-protected roots", () => {
  assert.equal(
    isRiskyAllowedDirectory(path.join(os.homedir(), "documents")),
    true
  );
  assert.equal(
    isRiskyAllowedDirectory(path.join(os.homedir(), "DOWNLOADS")),
    true
  );
  assert.equal(
    isRiskyAllowedDirectory(path.join(os.homedir(), "documents", "workspace")),
    true
  );
});
