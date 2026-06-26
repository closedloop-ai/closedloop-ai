import assert from "node:assert/strict";
import { test } from "node:test";
import { handleActivateEvent } from "../src/main/app-lifecycle.js";

test("activate handler logs rejected async work without rethrowing", async () => {
  const logs: string[] = [];

  await assert.doesNotReject(
    handleActivateEvent({
      handleActivate: async () => {
        throw new Error("handoff read failed");
      },
      log: (message) => logs.push(message),
    })
  );

  assert.equal(logs.length, 1);
  assert.match(logs[0], /activate handling failed: handoff read failed/);
});

test("activate handler does not log successful activation", async () => {
  const logs: string[] = [];

  await handleActivateEvent({
    handleActivate: async () => {},
    log: (message) => logs.push(message),
  });

  assert.deepEqual(logs, []);
});
