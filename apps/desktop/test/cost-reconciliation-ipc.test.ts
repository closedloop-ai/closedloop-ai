import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vi } from "vitest";
import type { ClaudeCodeAnalyticsService } from "../src/main/cost/claude-code-analytics-service.js";
import type { CostReconciliationService } from "../src/main/cost/cost-reconciliation-service.js";
import {
  CostReconciliationIpcChannel,
  registerCostReconciliationIpcHandlers,
} from "../src/main/ipc/cost-reconciliation-ipc.js";
import {
  createIpcRegistrar,
  isTrustedSenderDouble,
  TRUSTED_EVENT,
  UNTRUSTED_EVENT,
  UNTRUSTED_SENDER_ERROR,
} from "./helpers/ipc-registrar.js";

// ISS-5300 (PRD-618): `cost-reconciliation-ipc.ts` was reached by no test.
// Three channels: `RunCostReconciliation` gates on sender trust; the other two do
// not. FINDING FOR ISS-4514 (Kris Wong): `ListCostReconciliation` and
// `GetClaudeCodeAnalytics` both parse renderer-supplied input — the latter feeds
// `windowDays` directly into the Anthropic Admin API — while ungated, in a module
// that already takes `isTrustedSender` and uses it only on one of three channels.
// Suspected defect; we document observable behavior, not intent.

const EMPTY_SUMMARY = {
  vendorsReconciled: [] as string[],
  vendorsQueried: [] as string[],
  rowsWritten: 0,
  notices: [] as unknown[],
  errors: [] as unknown[],
  computedAt: null as string | null,
  skippedBusy: false,
};

const EMPTY_ANALYTICS = {
  available: false,
  records: [] as unknown[],
  window: null as null,
  error: null as string | null,
  computedAt: null as string | null,
};

/**
 * Wire up the real handlers against a fake registrar. Pass overrides only when
 * a specific mock implementation matters for the assertion under test; the
 * defaults are no-op stubs that let other channels proceed without noise.
 */
function register(opts?: {
  runReconciliationNow?: () => Promise<unknown>;
  listRows?: (...args: unknown[]) => unknown;
  fetchAnalytics?: (...args: unknown[]) => Promise<unknown>;
}) {
  const runReconciliationNow = vi.fn(
    opts?.runReconciliationNow ?? (async () => EMPTY_SUMMARY)
  );
  const listRows = vi.fn(opts?.listRows ?? (() => [] as unknown[]));
  const fetchAnalytics = vi.fn(
    opts?.fetchAnalytics ?? (async () => EMPTY_ANALYTICS)
  );
  const harness = createIpcRegistrar();
  registerCostReconciliationIpcHandlers(harness.registrar, {
    isTrustedSender: isTrustedSenderDouble,
    costReconciliation: {
      runReconciliationNow,
      listRows,
    } as unknown as CostReconciliationService,
    claudeCodeAnalytics: {
      fetchAnalytics,
    } as unknown as ClaudeCodeAnalyticsService,
  });
  return { harness, runReconciliationNow, listRows, fetchAnalytics };
}

describe("cost-reconciliation IPC registration", () => {
  test("registers exactly the channels the contract declares", () => {
    const { harness } = register();
    assert.deepEqual(
      [...harness.channels()].sort(),
      Object.values(CostReconciliationIpcChannel).sort()
    );
  });
});

describe("RunCostReconciliation — gated channel", () => {
  test("rejects an untrusted sender before calling the reconciliation service", () => {
    const { harness, runReconciliationNow } = register();

    assert.throws(
      () =>
        harness.invoke(
          CostReconciliationIpcChannel.RunCostReconciliation,
          UNTRUSTED_EVENT
        ),
      UNTRUSTED_SENDER_ERROR
    );
    // The gate must fire before the service. If assertTrustedIpcSender were
    // removed the service would be called and callCount would become 1.
    assert.equal(runReconciliationNow.mock.calls.length, 0);
  });

  test("calls runReconciliationNow with a trusted sender and returns its result", async () => {
    const summary = {
      ...EMPTY_SUMMARY,
      vendorsReconciled: ["anthropic"],
      rowsWritten: 5,
      computedAt: "2024-06-01T00:00:00.000Z",
    };
    const { harness, runReconciliationNow } = register({
      runReconciliationNow: async () => summary,
    });

    // The handler is not async — it returns the promise that runReconciliationNow
    // produces. Await it so the assertion runs on the resolved value.
    const result = await (harness.invoke(
      CostReconciliationIpcChannel.RunCostReconciliation,
      TRUSTED_EVENT
    ) as Promise<unknown>);

    assert.equal(runReconciliationNow.mock.calls.length, 1);
    assert.deepEqual(result, summary);
  });
});

