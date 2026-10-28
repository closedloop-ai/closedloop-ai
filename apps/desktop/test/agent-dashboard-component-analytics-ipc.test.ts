/**
 * @file agent-dashboard-component-analytics-ipc.test.ts
 * @description ISS-7979: real registrar coverage for component analytics IPC
 * coercion, legacy fallback, and wrong-identity refusal branches.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { registerComponentAnalyticsIpcHandlers } from "../src/main/dashboard/agent-dashboard-component-analytics-ipc.js";
import type {
  WithDb,
  WithPrisma,
} from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { SHARED_AGENT_COMPONENTS_IPC_CHANNELS } from "../src/shared/shared-agent-components-contract.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

const queryMocks = vi.hoisted(() => ({
  queryComponentModelTrend: vi.fn(
    async (
      _prisma: unknown,
      componentKind: string,
      componentKey: string,
      modelFilter: string | null,
      windowDays: number,
      fingerprint: string | null
    ) => ({
      componentKind,
      componentKey,
      modelFilter,
      windowDays,
      fingerprint,
      points: [],
    })
  ),
  querySubagentFrequency: vi.fn(
    async (
      _prisma: unknown,
      subagentKey: string,
      windowDays: number,
      fingerprint: string | null
    ) => ({ subagentKey, windowDays, fingerprint, points: [] })
  ),
  queryIsSkillLoaded: vi.fn(
    async (_prisma: unknown, skillKey: string, fingerprint: string | null) => ({
      skillKey,
      fingerprint,
      existsInInventory: true,
      hasUsage: false,
      totalInvocations: 0,
      lastUsedAt: null,
    })
  ),
}));

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

vi.mock(
  "../src/main/dashboard/optimization-analytics-queries.js",
  () => queryMocks
);

// ISS-8143: the DETAIL channel is the fourth refusal in this group and the one
// arm ISS-7979 left uncovered. Partial mock so the module's other exports
// (`coerceAgentComponentFilters`, `listAgentComponentsLocal`) stay real.
const detailMocks = vi.hoisted(() => ({
  getAgentComponentDetailLocal: vi.fn(async () => ({ slug: "a-real-detail" })),
}));

vi.mock("../src/main/dashboard/shared-agent-components-api.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/main/dashboard/shared-agent-components-api.js")
  >("../src/main/dashboard/shared-agent-components-api.js");
  return { ...actual, ...detailMocks };
});

const EVENT = { sender: {} };

beforeEach(() => {
  resetElectronModuleStub();
  vi.clearAllMocks();
  registerHandlers();
});

afterEach(() => {
  resetElectronModuleStub();
});

describe("component analytics IPC registration", () => {
  test("model trend preserves an integer window and forwards its filters", async () => {
    const result = await registeredInvokeHandler(
      "desktop:db:get-component-model-trend"
    )(EVENT, "skill", "review-soul", "sonnet", 45, "content-hash");

    assert.deepEqual(result, {
      componentKind: "skill",
      componentKey: "review-soul",
      modelFilter: "sonnet",
      windowDays: 45,
      fingerprint: "content-hash",
      points: [],
    });
    assert.deepEqual(
      queryMocks.queryComponentModelTrend.mock.calls[0]?.slice(1),
      ["skill", "review-soul", "sonnet", 45, "content-hash"]
    );
  });

  test("both day-window consumers default a fractional measurement", async () => {
    const trend = await registeredInvokeHandler(
      "desktop:db:get-component-model-trend"
    )(EVENT, "skill", "review-soul", "", 33.33, "");
    const frequency = await registeredInvokeHandler(
      "desktop:db:get-subagent-frequency"
    )(EVENT, "reviewer", 33.33, 42);

    assert.deepEqual(trend, {
      componentKind: "skill",
      componentKey: "review-soul",
      modelFilter: null,
      windowDays: 30,
      fingerprint: null,
      points: [],
    });
    assert.deepEqual(frequency, {
      subagentKey: "reviewer",
      windowDays: 30,
      fingerprint: null,
      points: [],
    });
    assert.equal(queryMocks.queryComponentModelTrend.mock.calls[0]?.[4], 30);
    assert.equal(queryMocks.querySubagentFrequency.mock.calls[0]?.[2], 30);
  });

  test("all three channels forward a valid fingerprint and degrade an invalid one", async () => {
    await registeredInvokeHandler("desktop:db:get-component-model-trend")(
      EVENT,
      "skill",
      "review-soul",
      undefined,
      30,
      "trend-hash"
    );
    await registeredInvokeHandler("desktop:db:get-subagent-frequency")(
      EVENT,
      "reviewer",
      30,
      "frequency-hash"
    );
    const skill = await registeredInvokeHandler("desktop:db:is-skill-loaded")(
      EVENT,
      "fleet-build",
      []
    );

    assert.equal(
      queryMocks.queryComponentModelTrend.mock.calls[0]?.[5],
      "trend-hash"
    );
    assert.equal(
      queryMocks.querySubagentFrequency.mock.calls[0]?.[3],
      "frequency-hash"
    );
    assert.equal(queryMocks.queryIsSkillLoaded.mock.calls[0]?.[2], null);
    assert.deepEqual(skill, {
      skillKey: "fleet-build",
      fingerprint: null,
      existsInInventory: true,
      hasUsage: false,
      totalInvocations: 0,
      lastUsedAt: null,
    });
  });

  test("wrong identities return their sentinels without touching any query", async () => {
    const trend = await registeredInvokeHandler(
      "desktop:db:get-component-model-trend"
    )(EVENT, null, "review-soul", "sonnet", 30, "content-hash");
    const trendWithInvalidKey = await registeredInvokeHandler(
      "desktop:db:get-component-model-trend"
    )(EVENT, "skill", {}, "sonnet", 30, "content-hash");
    const frequency = await registeredInvokeHandler(
      "desktop:db:get-subagent-frequency"
    )(EVENT, {}, 30, "content-hash");
    const skill = await registeredInvokeHandler("desktop:db:is-skill-loaded")(
      EVENT,
      17,
      "content-hash"
    );

    assert.deepEqual(trend, {
      componentKind: "",
      componentKey: "",
      windowDays: 0,
      points: [],
    });
    assert.deepEqual(trendWithInvalidKey, {
      componentKind: "",
      componentKey: "",
      windowDays: 0,
      points: [],
    });
    assert.deepEqual(frequency, {
      subagentKey: "",
      windowDays: 0,
      points: [],
    });
    assert.deepEqual(skill, {
      skillKey: "",
      existsInInventory: false,
      hasUsage: false,
      totalInvocations: 0,
      lastUsedAt: null,
    });
    assert.equal(queryMocks.queryComponentModelTrend.mock.calls.length, 0);
    assert.equal(queryMocks.querySubagentFrequency.mock.calls.length, 0);
    assert.equal(queryMocks.queryIsSkillLoaded.mock.calls.length, 0);
  });
});

function registerHandlers(): void {
  const prisma = {
    sentinel: "prisma",
  } as unknown as DbHostAgentDatabase["prisma"];
  const withPrisma: WithPrisma =
    (handler) =>
    (_event, ...args) =>
      Promise.resolve(handler(prisma, ...args));
  const withDb = (() => () =>
    Promise.reject(new Error("unrelated withDb handler invoked"))) as WithDb;

  registerComponentAnalyticsIpcHandlers({
    withDb,
    withPrisma,
    options: {
      getWindow: () => null,
      isTrustedSender: () => true,
    } as unknown as AgentDashboardDesignSystemRuntimeOptions,
  });
}

// ---------------------------------------------------------------------------
// ISS-8143 — the fourth refusal.
//
// ISS-7979 pinned the three `withPrisma` analytics refusals AND that their
// queries were never called. The `detail` channel is `withDb`, so it could not
// ride that harness (its `withDb` deliberately rejects to prove the analytics
// channels never touch it) and its guard stayed unexecuted: deleting
// `typeof slug !== "string" || slug.length === 0` was silently green, and a
// renderer-supplied non-string would have reached the local detail reader.
// ---------------------------------------------------------------------------

describe("ISS-8143 — the component detail channel refuses a bad slug", () => {
  function registerDetailHandler(): void {
    const agentDatabase = {
      prisma: { sentinel: "prisma" },
      syncSource: null,
    } as unknown as DbHostAgentDatabase;
    const withDb: WithDb =
      (handler) =>
      async (_event, ...args) =>
        await handler(agentDatabase, ...args);
    const withPrisma = (() => () =>
      Promise.reject(
        new Error("unrelated withPrisma handler invoked")
      )) as WithPrisma;

    registerComponentAnalyticsIpcHandlers({
      withDb,
      withPrisma,
      options: {
        getWindow: () => null,
        isTrustedSender: () => true,
      } as unknown as AgentDashboardDesignSystemRuntimeOptions,
    });
  }

  for (const slug of ["", 42, null, undefined, {}]) {
    test(`refuses ${JSON.stringify(slug) ?? "undefined"} without reading the store`, async () => {
      resetElectronModuleStub();
      detailMocks.getAgentComponentDetailLocal.mockClear();
      registerDetailHandler();

      const result = await registeredInvokeHandler(
        SHARED_AGENT_COMPONENTS_IPC_CHANNELS.detail
      )(EVENT, slug);

      assert.equal(result, null);
      assert.equal(
        detailMocks.getAgentComponentDetailLocal.mock.calls.length,
        0,
        "a refused slug must never reach the local detail reader"
      );
    });
  }

  test("a well-formed slug DOES reach the local detail reader", async () => {
    // The positive control: without it the whole block is satisfied by a
    // handler hard-wired to `return null`.
    resetElectronModuleStub();
    detailMocks.getAgentComponentDetailLocal.mockClear();
    registerDetailHandler();

    const result = await registeredInvokeHandler(
      SHARED_AGENT_COMPONENTS_IPC_CHANNELS.detail
    )(EVENT, "a-component-slug");

    assert.deepEqual(result, { slug: "a-real-detail" });
    assert.equal(detailMocks.getAgentComponentDetailLocal.mock.calls.length, 1);
  });
});
