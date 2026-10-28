import { isSubstantiveSession } from "@repo/api/src/agent-session-filters";
import { describe, expect, it } from "vitest";
import {
  SESSION_SUBSTANTIVE_SIGNALS,
  SESSION_SUBSTANTIVE_WHERE,
  SESSION_TOKEN_USAGE_WHERE,
  SessionSubstantiveAlias,
  sessionSubstantiveSql,
} from "./session-substantive-predicate";

/**
 * The two dialects are consumed by different callers — `query-builder.ts` uses
 * the Prisma one, the ISS-4752 data-invariant audit uses both — so a signal
 * reaching only one is exactly the silent drift this module was extracted to
 * prevent. These rows fail when the dialects disagree, not when the inventory
 * changes: adding a signal correctly keeps them green.
 */
describe("session substantive predicate dialects", () => {
  it("gives the Prisma dialect one arm per inventory signal, in order", () => {
    const armFields = (SESSION_SUBSTANTIVE_WHERE.OR ?? []).map(
      (arm) => Object.keys(arm)[0]
    );

    expect(armFields).toEqual([...SESSION_SUBSTANTIVE_SIGNALS]);
  });

  it("compares every arm against zero in the Prisma dialect", () => {
    for (const arm of SESSION_SUBSTANTIVE_WHERE.OR ?? []) {
      expect(Object.values(arm)[0]).toEqual({ gt: 0 });
    }
  });

  it("names every inventory signal's column in the SQL dialect", () => {
    const sql = sessionSubstantiveSql(SessionSubstantiveAlias.SessionDetail);

    // One OR arm per signal — the count is what catches a signal that reached
    // the Prisma dialect and never got a SQL column.
    expect(sql.strings.join("").split(" OR ")).toHaveLength(
      SESSION_SUBSTANTIVE_SIGNALS.length
    );
    for (const column of [
      "sd.turns",
      "sd.input_tokens",
      "sd.output_tokens",
      "sd.cache_read_tokens",
      "sd.cache_write_tokens",
      "sd.tool_use_count",
      "sd.component_invocation_count",
    ]) {
      expect(sql.strings.join("")).toContain(column);
    }
  });

  it("coalesces only the nullable turns column", () => {
    const sql = sessionSubstantiveSql(
      SessionSubstantiveAlias.SessionDetail
    ).strings.join("");

    // A bare `turns > 0` is SQL NULL for a null-turns row and would drop it
    // from an OR that should have classified it idle.
    expect(sql).toContain("COALESCE(sd.turns, 0) > 0");
    expect(sql.match(/COALESCE/g)).toHaveLength(1);
  });

  it("agrees with the JS SSOT on the idle/substantive boundary", () => {
    // FEA-3149 lockstep: a row buckets identically on cloud, desktop, and the
    // shared UI. Each signal alone must be enough to make a row substantive.
    const idle = {
      turns: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolUseCount: 0,
      componentInvocationCount: 0,
    };

    expect(isSubstantiveSession(idle)).toBe(false);

    for (const signal of SESSION_SUBSTANTIVE_SIGNALS) {
      expect(isSubstantiveSession({ ...idle, [signal]: 1 })).toBe(true);
    }
  });

  it("counts any of the four token columns, and only those, as recorded usage (ISS-10833)", () => {
    const armFields = (SESSION_TOKEN_USAGE_WHERE.OR ?? []).map(
      (arm) => Object.keys(arm)[0]
    );

    expect(armFields).toEqual([
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ]);
  });
});
