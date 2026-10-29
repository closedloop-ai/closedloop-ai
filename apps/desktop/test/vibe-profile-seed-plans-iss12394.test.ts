import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedPlans } from "../scripts/vibe-profile/seed-plans";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-01T11:00:00.000Z";

let dir: string;
let db: SqliteDb;

async function insertSession(id: string, name: string | null): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode, name)
     VALUES ($1, 'inactive', $2, $2, 'codex', 'api', $3)`,
    id,
    T0,
    name
  );
}

let eventSeq = 0;
async function insertPlanEvent(
  sessionId: string,
  createdAt: string | null,
  data: unknown
): Promise<void> {
  eventSeq += 1;
  await db.run(
    `INSERT INTO events (id, session_id, event_type, tool_name, data, created_at)
     VALUES ($1, $2, 'tool_use', 'update_plan', $3, $4)`,
    `evt-${eventSeq}`,
    sessionId,
    data === null ? null : JSON.stringify(data),
    createdAt
  );
}

function planFile(sessionId: string): string {
  return path.join(dir, "claude", "plans", `${sessionId}.md`);
}

async function versionCount(sessionId: string): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ n: number | bigint }[]>(
    `SELECT COUNT(*) AS n FROM plan_versions v JOIN plans p ON p.id = v.plan_id
      WHERE p.file_path = $1`,
    planFile(sessionId)
  );
  return Number(rows[0]?.n ?? 0);
}

describe("seedPlans", () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "vibe-seed-plans-"));
    db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "api",
      now: () => T1,
    });
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the last snapshot over a moved plan and re-upserts it as a second version", async () => {
    await insertSession("s-moved", "  Refactor auth  ");
    await insertPlanEvent("s-moved", T0, {
      tool_input: {
        explanation: "Start here",
        plan: [{ step: "Read code", status: "pending" }],
      },
    });
    await insertPlanEvent("s-moved", T1, {
      tool_input: { plan: [{ step: "Read code", status: "completed" }] },
    });

    const result = await seedPlans(db, path.join(dir, "claude"));

    expect(result).toEqual({ plans: 1, revised: 1 });
    expect(await readFile(planFile("s-moved"), "utf8")).toBe(
      "# Refactor auth\n\n## Steps\n\n- [x] Read code\n"
    );
    expect(await versionCount("s-moved")).toBe(2);
  });

  it("skips null and malformed events, titles unnamed sessions by id, and does not revise an unchanged plan", async () => {
    await insertSession("s-null-name", null);
    await insertSession("s-blank-name", "   ");
    await insertSession("s-junk", "Junk");
    await insertPlanEvent("s-null-name", T0, {
      tool_input: {
        explanation: "",
        plan: [{ step: "Ship", status: "in_progress" }],
      },
    });
    await insertPlanEvent("s-null-name", T1, {
      tool_input: { plan: [{ step: "Ship", status: "in_progress" }] },
    });
    await insertPlanEvent("s-blank-name", T0, {
      tool_input: {
        explanation: "Why",
        plan: [{ step: "Test", status: "completed" }],
      },
    });
    await insertPlanEvent("s-junk", T0, null);
    await insertPlanEvent("s-junk", T0, { tool_input: { plan: [] } });
    await insertPlanEvent("s-junk", null, {
      tool_input: { plan: [{ step: "Never", status: "pending" }] },
    });

    const result = await seedPlans(db, path.join(dir, "claude"));

    expect(result).toEqual({ plans: 2, revised: 0 });
    expect(await readFile(planFile("s-null-name"), "utf8")).toBe(
      "# Plan for session s-null-name\n\n## Steps\n\n- [ ] Ship\n"
    );
    expect(await readFile(planFile("s-blank-name"), "utf8")).toBe(
      "# Plan for session s-blank-name\n\nWhy\n\n## Steps\n\n- [x] Test\n"
    );
    await expect(readFile(planFile("s-junk"), "utf8")).rejects.toThrow();
    expect(await versionCount("s-null-name")).toBe(1);
  });
});
