import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { snapshotProfileFiles } from "./e2e/helpers/profile-file-snapshot.js";

const SETTINGS = "desktop-settings.json";
const ASSIGNMENT = "e2e-feature-flags.json";
const ORIGINAL_SETTINGS = '{"agentsNav":false}';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-snapshot-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("snapshotProfileFiles", () => {
  it("puts back a file the walk rewrote and removes one it created", () => {
    fs.writeFileSync(path.join(dir, SETTINGS), ORIGINAL_SETTINGS);
    const restore = snapshotProfileFiles(dir, [SETTINGS, ASSIGNMENT]);
    fs.writeFileSync(path.join(dir, SETTINGS), '{"agentsNav":true}');
    fs.writeFileSync(path.join(dir, ASSIGNMENT), '{"tags":true}');

    restore();

    assert.equal(
      fs.readFileSync(path.join(dir, SETTINGS), "utf8"),
      ORIGINAL_SETTINGS
    );
    assert.equal(fs.existsSync(path.join(dir, ASSIGNMENT)), false);
  });
});
