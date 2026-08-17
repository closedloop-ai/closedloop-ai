// ISS-5300 (PRD-618): `approvals-ipc.ts` was reached by no test. Eight channels
// split into two ungated reads and six gated writes. The suite covers:
// gate rejection on every mutating channel with a call-count proof that the gate
// precedes the effect; `assertApprovalId` on three invalid inputs; the
// `AlwaysAllowApproval` early-return no-op when the pending item is absent; and
// positive-control assertions on each channel.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vi } from "vitest";
import type {
  ApprovalStore,
  PendingApproval,
  ResolvedApproval,
} from "../src/main/approvals/approval-store.js";
import {
  ApprovalsIpcChannel,
  registerApprovalsIpcHandlers,
} from "../src/main/ipc/approvals-ipc.js";
import type { SettingsStore } from "../src/main/settings/settings-store.js";
import type { AlwaysAllowRule } from "../src/shared/contracts.js";
import {
  createIpcRegistrar,
  isTrustedSenderDouble,
  TRUSTED_EVENT,
  UNTRUSTED_EVENT,
  UNTRUSTED_SENDER_ERROR,
} from "./helpers/ipc-registrar.js";

// Module-level regex constants (Ultracite useTopLevelRegex).
const APPROVAL_ID_REQUIRED_ERROR = /approvalId is required/;

const FAKE_PENDING: PendingApproval = {
  id: "approval-1",
  createdAt: "2024-01-01T00:00:00.000Z",
  operationId: "op-1",
  riskTier: "low",
  method: "POST",
  path: "/api/write",
  location: "test-location",
  reason: "test reason",
  fingerprint: "abc123def456",
};

const FAKE_RESOLVED: ResolvedApproval = {
  ...FAKE_PENDING,
  decision: "approved",
  resolvedAt: "2024-01-01T00:00:01.000Z",
};

const FAKE_RULE_A: AlwaysAllowRule = {
  id: "rule-a",
  operationId: "op-a",
  method: "POST",
  path: "/api/write",
  createdAt: "2024-01-01T00:00:00.000Z",
  expiresAt: "2025-01-01T00:00:00.000Z",
};

const FAKE_RULE_B: AlwaysAllowRule = {
  id: "rule-b",
  operationId: "op-b",
  method: "GET",
  path: "/api/read",
  createdAt: "2024-01-01T00:00:00.000Z",
  expiresAt: "2025-01-01T00:00:00.000Z",
};

/**
 * Wire up the real handlers against a fake registrar. Pass overrides only when
 * a specific mock implementation matters for the assertion under test; the
 * defaults are no-op stubs that let other channels proceed without noise.
 */
function registerWithOpts(
  opts: {
    pendingItems?: PendingApproval[];
    resolvedItems?: ResolvedApproval[];
    pendingById?: (id: string) => PendingApproval | null;
    alwaysAllowRules?: AlwaysAllowRule[];
    isTrustedSender?: (sender: unknown) => boolean;
  } = {}
) {
  const pendingItems = opts.pendingItems ?? [];
  const resolvedItems = opts.resolvedItems ?? [];
  const alwaysAllowRules = opts.alwaysAllowRules ?? [];

  const listPending = vi.fn(() => pendingItems);
  const listResolved = vi.fn(() => resolvedItems);
  const clearResolved = vi.fn(() => undefined);
  const approve = vi.fn((_id: string) => undefined);
  const deny = vi.fn((_id: string) => undefined);
  const getPendingById = vi.fn(
    opts.pendingById ?? ((_id: string) => null as PendingApproval | null)
  );
  const alwaysAllow = vi.fn((_id: string) => undefined);
  const clear = vi.fn(() => undefined);

  const getAll = vi.fn(() => ({ alwaysAllowRules }));
  const setAlwaysAllowRules = vi.fn((_rules: AlwaysAllowRule[]) => undefined);
  const saveAlwaysAllowRuleForPending = vi.fn(
    (_pending: PendingApproval) => undefined
  );

  const approvalStore = {
    listPending,
    listResolved,
    clearResolved,
    approve,
    deny,
    getPendingById,
    alwaysAllow,
    clear,
  } as unknown as ApprovalStore;

  const settingsStore = {
    getAll,
    setAlwaysAllowRules,
  } as unknown as SettingsStore;

  const harness = createIpcRegistrar();
  registerApprovalsIpcHandlers(harness.registrar, {
    isTrustedSender: opts.isTrustedSender ?? isTrustedSenderDouble,
    approvalStore,
    settingsStore,
    saveAlwaysAllowRuleForPending,
  });

  return {
    harness,
    listPending,
    listResolved,
    clearResolved,
    approve,
    deny,
    getPendingById,
    alwaysAllow,
    clear,
    getAll,
    setAlwaysAllowRules,
    saveAlwaysAllowRuleForPending,
  };
}

