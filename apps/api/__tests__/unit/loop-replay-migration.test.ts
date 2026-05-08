import { readFileSync } from "node:fs";
import path from "node:path";

describe("loop replay hardening migration", () => {
  it("contains universal event replay unique index and parent loop FK", () => {
    const migrationPath = path.resolve(
      import.meta.dirname,
      "../../../../packages/database/prisma/migrations/20260217143000_harden_loop_event_replay_and_parent_fk/migration.sql"
    );
    const sql = readFileSync(migrationPath, "utf-8");

    expect(sql).toContain('ADD COLUMN "event_source" TEXT NOT NULL');
    expect(sql).toContain('ADD COLUMN "event_id" TEXT NOT NULL');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "loop_events_loop_id_event_source_event_id_key"'
    );
    expect(sql).toContain('ADD CONSTRAINT "loops_parent_loop_id_fkey"');
    expect(sql).toContain(
      'FOREIGN KEY ("parent_loop_id") REFERENCES "loops"("id")'
    );
  });
});
