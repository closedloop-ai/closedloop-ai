import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { APP_VERSION_CHECK_ID } from "@closedloop-ai/loops-api/compute-target";
import { CLAUDE_CLI_CHECK_ID } from "../src/server/operations/health-check-blocked.js";
import {
  CLOSEDLOOP_USER_PLUGINS,
  getClosedloopPluginByCheckId,
  getDisabledClosedloopPlugins,
} from "../src/server/operations/health-check-plugin-enable.js";
import {
  PLUGIN_CHECK_ID_PREFIX,
  PLUGIN_DISABLED_ERROR,
  PLUGIN_STATE_UNVERIFIED_ERROR,
  pluginCheckId,
} from "../src/server/operations/health-check-types.js";

/**
 * Wire-contract pins for the System Check check ids and plugin state strings
 * (ISS-5389 review).
 *
 * Within this repo these values are now shared symbols, so producer and
 * consumer cannot drift apart by string value. They are pinned here because
 * they still cross two boundaries a shared symbol does NOT cover: the web panel
 * in `apps/app` / `packages/app`, which matches on the literal id, and already
 * installed Desktop builds that keep emitting the old value. Changing one of
 * these is a wire change, not a rename, and has to be a deliberate edit here.
 */

describe("System Check wire contract", () => {
  test("check ids keep the values the web panel matches on", () => {
    assert.equal(CLAUDE_CLI_CHECK_ID, "claude-cli");
    assert.equal(APP_VERSION_CHECK_ID, "app-version");
    assert.equal(PLUGIN_CHECK_ID_PREFIX, "plugin-");
  });

  test("plugin state strings keep the values the classifier reads back", () => {
    assert.equal(PLUGIN_DISABLED_ERROR, "Disabled");
    assert.equal(
      PLUGIN_STATE_UNVERIFIED_ERROR,
      "Could not verify enabled state"
    );
  });

  test("every plugin row id the gateway mints resolves back to its plugin", () => {
    assert.ok(CLOSEDLOOP_USER_PLUGINS.length > 0);
    for (const plugin of CLOSEDLOOP_USER_PLUGINS) {
      const checkId = pluginCheckId(plugin.folder);
      assert.ok(
        checkId.startsWith(PLUGIN_CHECK_ID_PREFIX),
        `${checkId} must carry the wire prefix`
      );
      assert.equal(
        getClosedloopPluginByCheckId(checkId)?.folder,
        plugin.folder
      );
    }
  });

  test("a disabled plugin row is classified from the shared state string", () => {
    const [plugin] = CLOSEDLOOP_USER_PLUGINS;
    const disabled = getDisabledClosedloopPlugins([
      {
        id: pluginCheckId(plugin.folder),
        label: plugin.label,
        required: plugin.required,
        passed: false,
        error: PLUGIN_DISABLED_ERROR,
      },
    ]);
    assert.deepEqual(
      disabled.map((entry) => entry.folder),
      [plugin.folder]
    );
  });

  test("a row failing for some other reason is not read as disabled", () => {
    const [plugin] = CLOSEDLOOP_USER_PLUGINS;
    const disabled = getDisabledClosedloopPlugins([
      {
        id: pluginCheckId(plugin.folder),
        label: plugin.label,
        required: plugin.required,
        passed: false,
        error: PLUGIN_STATE_UNVERIFIED_ERROR,
      },
    ]);
    assert.deepEqual(disabled, []);
  });
});