describe("approvals IPC registration", () => {
  test("registers exactly the channels declared in ApprovalsIpcChannel", () => {
    const { harness } = registerWithOpts();
    assert.deepEqual(
      [...harness.channels()].sort(),
      Object.values(ApprovalsIpcChannel).sort()
    );
  });
});

describe("approvals IPC gated channels — untrusted sender rejection", () => {
  test("ClearResolvedApprovals rejects untrusted sender before clearing", () => {
    const { harness, clearResolved } = registerWithOpts();
    assert.throws(
      () =>
        harness.invoke(
          ApprovalsIpcChannel.ClearResolvedApprovals,
          UNTRUSTED_EVENT
        ),
      UNTRUSTED_SENDER_ERROR
    );
    // Removing assertTrustedIpcSender would let clearResolved run; the call
    // count, not the throw, proves the gate precedes the side effect.
    assert.equal(clearResolved.mock.calls.length, 0);
  });

  test("ApproveApproval rejects untrusted sender before approving", () => {
    const { harness, approve } = registerWithOpts();
    assert.throws(
      () =>
        harness.invoke(
          ApprovalsIpcChannel.ApproveApproval,
          UNTRUSTED_EVENT,
          "approval-1"
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(approve.mock.calls.length, 0);
  });

  test("DenyApproval rejects untrusted sender before denying", () => {
    const { harness, deny } = registerWithOpts();
    assert.throws(
      () =>
        harness.invoke(
          ApprovalsIpcChannel.DenyApproval,
          UNTRUSTED_EVENT,
          "approval-1"
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(deny.mock.calls.length, 0);
  });

  test("AlwaysAllowApproval rejects untrusted sender before consulting the store", () => {
    const { harness, getPendingById } = registerWithOpts();
    assert.throws(
      () =>
        harness.invoke(
          ApprovalsIpcChannel.AlwaysAllowApproval,
          UNTRUSTED_EVENT,
          "approval-1"
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(getPendingById.mock.calls.length, 0);
  });

  test("RemoveAlwaysAllowRule rejects untrusted sender before modifying settings", () => {
    const { harness, setAlwaysAllowRules } = registerWithOpts();
    assert.throws(
      () =>
        harness.invoke(
          ApprovalsIpcChannel.RemoveAlwaysAllowRule,
          UNTRUSTED_EVENT,
          "rule-a"
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(setAlwaysAllowRules.mock.calls.length, 0);
  });

  test("ClearPendingApprovals rejects untrusted sender before clearing", () => {
    const { harness, clear } = registerWithOpts();
    assert.throws(
      () =>
        harness.invoke(
          ApprovalsIpcChannel.ClearPendingApprovals,
          UNTRUSTED_EVENT
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(clear.mock.calls.length, 0);
  });
});

describe("approvals IPC assertApprovalId validation", () => {
  test("empty string approvalId throws approvalId required, store unmutated", () => {
    const { harness, approve } = registerWithOpts();
    assert.throws(
      () =>
        harness.invoke(ApprovalsIpcChannel.ApproveApproval, TRUSTED_EVENT, ""),
      APPROVAL_ID_REQUIRED_ERROR
    );
    assert.equal(approve.mock.calls.length, 0);
  });

  test("whitespace-only approvalId throws approvalId required, store unmutated", () => {
    const { harness, approve } = registerWithOpts();
    assert.throws(
      () =>
        harness.invoke(
          ApprovalsIpcChannel.ApproveApproval,
          TRUSTED_EVENT,
          "   "
        ),
      APPROVAL_ID_REQUIRED_ERROR
    );
    assert.equal(approve.mock.calls.length, 0);
  });

  test("non-string approvalId throws approvalId required, store unmutated", () => {
    const { harness, approve } = registerWithOpts();
    assert.throws(
      () =>
        harness.invoke(ApprovalsIpcChannel.ApproveApproval, TRUSTED_EVENT, 42),
      APPROVAL_ID_REQUIRED_ERROR
    );
    assert.equal(approve.mock.calls.length, 0);
  });

  test("padded approvalId is trimmed before reaching the store", () => {
    // assertApprovalId returns approvalId.trim(). Mutating that to `return
    // approvalId` (no trim) turns this RED: approve receives "  abc  " not "abc".
    const { harness, approve } = registerWithOpts();
    harness.invoke(
      ApprovalsIpcChannel.ApproveApproval,
      TRUSTED_EVENT,
      "  abc  "
    );
    assert.equal(approve.mock.calls.length, 1);
    assert.deepEqual(approve.mock.calls[0], ["abc"]);
  });
});

describe("approvals IPC gated channel behaviour for a trusted sender", () => {
  test("ClearResolvedApprovals calls clearResolved and returns empty list", () => {
    const { harness, clearResolved } = registerWithOpts();
    const result = harness.invoke(
      ApprovalsIpcChannel.ClearResolvedApprovals,
      TRUSTED_EVENT
    );
    assert.equal(clearResolved.mock.calls.length, 1);
    // The handler always returns []; returning undefined here would break this.
    assert.deepEqual(result, []);
  });

  test("ApproveApproval calls approve with the id and returns the pending list", () => {
    const pendingItems = [FAKE_PENDING];
    const { harness, approve, listPending } = registerWithOpts({
      pendingItems,
    });
    const result = harness.invoke(
      ApprovalsIpcChannel.ApproveApproval,
      TRUSTED_EVENT,
      FAKE_PENDING.id
    );
    assert.equal(approve.mock.calls.length, 1);
    assert.deepEqual(approve.mock.calls[0], [FAKE_PENDING.id]);
    assert.equal(listPending.mock.calls.length, 1);
    assert.deepEqual(result, pendingItems);
  });

  test("DenyApproval calls deny with the id and returns the pending list", () => {
    const { harness, deny, listPending } = registerWithOpts();
    const result = harness.invoke(
      ApprovalsIpcChannel.DenyApproval,
      TRUSTED_EVENT,
      FAKE_PENDING.id
    );
    assert.equal(deny.mock.calls.length, 1);
    assert.deepEqual(deny.mock.calls[0], [FAKE_PENDING.id]);
    assert.equal(listPending.mock.calls.length, 1);
    assert.deepEqual(result, []);
  });

  test("AlwaysAllowApproval early-returns without saving or allowing when pending is not found", () => {
    // `getPendingById` returns null by default; the handler hits the early-return
    // branch. Removing that branch would make both mocks run (callCount = 1).
    const {
      harness,
      getPendingById,
      saveAlwaysAllowRuleForPending,
      alwaysAllow,
    } = registerWithOpts();

    const result = harness.invoke(
      ApprovalsIpcChannel.AlwaysAllowApproval,
      TRUSTED_EVENT,
      "nonexistent"
    );

    assert.equal(getPendingById.mock.calls.length, 1);
    assert.equal(saveAlwaysAllowRuleForPending.mock.calls.length, 0);
    assert.equal(alwaysAllow.mock.calls.length, 0);
    // The early-return still builds the full response. Deleting `settings:` from
    // the early-return in the source turns this RED.
    assert.deepEqual(result, {
      pendingApprovals: [],
      settings: { alwaysAllowRules: [] },
    });
  });

  test("AlwaysAllowApproval saves the rule and always-allows when the pending item exists", () => {
    const { harness, saveAlwaysAllowRuleForPending, alwaysAllow, listPending } =
      registerWithOpts({
        pendingItems: [],
        pendingById: (id) => (id === FAKE_PENDING.id ? FAKE_PENDING : null),
      });

    const result = harness.invoke(
      ApprovalsIpcChannel.AlwaysAllowApproval,
      TRUSTED_EVENT,
      FAKE_PENDING.id
    ) as {
      pendingApprovals: PendingApproval[];
      settings: { alwaysAllowRules: unknown[] };
    };

    assert.equal(saveAlwaysAllowRuleForPending.mock.calls.length, 1);
    assert.deepEqual(
      saveAlwaysAllowRuleForPending.mock.calls[0][0],
      FAKE_PENDING
    );
    assert.equal(alwaysAllow.mock.calls.length, 1);
    assert.deepEqual(alwaysAllow.mock.calls[0], [FAKE_PENDING.id]);
    assert.equal(listPending.mock.calls.length, 1);
    assert.deepEqual(result.pendingApprovals, []);
    // Deleting `settings: deps.settingsStore.getAll()` from the happy-path return
    // in the source turns this RED.
    assert.deepEqual(result.settings, { alwaysAllowRules: [] });
  });

  test("RemoveAlwaysAllowRule filters the target rule and persists the remainder", () => {
    const { harness, setAlwaysAllowRules } = registerWithOpts({
      alwaysAllowRules: [FAKE_RULE_A, FAKE_RULE_B],
    });

    const result = harness.invoke(
      ApprovalsIpcChannel.RemoveAlwaysAllowRule,
      TRUSTED_EVENT,
      FAKE_RULE_A.id
    );

    assert.equal(setAlwaysAllowRules.mock.calls.length, 1);
    // Removing the filter predicate would produce [FAKE_RULE_A, FAKE_RULE_B].
    assert.deepEqual(setAlwaysAllowRules.mock.calls[0][0], [FAKE_RULE_B]);
    assert.deepEqual(result, { alwaysAllowRules: [FAKE_RULE_B] });
  });

  test("ClearPendingApprovals calls clear and returns the pending list", () => {
    const { harness, clear, listPending } = registerWithOpts();
    const result = harness.invoke(
      ApprovalsIpcChannel.ClearPendingApprovals,
      TRUSTED_EVENT
    );
    assert.equal(clear.mock.calls.length, 1);
    assert.equal(listPending.mock.calls.length, 1);
    assert.deepEqual(result, []);
  });
});

describe("approvals IPC ungated reads", () => {
  test("GetPendingApprovals returns the pending list to an untrusted sender", () => {
    // These two channels have no gate; asserting observable behavior on an
    // untrusted event documents the real contract without freezing the missing
    // gate as intentional (only logs-activity-ipc and managed-key-hint-ipc are
    // blessed as deliberately ungated in desktop-ipc-registration.ts:233-234).
    const pendingItems = [FAKE_PENDING];
    const { harness } = registerWithOpts({ pendingItems });
    assert.deepEqual(
      harness.invoke(ApprovalsIpcChannel.GetPendingApprovals, UNTRUSTED_EVENT),
      pendingItems
    );
  });

  test("GetResolvedApprovals returns the resolved list to an untrusted sender", () => {
    const resolvedItems = [FAKE_RESOLVED];
    const { harness } = registerWithOpts({ resolvedItems });
    assert.deepEqual(
      harness.invoke(ApprovalsIpcChannel.GetResolvedApprovals, UNTRUSTED_EVENT),
      resolvedItems
    );
  });
});
