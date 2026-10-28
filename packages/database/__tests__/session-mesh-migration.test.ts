import { describe, expect, it } from "vitest";
import {
  MAX_IDENTIFIER_LENGTH,
  migrationDdl,
  parseForeignKeys,
  scanCreateIndexStatements,
} from "./test-helpers/migration-index-ddl";

const MIGRATION = "20260926150000_add_session_mesh";
const expectedIndexes = [
  [
    "session_mesh_presences",
    ["organization_id", "repository", "expires_at"],
    false,
  ],
  ["session_mesh_presences", ["expires_at"], false],
  ["session_mesh_presences", ["organization_id", "agent_id"], true],
  [
    "session_mesh_messages",
    ["organization_id", "repository", "revision", "created_at"],
    false,
  ],
  ["session_mesh_messages", ["expires_at"], false],
  ["session_mesh_messages", ["organization_id", "created_at"], false],
  ["session_mesh_messages", ["organization_id", "idempotency_key"], true],
  [
    "session_mesh_deliveries",
    ["organization_id", "recipient_user_id", "recipient_agent_id", "status"],
    false,
  ],
  ["session_mesh_deliveries", ["message_id", "recipient_agent_id"], true],
  ["session_mesh_deliveries", ["organization_id", "queued_at"], false],
  ["session_mesh_metric_events", ["organization_id", "created_at"], false],
  ["session_mesh_metric_events", ["created_at"], false],
  ["session_mesh_metric_events", ["organization_id", "idempotency_key"], true],
  [
    "session_mesh_subscriptions",
    ["organization_id", "user_id", "repository"],
    true,
  ],
  [
    "session_mesh_subscriptions",
    ["organization_id", "user_id", "muted"],
    false,
  ],
  [
    "session_mesh_metric_events",
    ["organization_id", "event_type", "created_at"],
    false,
  ],
] as const;

describe("Session Mesh migration", () => {
  it("indexes the actual timestamp windows and first-reply join used by Insights", () => {
    const indexes = scanCreateIndexStatements(
      "20260926150100_add_session_mesh_reporting_indexes"
    );
    expect(indexes).toHaveLength(4);
    const accessPaths = [
      [
        "session_mesh_messages",
        ["organization_id", "reply_to_message_id", "created_at"],
      ],
      ["session_mesh_deliveries", ["organization_id", "attempted_at"]],
      ["session_mesh_deliveries", ["organization_id", "delivered_at"]],
      ["session_mesh_deliveries", ["organization_id", "acknowledged_at"]],
    ] as const;
    for (const [table, keys] of accessPaths) {
      expect(indexes).toContainEqual(
        expect.objectContaining({
          table,
          keys: [...keys],
          unique: false,
          predicate: null,
        })
      );
    }
    for (const index of indexes) {
      expect(index.name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
      expect(index.concurrently).toBe(true);
    }
  });

  it("indexes cross-branch discovery, expiry, idempotency, inbox ownership and reporting", () => {
    const indexes = scanCreateIndexStatements(MIGRATION);
    expect(indexes).toHaveLength(expectedIndexes.length);
    for (const [table, keys, unique] of expectedIndexes) {
      expect(indexes).toContainEqual(
        expect.objectContaining({
          table,
          keys: [...keys],
          unique,
          predicate: null,
        })
      );
    }
    for (const index of indexes) {
      expect(index.name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
      // These tables are created in this migration, so there are no live rows
      // whose writes would require an outside-transaction concurrent build.
      expect(index.concurrently).toBe(false);
    }
  });

  it("defines each owner/message foreign key and its deletion behavior", () => {
    const foreignKeys = parseForeignKeys(MIGRATION);
    const expected = [
      ["session_mesh_presences", "organization_id", "organizations", "CASCADE"],
      ["session_mesh_presences", "user_id", "users", "CASCADE"],
      ["session_mesh_messages", "organization_id", "organizations", "CASCADE"],
      ["session_mesh_messages", "author_user_id", "users", "CASCADE"],
      [
        "session_mesh_deliveries",
        "organization_id",
        "organizations",
        "CASCADE",
      ],
      [
        "session_mesh_deliveries",
        "message_id",
        "session_mesh_messages",
        "CASCADE",
      ],
      ["session_mesh_deliveries", "recipient_user_id", "users", "CASCADE"],
      [
        "session_mesh_metric_events",
        "organization_id",
        "organizations",
        "CASCADE",
      ],
      ["session_mesh_metric_events", "user_id", "users", "SET NULL"],
      [
        "session_mesh_subscriptions",
        "organization_id",
        "organizations",
        "CASCADE",
      ],
      ["session_mesh_subscriptions", "user_id", "users", "CASCADE"],
    ];
    expect(foreignKeys).toHaveLength(expected.length);
    for (const [table, column, referencedTable, onDelete] of expected) {
      expect(foreignKeys).toContainEqual(
        expect.objectContaining({
          table,
          columns: `"${column}"`,
          referencedTable,
          referencedColumns: '"id"',
          actions: `ON DELETE ${onDelete} ON UPDATE CASCADE`,
        })
      );
    }
  });

  it("does not count a newly queued delivery as delivered", () => {
    const deliveryTable = migrationDdl(MIGRATION)
      .split(";")
      .find((statement) =>
        statement.includes('CREATE TABLE "session_mesh_deliveries"')
      );
    expect(deliveryTable).toBeDefined();
    const columns = deliveryTable?.split("\n").map((line) => line.trim());
    expect(columns).toContain(
      '"queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,'
    );
    expect(columns).toContain('"delivered_at" TIMESTAMP(3),');
    expect(columns).toContain('"acknowledged_at" TIMESTAMP(3),');
    expect(columns).toContain("\"status\" TEXT NOT NULL DEFAULT 'queued',");
  });
});
