import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { DESKTOP_DEEP_LINK_SCHEME } from "@repo/api/src/types/desktop-deep-link";
import { parse } from "yaml";

/**
 * ISS-6109 — packaging-config guard for the `closedloop://` deep link.
 *
 * `app.setAsDefaultProtocolClient` at runtime is NOT sufficient on its own for
 * the platform we ship: on macOS, LaunchServices only lets a bundle own a scheme
 * its `Info.plist` already declares, and electron-builder writes that
 * `CFBundleURLTypes` entry (and the Linux `.desktop` MimeType) from this
 * `protocols` block. Windows is the other way round — NSIS/Squirrel ignore
 * `protocols`, so there the runtime call is the whole story. Drop the block and
 * the web app's "Launch Desktop App" control silently returns to being a dead
 * button in every packaged macOS install — a regression no unit test of the
 * handler can see, because the handler is still perfectly correct and simply
 * never invoked.
 *
 * This reads the declarative electron-builder config (allowed config-file
 * assertion), not implementation source.
 */

// cwd for the desktop test suite is apps/desktop.
const CONFIG_PATH = path.resolve("electron-builder.yml");

type ProtocolEntry = {
  name?: string;
  schemes?: string[];
  role?: string;
};

function readProtocols(): ProtocolEntry[] {
  const config = parse(fs.readFileSync(CONFIG_PATH, "utf8")) as {
    protocols?: ProtocolEntry[];
  };
  return config.protocols ?? [];
}

describe("electron-builder deep-link protocol (ISS-6109)", () => {
  test("declares the shared deep-link scheme so installers register it", () => {
    const schemes = readProtocols().flatMap((entry) => entry.schemes ?? []);
    assert.ok(
      schemes.includes(DESKTOP_DEEP_LINK_SCHEME),
      `electron-builder.yml must declare the "${DESKTOP_DEEP_LINK_SCHEME}" scheme; found: ${JSON.stringify(schemes)}`
    );
  });

  test("gives the protocol entry a name, which macOS requires", () => {
    const entry = readProtocols().find((candidate) =>
      (candidate.schemes ?? []).includes(DESKTOP_DEEP_LINK_SCHEME)
    );
    assert.ok(entry, "deep-link protocol entry missing");
    assert.equal(typeof entry.name, "string");
    assert.notEqual(entry.name, "");
  });

  test("claims only the one scheme the handler actually accepts", () => {
    // The runtime policy accepts exactly `closedloop://` and refuses everything
    // else, so claiming a second scheme here would register an OS entry point
    // that can never do anything but get refused.
    const schemes = readProtocols().flatMap((entry) => entry.schemes ?? []);
    assert.deepEqual(schemes, [DESKTOP_DEEP_LINK_SCHEME]);
  });
});
