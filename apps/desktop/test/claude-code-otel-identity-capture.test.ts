/**
 * ISS-7352 item F, IDENTITY half — the per-session account and organization
 * identifiers that say WHOSE session a `claude_code_*` row describes.
 *
 * Three contracts are asserted here and none is provable from the others: what
 * IS read (the identifiers, all the way into the column), what is deliberately
 * NOT (`user.email`, `user.groups`, which ride on the same records — a suite
 * that only checked the first would stay green if the reader swept up every
 * attribute it saw), and how two readings of one session COMBINE. That last
 * one is pinned in both places it is decided, in-batch and across separate
 * exports, because a rule stated in only one of them lets where a pair of
 * records happens to land decide which account a session is attributed to.
 *
 * The DB cases drive the WIRED receiver, so each proves the production path —
 * receiver, normalizer, reduction, persister, column — and not just the reader
 * under it.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeCodeOtelAttributeKey } from "../src/main/otel/claude-code-otel-attributes.js";
import { ClaudeCodeOtelEventName } from "../src/main/otel/claude-code-otel-log-signals.js";
import {
  ClaudeCodeOtelMetricName,
  normalizeClaudeCodeOtelExport,
  OtlpAggregationTemporality,
} from "../src/main/otel/claude-code-otel-normalizer.js";
import {
  ClaudeCodeOtelSignalType,
  ClaudeCodeOtelTableName,
} from "../src/main/otel/claude-code-otel-signal-contract.js";
import { persistClaudeCodeOtelSignals } from "../src/main/otel/claude-code-persistence.js";
import {
  CONTENT_SENTINEL,
  type CounterPoint,
  claudeLogExportOf,
  encodeAttributes,
  encodeCounterPoints,
  encodeLogRecords,
  MODEL,
  NOW,
  type OtlpAttributeValue,
  openTestDatabase,
  postOtlp,
  SESSION_ID,
  type SqliteDb,
  seedSession,
  startWiredReceiver,
  unixNano,
} from "./helpers/claude-code-otel-fixtures.js";

const IDENTITY_AT = "2026-06-18T19:00:41.000Z";
const LATER_AT = "2026-06-18T19:00:43.000Z";
const METRIC_AT = "2026-06-18T19:00:45.000Z";
const ORGANIZATION_ID = "org_01HZYIDENTITY";
/** A SECOND organization, for the readings-that-disagree cases only. */
const OTHER_ORGANIZATION_ID = "org_01HZYOTHERORG";
const ACCOUNT_UUID = "4b9d2f10-0000-4000-8000-0000000000f1";
const ACCOUNT_ID = "acct_01HZYIDENTITY";
const IDENTITY_SOURCE = "oauth";
const TERMINAL_TYPE = "iTerm.app";
const APP_VERSION = "2.0.31";
const APP_ENTRYPOINT = "cli";
const UNCLAIMED_EVENT_NAME = "some_event_this_lane_does_not_claim";

