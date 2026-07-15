import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUsableDesktopServiceVersion,
  resolveDesktopServiceVersion,
  UNRESOLVED_DESKTOP_SERVICE_VERSION,
} from "../src/main/desktop-service-version.js";

const UNRESOLVED_WARNING_PATTERN = /Unresolved desktop service\.version/;

test("isUsableDesktopServiceVersion accepts a supported release semver", () => {
  assert.equal(isUsableDesktopServiceVersion("0.16.109"), true);
  assert.equal(isUsableDesktopServiceVersion("1.2.3"), true);
});

test("isUsableDesktopServiceVersion rejects the Electron 0.0 sentinel", () => {
  assert.equal(isUsableDesktopServiceVersion("0.0"), false);
  assert.equal(isUsableDesktopServiceVersion(""), false);
  // Pre-release / build suffixes are not supported release versions.
  assert.equal(isUsableDesktopServiceVersion("0.16.109-rc.1"), false);
});

test("isUsableDesktopServiceVersion rejects the Electron-version bleed", () => {
  // Valid semver, but equal to the running Electron version → unpackaged bleed.
  assert.equal(
    isUsableDesktopServiceVersion("39.8.10", { electronVersion: "39.8.10" }),
    false
  );
  // A real app version that merely differs from Electron's is still usable.
  assert.equal(
    isUsableDesktopServiceVersion("0.16.109", { electronVersion: "39.8.10" }),
    true
  );
});

test("resolveDesktopServiceVersion prefers the build version when usable", () => {
  assert.equal(
    resolveDesktopServiceVersion({
      buildVersion: "0.16.109",
      runtimeVersion: "0.0",
      electronVersion: "39.8.10",
    }),
    "0.16.109"
  );
});

test("resolveDesktopServiceVersion falls back to the runtime version", () => {
  assert.equal(
    resolveDesktopServiceVersion({
      buildVersion: "",
      runtimeVersion: "0.16.91",
      electronVersion: "39.8.10",
    }),
    "0.16.91"
  );
});

test("resolveDesktopServiceVersion sentinels when no source is usable, with a warning", () => {
  const warnings: string[] = [];
  const resolved = resolveDesktopServiceVersion({
    buildVersion: "0.0",
    runtimeVersion: "39.8.10",
    electronVersion: "39.8.10",
    logWarning: (message) => warnings.push(message),
  });
  assert.equal(resolved, UNRESOLVED_DESKTOP_SERVICE_VERSION);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], UNRESOLVED_WARNING_PATTERN);
});

test("the unresolved sentinel is never the polluting 0.0 value", () => {
  assert.notEqual(UNRESOLVED_DESKTOP_SERVICE_VERSION, "0.0");
  // And it is itself a non-release value, so it can never masquerade as a build.
  assert.equal(
    isUsableDesktopServiceVersion(UNRESOLVED_DESKTOP_SERVICE_VERSION),
    false
  );
});