describe("ListCostReconciliation — ungated channel, sanitised input", () => {
  test("passes a well-formed query intact to listRows and returns its result", () => {
    const rows = [
      {
        day: "2024-06-01",
        vendor: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        localEstimateMicroCents: 1200,
        vendorBilledMicroCents: 1100,
        driftMicroCents: 100,
        driftPct: 9.09,
        computedAt: "2024-06-02T00:00:00.000Z",
      },
    ];
    const { harness, listRows } = register({ listRows: () => rows });

    const result = harness.invoke(
      CostReconciliationIpcChannel.ListCostReconciliation,
      UNTRUSTED_EVENT,
      { from: "2024-06-01", to: "2024-06-30", vendor: "anthropic" }
    );

    assert.equal(listRows.mock.calls.length, 1);
    assert.deepEqual(listRows.mock.calls[0][0], {
      from: "2024-06-01",
      to: "2024-06-30",
      vendor: "anthropic",
    });
    assert.deepEqual(result, rows);
  });

  test("passes undefined to listRows when the only field has an unrecognised vendor", () => {
    // parseReconciliationQuery only accepts "anthropic" | "openai"; any other
    // vendor string leaves the parsed object empty and the function returns
    // undefined. Removing that allowlist check would produce { vendor: "..." }.
    const { harness, listRows } = register();

    harness.invoke(
      CostReconciliationIpcChannel.ListCostReconciliation,
      UNTRUSTED_EVENT,
      { vendor: "unknown-vendor" }
    );

    assert.equal(listRows.mock.calls.length, 1);
    assert.equal(listRows.mock.calls[0][0], undefined);
  });

  test("drops a malformed from field and passes the surviving valid field to listRows", () => {
    // ISO_DAY_RE rejects "not-a-date"; the surviving vendor field makes it
    // through. Removing the regex test would include from in the output.
    const { harness, listRows } = register();

    harness.invoke(
      CostReconciliationIpcChannel.ListCostReconciliation,
      UNTRUSTED_EVENT,
      { from: "not-a-date", vendor: "openai" }
    );

    assert.equal(listRows.mock.calls.length, 1);
    assert.deepEqual(listRows.mock.calls[0][0], { vendor: "openai" });
  });

  test("passes undefined to listRows when the query is not an object", () => {
    // The non-object guard returns undefined before any field checks run.
    const { harness, listRows } = register();

    harness.invoke(
      CostReconciliationIpcChannel.ListCostReconciliation,
      UNTRUSTED_EVENT,
      "not-an-object"
    );

    assert.equal(listRows.mock.calls.length, 1);
    assert.equal(listRows.mock.calls[0][0], undefined);
  });
});

describe("GetClaudeCodeAnalytics — ungated channel, sanitised input", () => {
  test("passes a valid numeric windowDays to fetchAnalytics", async () => {
    // parseClaudeCodeAnalyticsQuery returns { windowDays: 14 } for a finite number.
    const { harness, fetchAnalytics } = register();

    await (harness.invoke(
      CostReconciliationIpcChannel.GetClaudeCodeAnalytics,
      UNTRUSTED_EVENT,
      { windowDays: 14 }
    ) as Promise<unknown>);

    assert.equal(fetchAnalytics.mock.calls.length, 1);
    assert.deepEqual(fetchAnalytics.mock.calls[0][0], {
      windowDays: 14,
    });
  });

  test("drops a string windowDays and passes undefined to fetchAnalytics", async () => {
    // typeof "14" === "number" is false; the field is silently dropped.
    // If the type check were removed, fetchAnalytics would receive { windowDays: "14" }.
    const { harness, fetchAnalytics } = register();

    await (harness.invoke(
      CostReconciliationIpcChannel.GetClaudeCodeAnalytics,
      UNTRUSTED_EVENT,
      { windowDays: "14" }
    ) as Promise<unknown>);

    assert.equal(fetchAnalytics.mock.calls.length, 1);
    assert.equal(fetchAnalytics.mock.calls[0][0], undefined);
  });

  test("drops a non-finite windowDays and passes undefined to fetchAnalytics", async () => {
    // Number.isFinite(Infinity) is false; Infinity must not reach the service.
    const { harness, fetchAnalytics } = register();

    await (harness.invoke(
      CostReconciliationIpcChannel.GetClaudeCodeAnalytics,
      UNTRUSTED_EVENT,
      { windowDays: Number.POSITIVE_INFINITY }
    ) as Promise<unknown>);

    assert.equal(fetchAnalytics.mock.calls.length, 1);
    assert.equal(fetchAnalytics.mock.calls[0][0], undefined);
  });

  test("returns the analytics result from fetchAnalytics", async () => {
    const expected = {
      available: true,
      records: [
        {
          day: "2024-06-01",
          actor: "user@example.com",
          actorType: "user",
          model: "claude-3-5-sonnet-20241022",
          estimatedCostMicroCents: 100_000,
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      ],
      window: { startDay: "2024-06-01", endDay: "2024-06-07" },
      error: null,
      computedAt: "2024-06-08T00:00:00.000Z",
    };
    const { harness } = register({ fetchAnalytics: async () => expected });

    const result = await (harness.invoke(
      CostReconciliationIpcChannel.GetClaudeCodeAnalytics,
      UNTRUSTED_EVENT,
      { windowDays: 7 }
    ) as Promise<unknown>);

    assert.deepEqual(result, expected);
  });
});