test("ISS-7352 item F: an export's identifiers reach the session identity row", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([apiRequestRecord(IDENTITY_AT, fullIdentity())])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await identityRows(db);
    // ONE row for the session, not one per event: the grain is what separates
    // this half of item F from the four per-event join keys.
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.session_id, SESSION_ID);
    assert.equal(row?.observed_at, IDENTITY_AT);
    assert.equal(row?.organization_id, ORGANIZATION_ID);
    assert.equal(row?.user_account_uuid, ACCOUNT_UUID);
    assert.equal(row?.user_account_id, ACCOUNT_ID);
    assert.equal(row?.identity_source, IDENTITY_SOURCE);
    assert.equal(row?.terminal_type, TERMINAL_TYPE);
    assert.equal(row?.app_version, APP_VERSION);
    assert.equal(row?.app_entrypoint, APP_ENTRYPOINT);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item F: `user.email` and `user.groups` reach neither a signal nor a row", async () => {
  // The exclusion is a decision, not an oversight, so it needs a test that
  // fails the moment someone widens the read set to "every attribute on the
  // record". The sentinel rides on the SAME record as the identifiers, and the
  // identifier assertions below are what stop this passing by capturing
  // nothing at all.
  const record = apiRequestRecord(IDENTITY_AT, {
    ...fullIdentity(),
    "user.email": CONTENT_SENTINEL,
    "user.groups": CONTENT_SENTINEL,
  });

  const normalized = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(encodeLogRecords([record]))
  );
  assert.ok(
    !JSON.stringify(normalized.signals).includes(CONTENT_SENTINEL),
    "an excluded person-identifying attribute reached a normalized signal"
  );
  assert.equal(identitySignalsOf(normalized.signals).length, 1);

  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([record])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await identityRows(db);
    assert.equal(rows.length, 1);
    assert.ok(
      !JSON.stringify(rows).includes(CONTENT_SENTINEL),
      "an excluded person-identifying attribute reached the identity row"
    );
    // The counterfactual for the assertion above: the identifiers DID land, so
    // a reader cannot mistake "captured nothing" for "excluded the right thing".
    assert.equal(rows[0]?.organization_id, ORGANIZATION_ID);
    assert.equal(rows[0]?.user_account_uuid, ACCOUNT_UUID);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item F: a session that resolves no identifier gets NO row", async () => {
  // Absent stays absent. A row of NULLs here would be indistinguishable to a
  // reader from a session resolved to an empty account, and the measured gap
  // this lane exists to close is exactly the unattributed population — so an
  // unattributed session must stay countable as one.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([apiRequestRecord(IDENTITY_AT, {})])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    assert.equal((await identityRows(db)).length, 0);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item F: two readings of one session are UNIONed, not last-wins", () => {
  // `organization.id` is only stamped once a session has authenticated, so a
  // batch spanning a login carries a record without it and a later record with
  // it. Last-wins drops the account the first record resolved; first-wins drops
  // the organization the second resolved. Either way the dropped field is
  // afterwards indistinguishable from one the producer never stamped.
  const normalized = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        apiRequestRecord(IDENTITY_AT, {
          [ClaudeCodeOtelAttributeKey.UserAccountUuid]: ACCOUNT_UUID,
        }),
        apiRequestRecord(LATER_AT, {
          [ClaudeCodeOtelAttributeKey.OrganizationId]: ORGANIZATION_ID,
        }),
      ])
    )
  );

  const identities = identitySignalsOf(normalized.signals);
  assert.equal(identities.length, 1);
  const identity = identities[0];
  assert.equal(identity?.userAccountUuid, ACCOUNT_UUID);
  assert.equal(identity?.organizationId, ORGANIZATION_ID);
  // WITHIN one batch the merge takes the earlier instant, so the reduction is
  // order-independent. This pins the merge only; what the COLUMN holds across
  // separate exports is a different rule, owned by the DB case below.
  assert.equal(identity?.observedAt, IDENTITY_AT);
});

test("ISS-7352 item F: the metric path harvests identity too", async () => {
  // Identity rides on metric data points as well as log records, and the two
  // harvest sites are separate code. A log-only suite leaves the metric site
  // free to drop the identifiers while staying green.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCounterPoints(
          ClaudeCodeOtelMetricName.LinesOfCode,
          [identityCarryingPoint()],
          OtlpAggregationTemporality.Delta
        )
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await identityRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.organization_id, ORGANIZATION_ID);
    assert.equal(rows[0]?.observed_at, METRIC_AT);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item F: an unclaimed record contributes no identity", () => {
  // Identity is harvested only from records this lane CLAIMS. Harvesting from
  // an event no table records would write an identity row for a session nothing
  // else in the lane mentions — an account attributed to a session with no
  // observations under it.
  const normalized = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        {
          timeUnixNano: unixNano(IDENTITY_AT),
          attributes: encodeAttributes({
            [ClaudeCodeOtelAttributeKey.EventName]: UNCLAIMED_EVENT_NAME,
            [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
            ...fullIdentity(),
          }),
        },
      ])
    )
  );

  assert.equal(identitySignalsOf(normalized.signals).length, 0);
});

