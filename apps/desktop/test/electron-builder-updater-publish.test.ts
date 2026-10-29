import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { parse } from "yaml";

/**
 * ISS-10424 — packaging-config guard for differential updates.
 *
 * electron-builder copies the `publish` block into the packaged app's
 * `app-update.yml`, and electron-updater's generic provider sends differential
 * downloads as multi-range requests unless it says otherwise. The API route
 * redirects those requests to GitHub's release-asset CDN, which answers a
 * multi-range request with `501 Unsupported client range`. Drop the flag and
 * every differential download quietly falls back to the full ~275 MB build:
 * the update still succeeds, so nothing else would notice.
 *
 * Reads the declarative electron-builder config, not implementation source.
 */

// cwd for the desktop test suite is apps/desktop.
const CONFIG_PATH = path.resolve("electron-builder.yml");

type PublishConfig = {
  provider?: string;
  url?: string;
  useMultipleRangeRequest?: boolean;
};

function readPublish(): PublishConfig {
  const config = parse(fs.readFileSync(CONFIG_PATH, "utf8")) as {
    publish?: PublishConfig;
  };
  return config.publish ?? {};
}

describe("electron-builder updater publish config (ISS-10424)", () => {
  test("asks for one byte range per differential request", () => {
    const publish = readPublish();
    assert.equal(publish.provider, "generic");
    assert.equal(publish.useMultipleRangeRequest, false);
  });
});
