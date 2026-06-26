import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  configureFakeUpdateFeed,
  FAKE_UPDATE_FEED_ENV,
  type FakeFeedAutoUpdater,
  getFakeUpdateFeedUrl,
  isFakeUpdateFeedActive,
  isPackagedUpdateFlowActive,
} from "../src/main/fake-update-feed.js";

describe("fake-update-feed seam (FEA-2099)", () => {
  test("getFakeUpdateFeedUrl trims and treats empty as unset", () => {
    assert.equal(getFakeUpdateFeedUrl({}), null);
    assert.equal(getFakeUpdateFeedUrl({ [FAKE_UPDATE_FEED_ENV]: "   " }), null);
    assert.equal(
      getFakeUpdateFeedUrl({
        [FAKE_UPDATE_FEED_ENV]: "  http://127.0.0.1:9/  ",
      }),
      "http://127.0.0.1:9/"
    );
  });

  test("isPackagedUpdateFlowActive: packaged always on; unpackaged needs the env seam", () => {
    // Packaged build ignores the env entirely.
    assert.equal(isPackagedUpdateFlowActive(true, {}), true);
    assert.equal(
      isPackagedUpdateFlowActive(true, {
        [FAKE_UPDATE_FEED_ENV]: "http://127.0.0.1:9",
      }),
      true
    );
    // Unpackaged build: off without the env, on with it.
    assert.equal(isPackagedUpdateFlowActive(false, {}), false);
    assert.equal(
      isPackagedUpdateFlowActive(false, {
        [FAKE_UPDATE_FEED_ENV]: "http://127.0.0.1:9",
      }),
      true
    );
  });

  test("isFakeUpdateFeedActive is true only for unpackaged + env set", () => {
    const env = { [FAKE_UPDATE_FEED_ENV]: "http://127.0.0.1:9" };
    // A real packaged client must never enter the fake-feed branch even if the
    // env var leaks in — that is the security-relevant invariant.
    assert.equal(isFakeUpdateFeedActive(true, env), false);
    assert.equal(isFakeUpdateFeedActive(false, env), true);
    assert.equal(isFakeUpdateFeedActive(false, {}), false);
  });

  test("configureFakeUpdateFeed sets the generic provider feed and disables on-quit install", () => {
    const calls: Array<{ provider: string; url: string }> = [];
    const updater: FakeFeedAutoUpdater = {
      forceDevUpdateConfig: false,
      autoInstallOnAppQuit: true,
      setFeedURL: (options) => {
        calls.push(options);
      },
    };

    configureFakeUpdateFeed(updater, "http://127.0.0.1:9/feed");

    assert.equal(updater.forceDevUpdateConfig, true);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.deepEqual(calls, [
      { provider: "generic", url: "http://127.0.0.1:9/feed" },
    ]);
  });
});
