import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { inspectSandboxPath } from "../src/main/ipc/sandbox-inspect.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

// ISS-4577: `inspectSandboxPath` gained an `exists` flag so the Settings sandbox
// editor can validate a typed path against disk (the native picker only ever
// returns existing folders). These tests cover the existence dimension: a real
// directory is `true`, a missing path is `false` — so the renderer can surface
// the inline "folder does not exist" error only for a KNOWN-missing path.

const { makeTempDir } = createTempDirManager("inspect-sandbox-");

describe("inspectSandboxPath — exists flag (ISS-4577)", () => {
  test("reports exists=true for an existing directory", () => {
    const dir = makeTempDir();

    const result = inspectSandboxPath(dir);

    assert.equal(result.exists, true);
    assert.equal(result.path, dir);
  });

  test("reports exists=false for a path that does not exist on disk", () => {
    const dir = makeTempDir();
    const missing = path.join(dir, "does-not-exist");

    const result = inspectSandboxPath(missing);

    assert.equal(result.exists, false);
    assert.equal(result.path, missing);
  });

  test("expands ~ before probing existence so an existing home-relative dir is not flagged missing", () => {
    // The home directory itself always exists; a literal "~" entry under the
    // Electron cwd does not. Probing the raw "~" would wrongly report missing.
    const result = inspectSandboxPath("~");

    assert.equal(result.exists, true);
    // `path` echoes the raw input so the renderer can match it against the field.
    assert.equal(result.path, "~");
  });

  test("skips the existence probe (exists=undefined) for a descendant of a TCC-protected root", () => {
    // ~/Documents/<x> is under a protected root; stat'ing it would pop a macOS
    // permission prompt. inspect must short-circuit to unknown, not "missing".
    const descendant = path.join(os.homedir(), "Documents", "some-nested-dir");

    const result = inspectSandboxPath(descendant);

    assert.equal(result.exists, undefined);
    assert.equal(result.path, descendant);
  });
});
