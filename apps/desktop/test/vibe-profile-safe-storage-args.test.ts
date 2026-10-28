import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { safeStorageHelperArgs } from "../scripts/vibe-profile/sign-in";

const HELPER = "scripts/vibe-profile/safe-storage-encrypt.mjs";
const LAUNCH_ARGS = ["--user-data-dir=synthetic/profile"];

describe("safeStorageHelperArgs", () => {
  it("on Linux, drops the sandbox a runner cannot set up and selects the walk's basic_text backend", () => {
    assert.deepEqual(safeStorageHelperArgs(HELPER, LAUNCH_ARGS, "linux"), [
      "--no-sandbox",
      "--password-store=basic",
      HELPER,
      ...LAUNCH_ARGS,
    ]);
  });

  it("keeps the sandbox and the native backend on macOS", () => {
    assert.deepEqual(safeStorageHelperArgs(HELPER, LAUNCH_ARGS, "darwin"), [
      HELPER,
      ...LAUNCH_ARGS,
    ]);
  });
});
