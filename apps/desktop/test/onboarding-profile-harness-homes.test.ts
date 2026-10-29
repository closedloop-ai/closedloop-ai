/**
 * ISS-10555 — `scripts/onboarding-profile.sh` launches a real desktop build, so
 * it has to pin the same collector homes the E2E harness pins. It is a shell
 * script and cannot import the list, so it carries its own copy and this is what
 * holds the two together.
 *
 * Both assertions cover a failure that is SILENT in the script: a ninth
 * collector home added to `isolated-harness-homes.ts` and missed there does not
 * break the launch, it just lets that collector resolve under `os.homedir()` and
 * import the operator's real agent history into the throwaway profile — the
 * exact leak ISS-7731 closed for the harness. The ephemeral-ports argument is
 * the same shape: it fails SOFT, so a rename in `loopback-port-isolation.ts`
 * would leave the script binding the real 4820/4318 with nothing to show for it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { E2E_EPHEMERAL_LOOPBACK_PORTS_ARG } from "../src/main/lifecycle/loopback-port-isolation.js";
import { HARNESS_HOME_ENV_KEYS } from "./helpers/isolated-harness-homes.js";

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "onboarding-profile.sh"
);

/** The `HARNESS_HOME_KEYS="…"` block the script exports one temp home per. */
const PINNED_HOME_KEYS_RE = /\nHARNESS_HOME_KEYS="\n([^"]*)"/;
const WHITESPACE_RE = /\s+/;

test("onboarding-profile.sh pins every collector home the harness pins", () => {
  const block = PINNED_HOME_KEYS_RE.exec(readFileSync(SCRIPT_PATH, "utf8"));
  assert.ok(block, "onboarding-profile.sh has no HARNESS_HOME_KEYS list");
  const pinned = block[1].split(WHITESPACE_RE).filter(Boolean);
  assert.deepEqual(
    [...pinned].sort(),
    [...HARNESS_HOME_ENV_KEYS].sort(),
    "a collector home the script does not pin falls back to $HOME, so the launch imports the operator's real agent history"
  );
});

test("onboarding-profile.sh launches with the ephemeral loopback ports argument", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  assert.ok(
    script.includes(E2E_EPHEMERAL_LOOPBACK_PORTS_ARG),
    `onboarding-profile.sh must pass ${E2E_EPHEMERAL_LOOPBACK_PORTS_ARG}; without it the throwaway instance takes the real install's fixed 4820/4318, and both listeners fail soft`
  );
});
