import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  TRACER_PRELOAD_TOKENS,
  withoutTracerPreload,
} from "../../../scripts/tracer-preload-tokens.mjs";
import { launcherEnv } from "./e2e/helpers/bridge-launcher-env";

const ORIGINAL_NODE_OPTIONS = process.env.NODE_OPTIONS;

test("the legacy lane preserves an ambient environment that has no NODE_OPTIONS", () => {
  try {
    Reflect.deleteProperty(process.env, "NODE_OPTIONS");

    const stripped = withoutTracerPreload(process.env);

    assert.equal(stripped.NODE_OPTIONS, undefined);
    assert.equal(Object.hasOwn(stripped, "NODE_OPTIONS"), false);
    assert.notEqual(stripped, process.env);
  } finally {
    restoreNodeOptions();
  }
});

test("the legacy lane removes an ambient NODE_OPTIONS containing only tracer tokens", () => {
  try {
    process.env.NODE_OPTIONS = TRACER_PRELOAD_TOKENS.join(" ");

    const stripped = withoutTracerPreload(process.env);

    assert.equal(stripped.NODE_OPTIONS, undefined);
    assert.equal(Object.hasOwn(stripped, "NODE_OPTIONS"), false);
    assert.equal(
      process.env.NODE_OPTIONS,
      TRACER_PRELOAD_TOKENS.join(" "),
      "the caller environment must remain unchanged"
    );
  } finally {
    restoreNodeOptions();
  }
});

test("the legacy lane retains non-tracer Node options and normalizes separator whitespace", () => {
  try {
    process.env.NODE_OPTIONS = `--enable-source-maps  ${TRACER_PRELOAD_TOKENS.join("   ")}   --max-old-space-size=8192`;

    const stripped = withoutTracerPreload(process.env);

    assert.equal(
      stripped.NODE_OPTIONS,
      "--enable-source-maps --max-old-space-size=8192"
    );
  } finally {
    restoreNodeOptions();
  }
});

// ISS-10943 (marisolashgrove, PR #8146): PR-level lanes never set NODE_OPTIONS,
// so only this case notices the bridge launcher inheriting the preload again.
test("the bridge sidecar launcher drops an ambient dd-trace preload", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-launcher-env-"));
  try {
    process.env.NODE_OPTIONS = TRACER_PRELOAD_TOKENS.join(" ");

    assert.equal(launcherEnv(root).NODE_OPTIONS, undefined);
  } finally {
    restoreNodeOptions();
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function restoreNodeOptions(): void {
  if (ORIGINAL_NODE_OPTIONS === undefined) {
    Reflect.deleteProperty(process.env, "NODE_OPTIONS");
    return;
  }
  process.env.NODE_OPTIONS = ORIGINAL_NODE_OPTIONS;
}
