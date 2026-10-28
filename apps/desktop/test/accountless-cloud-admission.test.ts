import assert from "node:assert/strict";
import { test } from "vitest";
import { CloudSocketService } from "../src/main/cloud/cloud-socket.js";
import { createStubOptions } from "./helpers/cloud-socket-fixtures.js";

test("an API key alone cannot start the command socket without an account", async () => {
  const statuses: string[] = [];
  const service = new CloudSocketService(
    createStubOptions({
      getAccountAdmission: () => null,
      getApiKey: () => "sk_live_paired_only",
      onStatusChange: (status) => statuses.push(status.state),
    })
  );

  await service.start();

  assert.deepEqual(statuses, ["idle"]);
});

test("a stale socket start cannot authorize itself through a newer account", () => {
  const accountA = { userId: "user-a", organizationId: "org-a", generation: 1 };
  const accountB = { userId: "user-b", organizationId: "org-b", generation: 2 };
  let current = accountA;
  const service = new CloudSocketService(
    createStubOptions({ getAccountAdmission: () => current })
  );
  const internals = service as unknown as Record<string, unknown>;
  internals.stopped = false;
  internals.startGeneration = 1;
  internals.accountAdmission = accountA;
  const isStartCurrent = (
    Object.getPrototypeOf(service) as {
      isStartCurrent: (
        generation: number,
        admission: typeof accountA
      ) => boolean;
    }
  ).isStartCurrent.bind(service);

  assert.equal(isStartCurrent(1, accountA), true);
  current = accountB;
  internals.startGeneration = 2;
  internals.accountAdmission = accountB;
  assert.equal(isStartCurrent(1, accountA), false);
});
