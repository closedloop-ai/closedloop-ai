/**
 * ISS-7352 capture list C — MCP / auth / plugin lifecycle.
 *
 * The DB-level cases drive the WIRED receiver, so each one proves the
 * production path — receiver, normalizer, db facade, persister — and not just
 * the unit under it. The normalizer-level cases assert the `unusable` count,
 * which the DB cannot show.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeCodeOtelAttributeKey } from "../src/main/otel/claude-code-otel-attributes.js";
import { ClaudeCodeAttributionAttributeKey } from "../src/main/otel/claude-code-otel-attribution.js";
import { ClaudeCodeOtelEventName } from "../src/main/otel/claude-code-otel-log-signals.js";
import { normalizeClaudeCodeOtelExport } from "../src/main/otel/claude-code-otel-normalizer.js";
import {
  ClaudeCodeOtelSignalType,
  ClaudeCodeOtelTableName,
  ClaudeCodePluginLifecycle,
} from "../src/main/otel/claude-code-otel-signal-contract.js";
import {
  CONTENT_SENTINEL,
  claudeLogExportOf,
  encodeAttributes,
  encodeLogRecords,
  type OtlpAttributeValue,
  openTestDatabase,
  postOtlp,
  SESSION_ID,
  seedSession,
  selectRows,
  startWiredReceiver,
  unixNano,
} from "./helpers/claude-code-otel-fixtures.js";

const MCP_AT = "2026-06-18T19:00:21.000Z";
const AUTH_AT = "2026-06-18T19:00:23.000Z";
const PLUGIN_AT = "2026-06-18T19:00:25.000Z";
const PLUGIN_ID_HASH = "0f3a1c";
const OTHER_PLUGIN_ID_HASH = "9b7d20";
const MARKETPLACE = "closedloop-ai";

test("ISS-7352 item C: an mcp_server_connection is captured with its whole taxonomy", async () => {
  // Nothing we collect otherwise records which MCP servers a session reached,
  // over what transport, or why one failed — a transcript only shows the tool
  // calls that succeeded afterwards. Expected from the requirement: one row
  // carrying every attribute the capture list names.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          mcpConnectionRecord({
            [ClaudeCodeOtelAttributeKey.Status]: "failed",
            [ClaudeCodeOtelAttributeKey.TransportType]: "stdio",
            [ClaudeCodeOtelAttributeKey.ServerScope]: "project",
            [ClaudeCodeOtelAttributeKey.DurationMs]: 512,
            [ClaudeCodeOtelAttributeKey.ErrorCode]: "ECONNREFUSED",
            [ClaudeCodeOtelAttributeKey.IsPlugin]: true,
            [ClaudeCodeOtelAttributeKey.PluginIdHash]: PLUGIN_ID_HASH,
          }),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(
      db,
      ClaudeCodeOtelTableName.McpServerConnection
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.session_id, SESSION_ID);
    assert.equal(row?.observed_at, MCP_AT);
    assert.equal(row?.status, "failed");
    assert.equal(row?.transport_type, "stdio");
    assert.equal(row?.server_scope, "project");
    assert.equal(Number(row?.duration_ms), 512);
    assert.equal(row?.error_code, "ECONNREFUSED");
    assert.equal(Number(row?.is_plugin), 1);
    assert.equal(row?.plugin_id_hash, PLUGIN_ID_HASH);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item C: two plugin-provided MCP servers connecting in one millisecond stay separate rows", async () => {
  // The counterfactual for putting `connection_key` in the natural key. Both
  // records agree on session, instant and status and differ only in WHICH
  // plugin provided the server. Keyed on (session, observed_at, status) alone
  // they are one row, and the persister's upsert REPLACES — the second server's
  // connection silently erases the first's. Expected: two rows, one per hash.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          mcpConnectionRecord({
            [ClaudeCodeOtelAttributeKey.Status]: "connected",
            [ClaudeCodeOtelAttributeKey.IsPlugin]: true,
            [ClaudeCodeOtelAttributeKey.PluginIdHash]: PLUGIN_ID_HASH,
          }),
          mcpConnectionRecord({
            [ClaudeCodeOtelAttributeKey.Status]: "connected",
            [ClaudeCodeOtelAttributeKey.IsPlugin]: true,
            [ClaudeCodeOtelAttributeKey.PluginIdHash]: OTHER_PLUGIN_ID_HASH,
          }),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(
      db,
      ClaudeCodeOtelTableName.McpServerConnection
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.plugin_id_hash).sort(),
      [PLUGIN_ID_HASH, OTHER_PLUGIN_ID_HASH].sort()
    );
    assert.notEqual(rows[0]?.id, rows[1]?.id);
    // Two DIFFERENT connections, so neither may have been folded into the other.
    for (const row of rows) {
      assert.notEqual(row.connection_key, "");
    }
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item C: a plugin-backed and a plain connection stay separate when no plugin_id_hash is stamped", async () => {
  // The counterfactual for `is_plugin` being in `connection_key`. The hash is
  // stamped only for a plugin-provided server, so with it absent these two
  // records agree on session, instant, status and transport and differ ONLY in
  // `is_plugin` — which the row STORES. Keyed without it they are one row: the
  // second is counted unusable in-batch, and a later batch overwrites the
  // survivor through the upsert (whitlockk, ISS-7352 review). Expected: two rows,
  // one plugin-backed and one not, under different connection keys.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          mcpConnectionRecord({
            [ClaudeCodeOtelAttributeKey.Status]: "connected",
            [ClaudeCodeOtelAttributeKey.TransportType]: "stdio",
            [ClaudeCodeOtelAttributeKey.IsPlugin]: true,
          }),
          mcpConnectionRecord({
            [ClaudeCodeOtelAttributeKey.Status]: "connected",
            [ClaudeCodeOtelAttributeKey.TransportType]: "stdio",
            [ClaudeCodeOtelAttributeKey.IsPlugin]: false,
          }),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(
      db,
      ClaudeCodeOtelTableName.McpServerConnection
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => Number(row.is_plugin)).sort(), [0, 1]);
    // Neither may carry the other's hash, and neither was folded into the other.
    for (const row of rows) {
      assert.equal(row.plugin_id_hash, null);
    }
    assert.notEqual(rows[0]?.connection_key, rows[1]?.connection_key);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item C: two connections colliding on the key with different durations refuse the second", () => {
  // Unlike a delta counter, a connection row is the record of ONE attempt:
  // two 512 ms connections are not one 1024 ms connection, so there is no
  // honest merge. The first record is kept unchanged, the differing second is
  // REFUSED and counted — without which the upsert's update clause would
  // silently overwrite the first attempt's duration.
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        mcpConnectionRecord({
          [ClaudeCodeOtelAttributeKey.Status]: "connected",
          [ClaudeCodeOtelAttributeKey.TransportType]: "stdio",
          [ClaudeCodeOtelAttributeKey.DurationMs]: 512,
        }),
        mcpConnectionRecord({
          [ClaudeCodeOtelAttributeKey.Status]: "connected",
          [ClaudeCodeOtelAttributeKey.TransportType]: "stdio",
          [ClaudeCodeOtelAttributeKey.DurationMs]: 1024,
        }),
      ])
    )
  );
  assert.equal(result.signals.length, 1);
  assert.equal(result.unusable, 1);
  const [signal] = result.signals;
  assert.equal(signal?.type, ClaudeCodeOtelSignalType.McpServerConnection);
  assert.equal(
    signal?.type === ClaudeCodeOtelSignalType.McpServerConnection
      ? signal.durationMs
      : undefined,
    512
  );
});

test("ISS-7352 item C: two plugin records colliding on the key with different triggers refuse the second", () => {
  // `plugin_key` covers name, version and marketplace, so a collision means two
  // records about the SAME plugin at the same instant that disagree about HOW
  // it got there. That is two facts, and without the refusal the upsert's
  // update clause silently rewrites the first record's trigger with the
  // second's.
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        pluginRecord(ClaudeCodeOtelEventName.PluginInstalled, {
          [ClaudeCodeAttributionAttributeKey.PluginName]: "design-pack",
          [ClaudeCodeOtelAttributeKey.InstallTrigger]: "cli",
        }),
        pluginRecord(ClaudeCodeOtelEventName.PluginInstalled, {
          [ClaudeCodeAttributionAttributeKey.PluginName]: "design-pack",
          [ClaudeCodeOtelAttributeKey.InstallTrigger]: "ui",
        }),
      ])
    )
  );
  assert.equal(result.signals.length, 1);
  assert.equal(result.unusable, 1);
  const [signal] = result.signals;
  assert.equal(
    signal?.type === ClaudeCodeOtelSignalType.PluginEvent
      ? signal.installTrigger
      : undefined,
    "cli"
  );
});

test("ISS-7352 item C: plugins the producer REDACTED to one name are truncated LOUDLY, not silently", () => {
  // Claude Code replaces `plugin.name` with the literal "third-party" (or
  // omits it) on third-party marketplaces unless `OTEL_LOG_TOOL_DETAILS=1`,
  // and `createClaudeCodeShellEnvProvider` never sets that flag — so this is
  // the DEFAULT shape, not an edge case. Three distinct plugins then produce
  // three byte-identical records that collapse onto one `plugin_key`.
  //
  // Only one row can survive; nothing captured can tell them apart. What must
  // NOT happen is the table reporting one plugin while `unusable` reports zero
  // problems, which is a truncated inventory that looks complete.
  const record = pluginRecord(ClaudeCodeOtelEventName.PluginLoaded, {
    [ClaudeCodeAttributionAttributeKey.PluginName]: "third-party",
    [ClaudeCodeAttributionAttributeKey.MarketplaceName]: MARKETPLACE,
  });
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(encodeLogRecords([record, record, record]))
  );
  assert.equal(result.signals.length, 1);
  assert.equal(result.unusable, 2);
});

test("ISS-7352 item C: identical MCP connections are counted too, for the same redaction reason", () => {
  // `server_name` is stamped under the same `OTEL_LOG_TOOL_DETAILS` flag and
  // the capture list does not claim it, so two different MCP servers reaching
  // one instant over one transport are indistinguishable from one server
  // reported twice. The sibling guards on `api_request` and `error_event` may
  // collapse an identical repeat silently because their keys carry a producer
  // identifier that is never redacted; these two may not.
  const record = mcpConnectionRecord({
    [ClaudeCodeOtelAttributeKey.Status]: "connected",
    [ClaudeCodeOtelAttributeKey.TransportType]: "stdio",
    [ClaudeCodeOtelAttributeKey.DurationMs]: 512,
  });
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(encodeLogRecords([record, record]))
  );
  assert.equal(result.signals.length, 1);
  assert.equal(result.unusable, 1);
});

test("ISS-7352 item C: a boolean attribute with no reading fails its whole record", () => {
  // `readBoolean` accepts a real boolean, "true"/"false", and 1/0 — an
  // int-encoded predicate has exactly one reading. `"yes"` has none, and these
  // flags are what SAY whether a server came from a plugin and whether a
  // marketplace is official; collapsing an unreadable one onto "the producer
  // said nothing" would store a real-looking row whose flag is silently
  // missing. Both C records that carry a boolean are covered, so neither
  // builder can regress alone.
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        mcpConnectionRecord({
          [ClaudeCodeOtelAttributeKey.Status]: "connected",
          [ClaudeCodeOtelAttributeKey.IsPlugin]: "yes",
        }),
        pluginRecord(ClaudeCodeOtelEventName.PluginLoaded, {
          [ClaudeCodeAttributionAttributeKey.PluginName]: "design-pack",
          [ClaudeCodeOtelAttributeKey.MarketplaceIsOfficial]: "yes",
        }),
        authRecord({
          [ClaudeCodeOtelAttributeKey.Action]: "login",
          [ClaudeCodeOtelAttributeKey.Success]: "yes",
        }),
      ])
    )
  );
  assert.equal(result.signals.length, 0);
  assert.equal(result.unusable, 3);
});

test("ISS-7352 item C: the same three records with a readable boolean ARE captured", () => {
  // The positive sibling of the refusal above, on the same three derivations —
  // so that refusal cannot be passing because these records never parse. `0`
  // is deliberately the spelling used: an int-encoded predicate must READ, not
  // be refused as a spelling.
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        mcpConnectionRecord({
          [ClaudeCodeOtelAttributeKey.Status]: "connected",
          [ClaudeCodeOtelAttributeKey.IsPlugin]: 0,
        }),
        pluginRecord(ClaudeCodeOtelEventName.PluginLoaded, {
          [ClaudeCodeAttributionAttributeKey.PluginName]: "design-pack",
          [ClaudeCodeOtelAttributeKey.MarketplaceIsOfficial]: 0,
        }),
        authRecord({
          [ClaudeCodeOtelAttributeKey.Action]: "login",
          [ClaudeCodeOtelAttributeKey.Success]: 0,
        }),
      ])
    )
  );
  assert.equal(result.signals.length, 3);
  assert.equal(result.unusable, 0);
  for (const signal of result.signals) {
    const flag =
      (signal.type === ClaudeCodeOtelSignalType.McpServerConnection &&
        signal.isPlugin) ||
      (signal.type === ClaudeCodeOtelSignalType.PluginEvent &&
        signal.marketplaceIsOfficial) ||
      (signal.type === ClaudeCodeOtelSignalType.AuthEvent && signal.success);
    assert.equal(flag, false);
  }
});

test("ISS-7352 item C: an auth failure records success=false rather than dropping the record", async () => {
  // `success` arrives as the STRING "false" — the producer documents it that
  // way. Read as a bare truthy value it would store `true` and invert the whole
  // meaning of the row; refused outright it would lose the failed login. Both
  // are worse than the third option, which is what this asserts.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          authRecord({
            [ClaudeCodeOtelAttributeKey.Action]: "login",
            [ClaudeCodeOtelAttributeKey.Success]: "false",
            [ClaudeCodeOtelAttributeKey.AuthMethod]: "oauth",
            [ClaudeCodeOtelAttributeKey.ErrorCategory]: "invalid_grant",
            [ClaudeCodeOtelAttributeKey.StatusCode]: "401",
          }),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.AuthEvent);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.action, "login");
    // NOT `Number(row.success) === 0`: `Number(null)` is also 0, so that
    // assertion passes on a row whose `success` was never recorded — which is
    // precisely the failure this case exists to catch.
    assert.notEqual(row?.success, null);
    assert.equal(Number(row?.success), 0);
    assert.equal(row?.auth_method, "oauth");
    assert.equal(row?.error_category, "invalid_grant");
    // Stamped as a STRING by the producer and stored as the integer it names.
    assert.equal(Number(row?.status_code), 401);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item C: two auth events at one instant stay separate rows per occurrence_key", async () => {
  // The only thing that tells two auth events at one instant apart is
  // `occurrence_key`, and the collision guard for this table is deliberately
  // `() => false` on the grounds that every attribute an auth event carries is
  // already folded into that key. That justification is load-bearing ON the key
  // being complete: degrade it and a failed oauth login followed by a failed
  // api-key attempt in the same millisecond reduce to one row, with the second
  // dropped and nothing reported.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          authRecord({
            [ClaudeCodeOtelAttributeKey.Action]: "login",
            [ClaudeCodeOtelAttributeKey.Success]: "false",
            [ClaudeCodeOtelAttributeKey.AuthMethod]: "oauth",
          }),
          authRecord({
            [ClaudeCodeOtelAttributeKey.Action]: "login",
            [ClaudeCodeOtelAttributeKey.Success]: "false",
            [ClaudeCodeOtelAttributeKey.AuthMethod]: "api_key",
          }),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.AuthEvent);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.auth_method).sort(), [
      "api_key",
      "oauth",
    ]);
    // The key must actually be carrying the distinction, not just the two rows
    // having landed on different ids by luck.
    for (const row of rows) {
      assert.notEqual(row.occurrence_key, "");
    }
    assert.notEqual(rows[0]?.occurrence_key, rows[1]?.occurrence_key);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item C: an out-of-range auth status_code fails the WHOLE record", () => {
  // A row is valid-or-absent, never partially-corrupt. Storing the rest of an
  // auth event whose status read 99999 would put a real-looking login row in
  // the table with one field silently dropped, and no reader could tell.
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        authRecord({
          [ClaudeCodeOtelAttributeKey.Action]: "login",
          [ClaudeCodeOtelAttributeKey.StatusCode]: 99_999,
        }),
      ])
    )
  );
  assert.equal(result.signals.length, 0);
  assert.equal(result.unusable, 1);
});

test("ISS-7352 item C: an auth event with a valid status_code IS captured", () => {
  // The positive sibling of the refusal above, on the same derivation — so the
  // refusal cannot be passing because auth events are never captured at all.
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        authRecord({
          [ClaudeCodeOtelAttributeKey.Action]: "login",
          [ClaudeCodeOtelAttributeKey.StatusCode]: 401,
        }),
      ])
    )
  );
  assert.equal(result.signals.length, 1);
  assert.equal(result.unusable, 0);
  assert.equal(result.signals[0]?.type, ClaudeCodeOtelSignalType.AuthEvent);
});

test("ISS-7352 item C: every plugin loaded at session start gets its own row", async () => {
  // `plugin_loaded` fires once per enabled plugin at session start, so a fleet
  // with three plugins emits three records agreeing on session and instant and
  // differing ONLY in the plugin they name. Without `plugin_key` in the natural
  // key the upsert keeps exactly one of them and the inventory silently reports
  // one plugin. Expected from the requirement: three rows.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords(
          ["design-pack", "logical-pack", "review-pack"].map((name) =>
            pluginRecord(ClaudeCodeOtelEventName.PluginLoaded, {
              [ClaudeCodeAttributionAttributeKey.PluginName]: name,
              [ClaudeCodeOtelAttributeKey.PluginVersion]: "1.2.0",
              [ClaudeCodeAttributionAttributeKey.MarketplaceName]: MARKETPLACE,
              [ClaudeCodeOtelAttributeKey.MarketplaceIsOfficial]: "false",
            })
          )
        )
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.PluginEvent);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.plugin_name).sort(), [
      "design-pack",
      "logical-pack",
      "review-pack",
    ]);
    for (const row of rows) {
      assert.equal(row.lifecycle, ClaudeCodePluginLifecycle.Loaded);
      assert.equal(row.plugin_version, "1.2.0");
      // Guarded against NULL before the numeric compare — `Number(null)` is 0,
      // so the compare alone cannot tell "the harness said false" from "we
      // never recorded it".
      assert.notEqual(row.marketplace_is_official, null);
      assert.equal(Number(row.marketplace_is_official), 0);
      assert.equal(row.marketplace_name, MARKETPLACE);
    }
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item C: an install and a load of the same plugin are two rows, not one", async () => {
  // The lifecycle discriminant comes from the event NAME, not an attribute, so
  // the two moments cannot be conflated. They are different facts — an install
  // happens once, a load happens at every session start — and a table that kept
  // only one of them could not answer either question.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          pluginRecord(ClaudeCodeOtelEventName.PluginInstalled, {
            [ClaudeCodeAttributionAttributeKey.PluginName]: "design-pack",
            [ClaudeCodeOtelAttributeKey.InstallTrigger]: "cli",
          }),
          pluginRecord(ClaudeCodeOtelEventName.PluginLoaded, {
            [ClaudeCodeAttributionAttributeKey.PluginName]: "design-pack",
          }),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.PluginEvent);
    assert.equal(rows.length, 2);
    const byLifecycle = new Map(
      rows.map((row) => [row.lifecycle as string, row])
    );
    assert.equal(
      byLifecycle.get(ClaudeCodePluginLifecycle.Installed)?.install_trigger,
      "cli"
    );
    // `install.trigger` is only stamped on the install, so the load row must
    // carry NULL rather than inheriting the sibling's value.
    assert.equal(
      byLifecycle.get(ClaudeCodePluginLifecycle.Loaded)?.install_trigger,
      null
    );
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item C: no content-bearing attribute reaches a lifecycle signal", () => {
  // `error` on `mcp_server_connection` is a full error MESSAGE, stamped under
  // `OTEL_LOG_TOOL_DETAILS=1`. Open question #4 leaves the content-capture
  // decision unanswered with the redaction gates closed, so it is not in the
  // read set — and neither is anything else the producer may co-stamp.
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        mcpConnectionRecord({
          [ClaudeCodeOtelAttributeKey.Status]: "failed",
          error: CONTENT_SENTINEL,
          server_name: CONTENT_SENTINEL,
          prompt: CONTENT_SENTINEL,
          "user.email": CONTENT_SENTINEL,
        }),
        authRecord({
          [ClaudeCodeOtelAttributeKey.Action]: "login",
          error: CONTENT_SENTINEL,
          "user.email": CONTENT_SENTINEL,
        }),
      ])
    )
  );
  assert.equal(result.signals.length, 2);
  const serialized = JSON.stringify(result.signals);
  assert.ok(
    !serialized.includes(CONTENT_SENTINEL),
    `a content-bearing attribute reached a normalized signal: ${serialized}`
  );
});

function mcpConnectionRecord(
  attributes: Record<string, OtlpAttributeValue>
): object {
  return {
    timeUnixNano: unixNano(MCP_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.McpServerConnection,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      ...attributes,
    }),
  };
}

function authRecord(attributes: Record<string, OtlpAttributeValue>): object {
  return {
    timeUnixNano: unixNano(AUTH_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]: ClaudeCodeOtelEventName.Auth,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      ...attributes,
    }),
  };
}

function pluginRecord(
  eventName: string,
  attributes: Record<string, OtlpAttributeValue>
): object {
  return {
    timeUnixNano: unixNano(PLUGIN_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]: eventName,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      ...attributes,
    }),
  };
}
