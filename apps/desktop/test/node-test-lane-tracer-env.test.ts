import assert from "node:assert/strict";
import test from "node:test";

import { TRACER_PRELOAD_TOKENS } from "../../../scripts/tracer-preload-tokens.mjs";
import { withoutTracerPreload } from "../scripts/node-test-lane-settings.mjs";

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

function restoreNodeOptions(): void {
  if (ORIGINAL_NODE_OPTIONS === undefined) {
    Reflect.deleteProperty(process.env, "NODE_OPTIONS");
    return;
  }
  process.env.NODE_OPTIONS = ORIGINAL_NODE_OPTIONS;
}
