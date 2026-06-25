import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  import.meta.dirname,
  "../../../../packages/database/prisma/migrations/20260616015358_add_session_trace_detail/migration.sql"
);
const sourceMigrationPath = path.resolve(
  import.meta.dirname,
  "../../../../packages/database/prisma/migrations/20260617020000_add_session_trace_sources/migration.sql"
);
const schemaPath = path.resolve(
  import.meta.dirname,
  "../../../../packages/database/prisma/schema.prisma"
);

const destructiveSqlPattern =
  /\b(DROP|DELETE|TRUNCATE|RENAME|ALTER\s+COLUMN|SET\s+NOT\s+NULL|CREATE\s+(?:UNIQUE\s+)?INDEX)\b/i;

const expectedNullableColumns = [
  "active_agent",
  "activity_buckets",
  "autonomy",
  "branch",
  "files_changed",
  "issues",
  "lines_added",
  "lines_removed",
  "markers",
  "phase_iterations",
  "phase_loopbacks",
  "phases",
  "pull_requests",
  "session_span",
  "state",
  "steering_episodes",
  "throttles",
  "turns",
  "waiting_user",
  "wall_clock",
] as const;

/**
 * Regression coverage for the FEA-1771 additive Session Trace detail migration.
 */
describe("session trace detail migration", () => {
  it("adds only nullable session_detail columns without destructive DDL", () => {
    const sql = readFileSync(migrationPath, "utf-8");

    expect(sql).toContain('ALTER TABLE "session_detail" ADD COLUMN');
    expect(sql).not.toMatch(destructiveSqlPattern);
    for (const column of expectedNullableColumns) {
      expect(sql).toContain(`"${column}"`);
      expect(sql).not.toContain(`"${column}" TEXT NOT NULL`);
      expect(sql).not.toContain(`"${column}" INTEGER NOT NULL`);
      expect(sql).not.toContain(`"${column}" JSONB NOT NULL`);
    }
  });

  it("preserves FEA-1718 origin and keeps manual state nullable", () => {
    const schema = readFileSync(schemaPath, "utf-8");

    expect(schema).toContain("enum SessionOrigin");
    expect(schema).toContain(
      "origin             SessionOrigin @default(DESKTOP_SYNC)"
    );
    expect(schema).toContain("state              String?");
    expect(schema).toContain(
      'activityBuckets    Json?         @map("activity_buckets")'
    );
    expect(schema).toContain(
      'phaseLoopbacks     Json?         @map("phase_loopbacks")'
    );
  });
});

describe("session trace source migration", () => {
  it("adds nullable bounded-source columns without destructive DDL", () => {
    const sql = readFileSync(sourceMigrationPath, "utf-8");

    expect(sql).toContain('ALTER TABLE "session_detail"');
    expect(sql).not.toMatch(destructiveSqlPattern);
    for (const column of [
      "trace_phase_sources",
      "throttle_sources",
      "correction_sources",
    ]) {
      expect(sql).toContain(`"${column}" JSONB`);
      expect(sql).not.toContain(`"${column}" JSONB NOT NULL`);
    }
  });
});
