/**
 * Regression guard for the single-writer append transaction bounds (FEA-4043).
 *
 * `append` and `appendClaimingOutbox` both block on a per-org
 * `pg_advisory_xact_lock`, so a contended same-org append can wait past Prisma's
 * 5s default interactive-transaction timeout and abort with a P2028. Both call
 * sites therefore pass an explicit `{ maxWait: 5000, timeout: 30_000 }` to
 * `withDb.tx`. The live concurrency test never holds the lock past the old 5s
 * limit and the drain unit test mocks `appendClaimingOutbox`, so neither would
 * fail if a call reverted to the default bounds — this test pins the exact
 * options wired to `withDb.tx` on both paths so that revert fails CI.
 */
import {
  AuditAction,
  AuditActorType,
  AuditObjectType,
} from "@repo/api/src/types/audit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithDb, mockTx } = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockTx: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  // `withDb.tx(fn, options)` — capture options; the callback is not invoked, so
  // the assertion depends only on the options wired at the call site.
  withDb: Object.assign(mockWithDb, { tx: mockTx }),
  Prisma: { sql: (...args: unknown[]) => args },
}));

import { auditLedgerService } from "../audit-ledger-service";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

// The exact bounds both append paths must pin. Sized to the advisory-lock
// writer convention (catalog pack import, pull-request handler): 30s work
// timeout, 5s max wait to acquire a pool connection.
const EXPECTED_APPEND_TX_OPTIONS = { maxWait: 5000, timeout: 30_000 };

const appendInput = {
  organizationId: ORG_ID,
  action: AuditAction.ApiKeyMinted,
  actorType: AuditActorType.System,
  actorId: null,
  objectType: AuditObjectType.ApiKey,
  objectId: "key-1",
  detail: {},
};

describe("audit append transaction bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTx.mockResolvedValue({ seq: "1", hash: "h" });
  });

  it("append pins 30s timeout / 5s maxWait on the append transaction", async () => {
    await auditLedgerService.append(appendInput);

    expect(mockTx).toHaveBeenCalledTimes(1);
    expect(mockTx.mock.calls[0][1]).toEqual(EXPECTED_APPEND_TX_OPTIONS);
  });

  it("appendClaimingOutbox pins 30s timeout / 5s maxWait on the claim+append transaction", async () => {
    // Third arg is the dead-letter cap (MAX_DRAIN_ATTEMPTS) from FEA-4044; the
    // value is irrelevant here since this test asserts only the tx options.
    await auditLedgerService.appendClaimingOutbox("outbox-1", appendInput, 10);

    expect(mockTx).toHaveBeenCalledTimes(1);
    expect(mockTx.mock.calls[0][1]).toEqual(EXPECTED_APPEND_TX_OPTIONS);
  });
});