test("ISS-7352 item F: across SEPARATE exports the row UNIONs complementary identifiers", async () => {
  // The cross-export half of the merge, which the in-batch reduction cannot
  // stand in for: these arrive as two transactions, so the union has to be the
  // WRITE's rule, not the normalizer's. Each export carries identifiers the
  // other does not — the shape a session that authenticates mid-batch actually
  // produces — so an `update` clause that replaced the row wholesale, or one
  // that declined to fill a NULL column, would each lose half of this.
  //
  // The later instant is delivered FIRST, so the same case also pins
  // `observed_at` as first-ARRIVAL-wins: the second export's earlier instant
  // must not move it back. One batch carrying both records could not show that
  // — the in-batch merge takes the earlier of the two and would pass either way.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const first = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          apiRequestRecord(LATER_AT, {
            [ClaudeCodeOtelAttributeKey.UserAccountUuid]: ACCOUNT_UUID,
            [ClaudeCodeOtelAttributeKey.AppVersion]: APP_VERSION,
          }),
        ])
      );
      assert.equal(first.status, 200);
      await settled(1);

      const second = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          apiRequestRecord(IDENTITY_AT, {
            [ClaudeCodeOtelAttributeKey.OrganizationId]: ORGANIZATION_ID,
            [ClaudeCodeOtelAttributeKey.TerminalType]: TERMINAL_TYPE,
          }),
        ])
      );
      assert.equal(second.status, 200);
      await settled(2);
    } finally {
      await receiver.stop();
    }

    const rows = await identityRows(db);
    assert.equal(rows.length, 1);
    // Both exports' contributions survive in the one row.
    assert.equal(rows[0]?.user_account_uuid, ACCOUNT_UUID);
    assert.equal(rows[0]?.app_version, APP_VERSION);
    assert.equal(rows[0]?.organization_id, ORGANIZATION_ID);
    assert.equal(rows[0]?.terminal_type, TERMINAL_TYPE);
    // Nothing either export withheld was invented.
    assert.equal(rows[0]?.user_account_id, null);
    assert.equal(rows[0]?.identity_source, null);
    assert.equal(rows[0]?.app_entrypoint, null);
    assert.equal(rows[0]?.observed_at, LATER_AT);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item F: across exports a DISAGREEING identifier cannot rewrite the row", async () => {
  // The conflict half of the same rule (whitlockk/davetho on #7131). Two
  // populated readings of one field that disagree is not something the producer
  // reports — one account per session is the premise this table is built on —
  // so a stray later record must not silently re-attribute a session already
  // resolved. Fill-only makes the column stable once written.
  //
  // The second export also carries a field the first did not, and the
  // assertions below require THAT to land: the refusal is scoped to the
  // conflicting column, not to the whole later reading, so a write that
  // defended the row by ignoring later exports entirely fails here.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const first = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          apiRequestRecord(IDENTITY_AT, {
            [ClaudeCodeOtelAttributeKey.OrganizationId]: ORGANIZATION_ID,
          }),
        ])
      );
      assert.equal(first.status, 200);
      await settled(1);

      const second = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          apiRequestRecord(LATER_AT, {
            [ClaudeCodeOtelAttributeKey.OrganizationId]: OTHER_ORGANIZATION_ID,
            [ClaudeCodeOtelAttributeKey.UserAccountUuid]: ACCOUNT_UUID,
          }),
        ])
      );
      assert.equal(second.status, 200);
      await settled(2);
    } finally {
      await receiver.stop();
    }

    const rows = await identityRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.organization_id, ORGANIZATION_ID);
    assert.equal(rows[0]?.user_account_uuid, ACCOUNT_UUID);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item F: WITHIN a batch a disagreeing identifier does not win either", () => {
  // The in-batch statement of the rule the DB case above pins across exports.
  // The two must agree, or where a pair of readings happens to land — one
  // export or two — decides which account a session is attributed to.
  const normalized = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        apiRequestRecord(IDENTITY_AT, {
          [ClaudeCodeOtelAttributeKey.OrganizationId]: ORGANIZATION_ID,
        }),
        apiRequestRecord(LATER_AT, {
          [ClaudeCodeOtelAttributeKey.OrganizationId]: OTHER_ORGANIZATION_ID,
          [ClaudeCodeOtelAttributeKey.UserAccountUuid]: ACCOUNT_UUID,
        }),
      ])
    )
  );

  const identities = identitySignalsOf(normalized.signals);
  assert.equal(identities.length, 1);
  assert.equal(identities[0]?.organizationId, ORGANIZATION_ID);
  // Scoped to the conflicting field: the complementary one still merges.
  assert.equal(identities[0]?.userAccountUuid, ACCOUNT_UUID);
});

