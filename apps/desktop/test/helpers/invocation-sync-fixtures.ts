/**
 * @file invocation-sync-fixtures.ts
 * @description Shared fixtures for the invocation-sync suites — the on-disk agent
 * database and the skill-bearing session that materializes exactly one invocation
 * generation.
 *
 * Extracted (ISS-5789) so the materialization suite and the promotion-step suite
 * build their corpus from ONE definition rather than a copy each. Both suites
 * assert on generation identity and outbox rows, so a drifted fixture would make
 * two suites disagree about the same protocol.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import { makeSession } from "../normalized-session-test-utils.js";

export const NOW = "2026-07-22T17:00:00.000Z";
export const SKILL_CONTENT_V1 = "---\nname: review\n---\nReview carefully.\n";
export const SKILL_CONTENT_V2 =
  "---\nname: review\n---\nReview adversarially.\n";

export type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

/** A temp directory holding one isolated agent database. */
export function makeInvocationSyncDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export function openDb(dir: string): Promise<Db> {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

/**
 * A session whose only components are `review` skill invocations, one per entry in
 * `contents`. Each skill is paired with the `Skill` tool use that carries it, which
 * is what makes the session substantive to the sync boundary.
 */
export function skillSession(
  sessionId: string,
  contents: readonly string[]
): ReturnType<typeof makeSession> {
  const skills = contents.map((content, index) => {
    const providerToolUseId = `toolu_skill_${index}`;
    const timestamp = `2026-07-22T17:00:0${index}.000Z`;
    const definitionSnapshot = {
      kind: "skill" as const,
      rawName: "review",
      normalizedName: "review",
      content,
      capturedAt: timestamp,
    };
    return {
      name: "review",
      rawName: "review",
      normalizedName: "review",
      timestamp,
      providerToolUseId,
      definitionSnapshot,
    };
  });
  return makeSession({
    sessionId,
    startedAt: NOW,
    endedAt: "2026-07-22T17:05:00.000Z",
    skills,
    toolUses: skills.map((skill) => ({
      name: "Skill",
      kind: "harness" as const,
      timestamp: skill.timestamp,
      id: skill.providerToolUseId,
      providerToolUseId: skill.providerToolUseId,
      skillName: skill.name,
      definitionSnapshot: skill.definitionSnapshot,
    })),
  });
}
