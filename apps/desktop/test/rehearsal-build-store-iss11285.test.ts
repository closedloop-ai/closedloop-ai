/**
 * @file rehearsal-build-store-iss11285.test.ts
 * @description ISS-11285 — covers `collectFixtureAgentReferences` against a
 * real store, and the CLI entry guard's usage failure (no `--out`, or `--out`
 * with no value). The full `main()` run stages the whole golden corpus and is
 * a rehearsal, not a unit test, so only its argument check is driven here.
 *
 * ISS-11352 adds `injectMissingSourceFixture` against a store with no
 * invocation table, and `runRehearsalBackfills` over a non-empty Claude list
 * whose sessions the store does not hold.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { Harness } from "@repo/lib/harness/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectFixtureAgentReferences,
  injectMissingSourceFixture,
  REHEARSAL_BACKFILL,
  runRehearsalBackfills,
} from "../scripts/rehearsal-build-store.js";
import { insertInvocations } from "./agent-components-test-fixtures.js";
import { openTestDb } from "./agent-db-test-utils.js";

const SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/rehearsal-build-store.ts", import.meta.url)
);
const USAGE_FAILURE =
  "[rehearsal-build-store] FAILED: Error: usage: tsx scripts/rehearsal-build-store.ts --out <dir>";

const INVOCATION_TABLE = "agent_component_invocations";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iss11285-rehearsal-store-"));
  tempDirs.push(dir);
  return dir;
}

describe("collectFixtureAgentReferences", () => {
  it("splits each fixture's invocations by agent reference and reports 0/0 for an id with no rows", async () => {
    const db = await openTestDb(makeStoreDir());
    try {
      const sessionId = await injectMissingSourceFixture(db);
      await insertInvocations(db.prisma, [
        {
          id: `${sessionId}-null-a`,
          sessionId,
          componentKind: AgentComponentInvocationKind.Tool,
          componentKey: "Read",
          anchorKind: AgentComponentInvocationAnchorKind.Session,
          anchorValue: sessionId,
        },
        {
          id: `${sessionId}-null-b`,
          sessionId,
          componentKind: AgentComponentInvocationKind.Tool,
          componentKey: "Edit",
          anchorKind: AgentComponentInvocationAnchorKind.Session,
          anchorValue: sessionId,
        },
        {
          id: `${sessionId}-with-agent`,
          sessionId,
          componentKind: AgentComponentInvocationKind.Tool,
          componentKey: "Bash",
          anchorKind: AgentComponentInvocationAnchorKind.Session,
          anchorValue: sessionId,
        },
      ]);
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `UPDATE agent_component_invocations
              SET agent_id = (SELECT id FROM agents WHERE session_id = $1 LIMIT 1)
            WHERE id = $2`,
          sessionId,
          `${sessionId}-with-agent`
        )
      );

      const refs = await collectFixtureAgentReferences(db, [
        sessionId,
        "iss11285-no-such-session",
      ]);

      expect(refs).toEqual([
        { id: sessionId, invocationsWithNullAgent: 2, invocationsWithAgent: 1 },
        // SUM over zero rows is SQL NULL; the `?? 0` fold reports it as zero.
        {
          id: "iss11285-no-such-session",
          invocationsWithNullAgent: 0,
          invocationsWithAgent: 0,
        },
      ]);
    } finally {
      await db.close();
    }
  });
});

describe("injectMissingSourceFixture on a store without the invocation table", () => {
  it("skips the invocation delete and still writes the session, agent and both events", async () => {
    const db = await openTestDb(makeStoreDir());
    try {
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(`DROP TABLE ${INVOCATION_TABLE}`)
      );

      const sessionId = await injectMissingSourceFixture(db);

      const sessions = await db.prisma.client.$queryRawUnsafe<
        { id: string; status: string }[]
      >("SELECT id, status FROM sessions WHERE id = $1", sessionId);
      expect(sessions).toEqual([
        { id: sessionId, status: SESSION_STATUS.INACTIVE },
      ]);
      const events = await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
        "SELECT id FROM events WHERE session_id = $1 ORDER BY id",
        sessionId
      );
      expect(events.map((row) => row.id)).toEqual([
        `${sessionId}-event-orphan`,
        `${sessionId}-event-resolvable`,
      ]);
      const agents = await db.prisma.client.$queryRawUnsafe<{ n: number }[]>(
        "SELECT COUNT(*) AS n FROM agents WHERE session_id = $1",
        sessionId
      );
      expect(Number(agents[0]?.n)).toBe(1);
    } finally {
      await db.close();
    }
  });
});

describe("runRehearsalBackfills over staged transcripts the store does not hold", () => {
  it("throws on the Claude artifact-link pass naming the file count and scanned=0", async () => {
    const stagingDir = makeStoreDir();
    const sessionId = "iss11352-unknown-claude-session";
    mkdirSync(join(stagingDir, sessionId));
    writeFileSync(join(stagingDir, sessionId, `${sessionId}.jsonl`), "");
    const db = await openTestDb(makeStoreDir());
    try {
      await expect(
        runRehearsalBackfills(db, stagingDir, () => undefined)
      ).rejects.toThrow(
        `${Harness.Claude} ${REHEARSAL_BACKFILL.ArtifactLinks} backfill captured nothing from 1 staged transcript(s) (scanned=0)`
      );
    } finally {
      await db.close();
    }
  });
});

describe("CLI entry (run as the main module)", () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each([
    ["no --out flag", [] as string[]],
    ["--out with no value", ["--out"]],
  ])(
    "fails with the usage error and exit code 1 on %s",
    async (_label, extra) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      process.argv = [originalArgv[0] ?? "node", SCRIPT_PATH, ...extra];
      vi.resetModules();

      await import("../scripts/rehearsal-build-store.js");

      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
      expect(errorSpy).toHaveBeenCalledWith(USAGE_FAILURE);
      expect(process.exitCode).toBe(1);
    }
  );
});