test("ISS-7352 item F: the db-host boundary REFUSES an identity with no identifier", async () => {
  // The producer declines to build such a signal, but the schema is the
  // boundary and a boundary that trusts one producer is not a boundary. An
  // all-NULL row is exactly what this table must never hold: a reader cannot
  // tell it from a session resolved to an empty account, which is the
  // unattributed population this lane exists to measure.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);

    const refused = await persistClaudeCodeOtelSignals(
      {
        prisma: db.prisma,
        events: [
          {
            type: ClaudeCodeOtelSignalType.SessionIdentity,
            sessionId: SESSION_ID,
            observedAt: IDENTITY_AT,
          },
        ],
      },
      { now: () => NOW }
    );

    assert.deepEqual(refused, { accepted: 0, rejected: 1 });
    assert.equal((await identityRows(db)).length, 0);

    // The counterfactual: the SAME signal with one identifier is admitted, so
    // the refusal above is the missing identifier and not the shape.
    const admitted = await persistClaudeCodeOtelSignals(
      {
        prisma: db.prisma,
        events: [
          {
            type: ClaudeCodeOtelSignalType.SessionIdentity,
            sessionId: SESSION_ID,
            observedAt: IDENTITY_AT,
            organizationId: ORGANIZATION_ID,
          },
        ],
      },
      { now: () => NOW }
    );

    assert.deepEqual(admitted, { accepted: 1, rejected: 0 });
    assert.equal((await identityRows(db)).length, 1);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item F: identity takes its instant from a zoned event.timestamp", () => {
  // The harvest derives its instant the way every other LOG-record signal
  // builder does, preferring the producer's stamped `event.timestamp` over the
  // record's `timeUnixNano`. Reading `timeUnixNano` directly would disagree with
  // the row the very same record writes in its own table, and would drop
  // identity capture entirely whenever that field fails to decode while the
  // stamped attribute is good.
  const normalized = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        apiRequestRecord(IDENTITY_AT, {
          ...fullIdentity(),
          [ClaudeCodeOtelAttributeKey.EventTimestamp]: LATER_AT,
        }),
      ])
    )
  );

  const identities = identitySignalsOf(normalized.signals);
  assert.equal(identities.length, 1);
  assert.equal(identities[0]?.observedAt, LATER_AT);
});

/** Every identifier item F reads, and nothing else. */
function fullIdentity(): Record<string, OtlpAttributeValue> {
  return {
    [ClaudeCodeOtelAttributeKey.OrganizationId]: ORGANIZATION_ID,
    [ClaudeCodeOtelAttributeKey.UserAccountUuid]: ACCOUNT_UUID,
    [ClaudeCodeOtelAttributeKey.UserAccountId]: ACCOUNT_ID,
    [ClaudeCodeOtelAttributeKey.IdentitySource]: IDENTITY_SOURCE,
    [ClaudeCodeOtelAttributeKey.TerminalType]: TERMINAL_TYPE,
    [ClaudeCodeOtelAttributeKey.AppVersion]: APP_VERSION,
    [ClaudeCodeOtelAttributeKey.AppEntrypoint]: APP_ENTRYPOINT,
  };
}

/** An `api_request` record at a chosen instant, carrying chosen attributes. */
function apiRequestRecord(
  at: string,
  extra: Record<string, OtlpAttributeValue>
) {
  return {
    timeUnixNano: unixNano(at),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.ApiRequest,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: at,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.CostUsd]: 1.25,
      [ClaudeCodeOtelAttributeKey.DurationMs]: 1000,
      ...extra,
    }),
  };
}

/** A lines-of-code delta point with the identifiers stamped on it. */
function identityCarryingPoint(): CounterPoint {
  return {
    value: 12,
    observedAt: METRIC_AT,
    attributes: {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: "added",
      ...fullIdentity(),
    },
  };
}

function identitySignalsOf(
  signals: ReturnType<typeof normalizeClaudeCodeOtelExport>["signals"]
) {
  return signals.filter(
    (signal) => signal.type === ClaudeCodeOtelSignalType.SessionIdentity
  );
}

/**
 * Read straight from the store rather than through the shared `selectRows`
 * helper: that one orders by `id`, and this is the one `claude_code_*` table
 * with no `id` column because a session has exactly one identity.
 */
function identityRows(db: SqliteDb): Promise<Record<string, unknown>[]> {
  return db.prisma.client.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM ${ClaudeCodeOtelTableName.SessionIdentity}`
  );
}
