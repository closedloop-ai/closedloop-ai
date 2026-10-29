/**
 * ISS-12552 (PRD-800 "Rollout"): a settled parse-policy flip reaches the
 * db host however early it lands. The lifecycle subscribes when it is created,
 * before `start` reads the policy, so a flip that lands while the child is
 * still opening is pushed once it is ready and kept for a restarted child.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import type { createAgentDashboardDbHostLifecycle as CreateLifecycle } from "../src/main/dashboard/agent-dashboard-db-host-lifecycle.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import { DB_HOST_STORE_OP_PREFIX } from "../src/main/database/db-host/db-host-store-op-registry.js";
import { setEffectiveParsePolicy } from "../src/main/parse-policy/effective-parse-policy.js";
import {
  PARSE_POLICY_ATTRIBUTION,
  PARSE_POLICY_BASE,
  PARSE_POLICY_SET_STORE_OP,
} from "../src/main/parse-policy/parse-policy.js";
import { notifyParsePolicyFlip } from "../src/main/parse-policy/parse-policy-resolver.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";

const BOOT_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 20_000;
const SET_OP = `${DB_HOST_STORE_OP_PREFIX}${PARSE_POLICY_SET_STORE_OP}`;

type Posted = {
  kind: string;
  id?: number;
  op?: string;
  args?: unknown[];
  options?: { parsePolicy?: unknown };
};

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeFakeChild() {
  const posted: Posted[] = [];
  let messageListener: DbHostChildMessageListener | undefined;
  let exitListener: DbHostChildExitListener | undefined;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "exit") {
        exitListener = args[1];
      } else {
        messageListener = args[1];
      }
      return child;
    },
    postMessage(message: Posted) {
      posted.push(message);
    },
    kill() {
      exitListener?.(0);
    },
  };
  return {
    child,
    posted,
    ready() {
      const id = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({ kind: DbHostResponseKind.Ready, id });
    },
    pushes(): unknown[] {
      return posted
        .filter((m) => m.kind === DbHostRequestKind.Invoke && m.op === SET_OP)
        .map((m) => m.args?.[0]);
    },
  };
}

describe("db-host parse policy push (ISS-12552)", () => {
  let electronMock: ElectronModuleMock;
  let createLifecycle: typeof CreateLifecycle;

  beforeAll(async () => {
    electronMock = registerElectronModuleMock();
    ({ createAgentDashboardDbHostLifecycle: createLifecycle } = await import(
      "../src/main/dashboard/agent-dashboard-db-host-lifecycle.js"
    ));
  });

  afterAll(() => {
    electronMock.deregister();
  });

  afterEach(() => {
    setEffectiveParsePolicy(PARSE_POLICY_BASE);
  });

  test("a flip that lands while the child is opening reaches it once it is ready", {
    timeout: BOOT_TIMEOUT_MS,
  }, async () => {
    setEffectiveParsePolicy(PARSE_POLICY_BASE);
    const fake = makeFakeChild();
    const lifecycle = createLifecycle({
      options: {
        getWindow: () => null,
        isTrustedSender: () => false,
        userDataPath: "/tmp/iss-12552-parse-policy-push",
      } as unknown as AgentDashboardDesignSystemRuntimeOptions,
      log: () => undefined,
      getPackScanCoordinator: () => null,
      getCatalogCoordinator: () => null,
      fork: () => fake.child,
    });
    try {
      await waitFor("the db host to post Init", () => fake.posted.length > 0);
      assert.deepEqual(
        fake.posted.find((m) => m.kind === DbHostRequestKind.Init)?.options
          ?.parsePolicy,
        PARSE_POLICY_BASE
      );

      // Init read the base policy; the flip lands before the child is ready.
      setEffectiveParsePolicy(PARSE_POLICY_ATTRIBUTION);
      notifyParsePolicyFlip(PARSE_POLICY_ATTRIBUTION);
      assert.deepEqual(fake.pushes(), []);

      fake.ready();
      await lifecycle.ready;
      await waitFor("the policy push", () => fake.pushes().length > 0);
      assert.deepEqual(fake.pushes(), [PARSE_POLICY_ATTRIBUTION]);
    } finally {
      lifecycle.beginClosing();
    }
  });
});
