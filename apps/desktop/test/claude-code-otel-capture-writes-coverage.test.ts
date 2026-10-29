/**
 * ISS-8730 coverage for `claude-code-otel-capture-writes.ts` — the seven
 * UPSERT builders for ISS-7352 capture list C (MCP / auth / plugin
 * lifecycle), G (the approximated counters), and D's GA half (active time).
 *
 * Each case calls an operation directly against a real (temp SQLite) Prisma
 * client via `db.prisma.write`, then reads the row back with raw SQL — no
 * mocked client, so the assertions pin the ACTUAL upsert semantics: what
 * lands on CREATE, what happens to the detail columns on a second call that
 * shares the row's natural key, and how two records that differ only in a
 * derived-key input land as two rows.
 *
 * The wired-receiver suites (`claude-code-otel-counter-capture.test.ts`,
 * `claude-code-otel-active-time-capture.test.ts`) already prove the upstream
 * NORMALIZER sums delta points that share a key before they reach these
 * operations. This file is one layer down: it pins what the operation ITSELF
 * does if invoked twice on one key directly — which, per the file's own doc
 * comment, REPLACES rather than adds. That is current, deliberate behavior;
 * pinned here, not re-justified.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import { deterministicEventId } from "../src/main/database/deterministic-event-id.js";
import {
  createActiveTimeOperation,
  createAuthEventOperation,
  createLinesOfCodeOperation,
  createMcpServerConnectionOperation,
  createPluginEventOperation,
  createSessionStartOperation,
  createToolResultOperation,
} from "../src/main/otel/claude-code-otel-capture-writes.js";
import {
  type ClaudeCodeActiveTimeSignal,
  ClaudeCodeActivityType,
  type ClaudeCodeAuthEventSignal,
  type ClaudeCodeLinesOfCodeSignal,
  type ClaudeCodeMcpServerConnectionSignal,
  ClaudeCodeOtelSignalType,
  ClaudeCodeOtelTableName,
  type ClaudeCodePluginEventSignal,
  ClaudeCodePluginLifecycle,
  type ClaudeCodeSessionStartSignal,
  type ClaudeCodeToolResultSignal,
  mcpConnectionKeyOf,
  pluginKeyOf,
  toolResultKeyOf,
} from "../src/main/otel/claude-code-otel-signal-contract.js";
import {
  openTestDatabase,
  SESSION_ID,
  type SqliteDb,
  seedSession,
  selectRows,
} from "./helpers/claude-code-otel-fixtures.js";

const OBSERVED_AT = "2026-06-18T19:00:41.000Z";
const NOW = "2026-06-18T19:30:00.000Z";
const MODEL = "claude-sonnet-4-5";

async function withOtelDb(run: (db: SqliteDb) => Promise<void>): Promise<void> {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    await run(db);
  } finally {
    await cleanup();
  }
}

function mcpEvent(
  overrides: Partial<ClaudeCodeMcpServerConnectionSignal> = {}
): ClaudeCodeMcpServerConnectionSignal {
  return {
    type: ClaudeCodeOtelSignalType.McpServerConnection,
    sessionId: SESSION_ID,
    observedAt: OBSERVED_AT,
    status: "connected",
    ...overrides,
  };
}

function authEvent(
  overrides: Partial<ClaudeCodeAuthEventSignal> = {}
): ClaudeCodeAuthEventSignal {
  return {
    type: ClaudeCodeOtelSignalType.AuthEvent,
    sessionId: SESSION_ID,
    observedAt: OBSERVED_AT,
    action: "login",
    ...overrides,
  };
}

function pluginEvent(
  overrides: Partial<ClaudeCodePluginEventSignal> = {}
): ClaudeCodePluginEventSignal {
  return {
    type: ClaudeCodeOtelSignalType.PluginEvent,
    sessionId: SESSION_ID,
    observedAt: OBSERVED_AT,
    lifecycle: ClaudeCodePluginLifecycle.Loaded,
    ...overrides,
  };
}

function locEvent(
  overrides: Partial<ClaudeCodeLinesOfCodeSignal> = {}
): ClaudeCodeLinesOfCodeSignal {
  return {
    type: ClaudeCodeOtelSignalType.LinesOfCode,
    sessionId: SESSION_ID,
    model: MODEL,
    observedAt: OBSERVED_AT,
    changeType: "added",
    lineCount: 120,
    ...overrides,
  };
}

function sessionStartEvent(
  overrides: Partial<ClaudeCodeSessionStartSignal> = {}
): ClaudeCodeSessionStartSignal {
  return {
    type: ClaudeCodeOtelSignalType.SessionStart,
    sessionId: SESSION_ID,
    observedAt: OBSERVED_AT,
    startType: "resume",
    sessionCount: 1,
    ...overrides,
  };
}

function activeTimeEvent(
  overrides: Partial<ClaudeCodeActiveTimeSignal> = {}
): ClaudeCodeActiveTimeSignal {
  return {
    type: ClaudeCodeOtelSignalType.ActiveTime,
    sessionId: SESSION_ID,
    observedAt: OBSERVED_AT,
    activityType: ClaudeCodeActivityType.User,
    seconds: 12,
    ...overrides,
  };
}

function toolResultEvent(
  overrides: Partial<ClaudeCodeToolResultSignal> = {}
): ClaudeCodeToolResultSignal {
  return {
    type: ClaudeCodeOtelSignalType.ToolResult,
    sessionId: SESSION_ID,
    observedAt: OBSERVED_AT,
    toolName: "Bash",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createMcpServerConnectionOperation
// ---------------------------------------------------------------------------

test("createMcpServerConnectionOperation: a minimal event creates a row with an empty connection_key, null detail, and the deterministic id", async () => {
  await withOtelDb(async (db) => {
    const event = mcpEvent();
    await db.prisma.write((client) =>
      createMcpServerConnectionOperation(client, event, NOW)
    );

    const rows = await selectRows(
      db,
      ClaudeCodeOtelTableName.McpServerConnection
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.session_id, SESSION_ID);
    assert.equal(row?.observed_at, OBSERVED_AT);
    assert.equal(row?.status, "connected");
    assert.equal(row?.connection_key, "");
    assert.equal(row?.transport_type, null);
    assert.equal(row?.server_scope, null);
    assert.equal(row?.duration_ms, null);
    assert.equal(row?.error_code, null);
    assert.equal(row?.is_plugin, null);
    assert.equal(row?.plugin_id_hash, null);
    assert.equal(row?.data_revision, effectiveDataRevision());
    assert.equal(
      row?.id,
      deterministicEventId(
        SESSION_ID,
        ClaudeCodeOtelTableName.McpServerConnection,
        OBSERVED_AT,
        "connected",
        mcpConnectionKeyOf(event)
      )
    );
  });
});

test("createMcpServerConnectionOperation: every optional detail is written verbatim on create", async () => {
  await withOtelDb(async (db) => {
    const event = mcpEvent({
      transportType: "stdio",
      serverScope: "project",
      durationMs: 250,
      errorCode: "ECONNRESET",
      isPlugin: true,
      pluginIdHash: "hash-abc",
    });
    await db.prisma.write((client) =>
      createMcpServerConnectionOperation(client, event, NOW)
    );

    const rows = await selectRows(
      db,
      ClaudeCodeOtelTableName.McpServerConnection
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.connection_key, mcpConnectionKeyOf(event));
    assert.notEqual(row?.connection_key, "");
    assert.equal(row?.transport_type, "stdio");
    assert.equal(row?.server_scope, "project");
    assert.equal(Number(row?.duration_ms), 250);
    assert.equal(row?.error_code, "ECONNRESET");
    assert.equal(Number(row?.is_plugin), 1);
    assert.equal(row?.plugin_id_hash, "hash-abc");
  });
});

test("createMcpServerConnectionOperation: two attempts differing only in transport_type land as two rows", async () => {
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createMcpServerConnectionOperation(
        client,
        mcpEvent({ transportType: "stdio" }),
        NOW
      )
    );
    await db.prisma.write((client) =>
      createMcpServerConnectionOperation(
        client,
        mcpEvent({ transportType: "http" }),
        NOW
      )
    );

    const rows = await selectRows(
      db,
      ClaudeCodeOtelTableName.McpServerConnection
    );
    assert.equal(rows.length, 2);
  });
});

test("createMcpServerConnectionOperation: a second call on the same key REPLACES a non-key detail field, including nulling one it omits", async () => {
  // duration_ms is NOT part of connection_key (only transport_type,
  // server_scope, is_plugin, plugin_id_hash and error_code are), so both
  // calls below share one row. The update spreads the WHOLE detail object
  // with `?? null` every time, so a field set on the first call and omitted
  // on the second is nulled out rather than left alone.
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createMcpServerConnectionOperation(
        client,
        mcpEvent({ transportType: "stdio", durationMs: 100 }),
        NOW
      )
    );
    await db.prisma.write((client) =>
      createMcpServerConnectionOperation(
        client,
        mcpEvent({ transportType: "stdio" }),
        NOW
      )
    );

    const rows = await selectRows(
      db,
      ClaudeCodeOtelTableName.McpServerConnection
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.duration_ms, null);
  });
});

// ---------------------------------------------------------------------------
// createAuthEventOperation
// ---------------------------------------------------------------------------

test("createAuthEventOperation: a minimal event creates a row with an empty occurrence_key, null detail, and the deterministic id", async () => {
  await withOtelDb(async (db) => {
    const event = authEvent();
    await db.prisma.write((client) =>
      createAuthEventOperation(client, event, NOW)
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.AuthEvent);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.action, "login");
    assert.equal(row?.occurrence_key, "");
    assert.equal(row?.success, null);
    assert.equal(row?.auth_method, null);
    assert.equal(row?.error_category, null);
    assert.equal(row?.status_code, null);
    assert.equal(row?.data_revision, effectiveDataRevision());
  });
});

test("createAuthEventOperation: two logins differing only in auth_method land as two rows", async () => {
  // Every optional field is folded into occurrence_key, so a differing
  // auth_method is what separates them.
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createAuthEventOperation(client, authEvent({ authMethod: "oauth" }), NOW)
    );
    await db.prisma.write((client) =>
      createAuthEventOperation(
        client,
        authEvent({ authMethod: "api_key" }),
        NOW
      )
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.AuthEvent);
    assert.equal(rows.length, 2);
  });
});

test("createAuthEventOperation: a genuinely identical repeat upserts to ONE row under the same id", async () => {
  // Because occurrence_key folds in every optional field, an event equal in
  // every way it CAN vary produces one key both times — the collision this
  // table cannot even express is the re-delivered-batch case.
  await withOtelDb(async (db) => {
    const event = authEvent({ authMethod: "oauth", success: true });
    await db.prisma.write((client) =>
      createAuthEventOperation(client, event, NOW)
    );
    await db.prisma.write((client) =>
      createAuthEventOperation(client, event, NOW)
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.AuthEvent);
    assert.equal(rows.length, 1);
  });
});

// ---------------------------------------------------------------------------
// createPluginEventOperation
// ---------------------------------------------------------------------------

test("createPluginEventOperation: a minimal event creates a row with an empty plugin_key and the deterministic id", async () => {
  await withOtelDb(async (db) => {
    const event = pluginEvent();
    await db.prisma.write((client) =>
      createPluginEventOperation(client, event, NOW)
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.PluginEvent);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.lifecycle, ClaudeCodePluginLifecycle.Loaded);
    assert.equal(row?.plugin_key, "");
    assert.equal(row?.plugin_name, null);
    assert.equal(row?.install_trigger, null);
    assert.equal(
      row?.id,
      deterministicEventId(
        SESSION_ID,
        ClaudeCodeOtelTableName.PluginEvent,
        OBSERVED_AT,
        ClaudeCodePluginLifecycle.Loaded,
        pluginKeyOf(event)
      )
    );
  });
});

test("createPluginEventOperation: two plugins loaded at one instant land as two rows", async () => {
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createPluginEventOperation(
        client,
        pluginEvent({ pluginName: "alpha" }),
        NOW
      )
    );
    await db.prisma.write((client) =>
      createPluginEventOperation(
        client,
        pluginEvent({ pluginName: "beta" }),
        NOW
      )
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.PluginEvent);
    assert.equal(rows.length, 2);
  });
});

test("createPluginEventOperation: a second call on the same key REPLACES install_trigger, nulling it when omitted", async () => {
  // install_trigger is NOT part of plugin_key (only pluginName, pluginVersion
  // and marketplaceName are), so both calls below share one row.
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createPluginEventOperation(
        client,
        pluginEvent({ pluginName: "alpha", installTrigger: "startup" }),
        NOW
      )
    );
    await db.prisma.write((client) =>
      createPluginEventOperation(
        client,
        pluginEvent({ pluginName: "alpha" }),
        NOW
      )
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.PluginEvent);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.install_trigger, null);
  });
});

// ---------------------------------------------------------------------------
// createLinesOfCodeOperation
// ---------------------------------------------------------------------------

test("createLinesOfCodeOperation: a second call on the same key REPLACES line_count rather than summing it", async () => {
  // The comment on the source function is explicit that summing happens
  // upstream in the normalizer; the operation itself is a plain upsert.
  // Expected 40 here, not 160.
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createLinesOfCodeOperation(client, locEvent({ lineCount: 120 }), NOW)
    );
    await db.prisma.write((client) =>
      createLinesOfCodeOperation(client, locEvent({ lineCount: 40 }), NOW)
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.LinesOfCode);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.line_count), 40);
  });
});

test("createLinesOfCodeOperation: added and removed at one instant land as two rows", async () => {
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createLinesOfCodeOperation(client, locEvent({ changeType: "added" }), NOW)
    );
    await db.prisma.write((client) =>
      createLinesOfCodeOperation(
        client,
        locEvent({ changeType: "removed" }),
        NOW
      )
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.LinesOfCode);
    assert.equal(rows.length, 2);
  });
});

// ---------------------------------------------------------------------------
// createSessionStartOperation
// ---------------------------------------------------------------------------

test("createSessionStartOperation: a second call on the same key REPLACES session_count rather than summing it", async () => {
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createSessionStartOperation(
        client,
        sessionStartEvent({ sessionCount: 1 }),
        NOW
      )
    );
    await db.prisma.write((client) =>
      createSessionStartOperation(
        client,
        sessionStartEvent({ sessionCount: 2 }),
        NOW
      )
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.SessionStart);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.session_count), 2);
  });
});

test("createSessionStartOperation: a genuinely identical repeat upserts to ONE row under the same id", async () => {
  await withOtelDb(async (db) => {
    const event = sessionStartEvent();
    const firstId = await db.prisma.write(async (client) => {
      const written = await createSessionStartOperation(client, event, NOW);
      return written.id;
    });
    const secondId = await db.prisma.write(async (client) => {
      const written = await createSessionStartOperation(client, event, NOW);
      return written.id;
    });

    const rows = await selectRows(db, ClaudeCodeOtelTableName.SessionStart);
    assert.equal(rows.length, 1);
    assert.equal(firstId, secondId);
  });
});

// ---------------------------------------------------------------------------
// createActiveTimeOperation
// ---------------------------------------------------------------------------

test("createActiveTimeOperation: a sub-second seconds value is stored as its exact fraction", async () => {
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createActiveTimeOperation(client, activeTimeEvent({ seconds: 0.25 }), NOW)
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ActiveTime);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.seconds), 0.25);
  });
});

test("createActiveTimeOperation: a second call on the same key REPLACES seconds rather than summing it", async () => {
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createActiveTimeOperation(client, activeTimeEvent({ seconds: 12 }), NOW)
    );
    await db.prisma.write((client) =>
      createActiveTimeOperation(client, activeTimeEvent({ seconds: 30 }), NOW)
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ActiveTime);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.seconds), 30);
  });
});

test("createActiveTimeOperation: the user's time and the CLI's time at one instant land as two rows", async () => {
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createActiveTimeOperation(
        client,
        activeTimeEvent({ activityType: ClaudeCodeActivityType.User }),
        NOW
      )
    );
    await db.prisma.write((client) =>
      createActiveTimeOperation(
        client,
        activeTimeEvent({ activityType: ClaudeCodeActivityType.Cli }),
        NOW
      )
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ActiveTime);
    assert.equal(rows.length, 2);
  });
});

// ---------------------------------------------------------------------------
// createToolResultOperation
// ---------------------------------------------------------------------------

test("createToolResultOperation: a minimal event creates a row with an empty result_key, null detail, and the deterministic id", async () => {
  await withOtelDb(async (db) => {
    const event = toolResultEvent();
    await db.prisma.write((client) =>
      createToolResultOperation(client, event, NOW)
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ToolResult);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.tool_name, "Bash");
    assert.equal(row?.result_key, "");
    assert.equal(row?.tool_use_id, null);
    assert.equal(row?.success, null);
    assert.equal(row?.error_type, null);
    assert.equal(row?.tool_input_size_bytes, null);
    assert.equal(row?.tool_result_size_bytes, null);
    assert.equal(row?.mcp_server_scope, null);
    assert.equal(
      row?.id,
      deterministicEventId(
        SESSION_ID,
        ClaudeCodeOtelTableName.ToolResult,
        OBSERVED_AT,
        "Bash",
        toolResultKeyOf(event)
      )
    );
  });
});

test("createToolResultOperation: every optional detail is written verbatim on create", async () => {
  await withOtelDb(async (db) => {
    const event = toolResultEvent({
      toolUseId: "toolu_01AAA",
      success: false,
      errorType: "Error:ENOENT",
      toolInputSizeBytes: 512,
      toolResultSizeBytes: 4096,
      mcpServerScope: "project",
    });
    await db.prisma.write((client) =>
      createToolResultOperation(client, event, NOW)
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ToolResult);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.result_key, toolResultKeyOf(event));
    assert.notEqual(row?.result_key, "");
    assert.equal(row?.tool_use_id, "toolu_01AAA");
    assert.notEqual(row?.success, null);
    assert.equal(Number(row?.success), 0);
    assert.equal(row?.error_type, "Error:ENOENT");
    assert.equal(Number(row?.tool_input_size_bytes), 512);
    assert.equal(Number(row?.tool_result_size_bytes), 4096);
    assert.equal(row?.mcp_server_scope, "project");
  });
});

test("createToolResultOperation: two results in one millisecond stay separate rows per tool_use_id", async () => {
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createToolResultOperation(
        client,
        toolResultEvent({ toolUseId: "toolu_01AAA" }),
        NOW
      )
    );
    await db.prisma.write((client) =>
      createToolResultOperation(
        client,
        toolResultEvent({ toolUseId: "toolu_01BBB" }),
        NOW
      )
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ToolResult);
    assert.equal(rows.length, 2);
  });
});

test("createToolResultOperation: a second call on the same key REPLACES detail, nulling a field the second call omits", async () => {
  // success/error_type/toolInputSizeBytes are NOT part of result_key (only
  // tool_use_id is), so both calls below share one row.
  await withOtelDb(async (db) => {
    await db.prisma.write((client) =>
      createToolResultOperation(
        client,
        toolResultEvent({
          toolUseId: "toolu_01AAA",
          success: true,
          toolInputSizeBytes: 512,
        }),
        NOW
      )
    );
    await db.prisma.write((client) =>
      createToolResultOperation(
        client,
        toolResultEvent({
          toolUseId: "toolu_01AAA",
          success: false,
          errorType: "Error:ENOENT",
        }),
        NOW
      )
    );

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ToolResult);
    assert.equal(rows.length, 1);
    const row = rows[0];
    // `Number(null)` is 0, so the compare below passes on a NULL too. NULL and
    // false are the distinction the counter-signals contract turns on (a
    // refused/absent signal versus a recorded failure), so the replace path
    // needs this guard more than the create path, not less.
    assert.notEqual(row?.success, null);
    assert.equal(Number(row?.success), 0);
    assert.equal(row?.error_type, "Error:ENOENT");
    assert.equal(row?.tool_input_size_bytes, null);
  });
});
