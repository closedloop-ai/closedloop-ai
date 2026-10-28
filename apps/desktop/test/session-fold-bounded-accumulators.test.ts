import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SessionCursorRow } from "../src/main/agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  addSessionToAnalyticsFold,
  createAnalyticsFold,
  finishAnalyticsFold,
} from "../src/main/session/session-analytics-fold.js";
import { SESSION_HYDRATION_WINDOW } from "../src/main/session/session-hydration-window.js";
import { getSharedAgentSessionUsage } from "../src/main/session/shared-agent-sessions-api.js";
import {
  addSessionToUsageSummaryFold,
  createUsageSummaryFold,
  finishUsageSummaryFold,
} from "../src/main/session/shared-agent-sessions-usage-summary.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * ISS-6895 — the windowed reads must be bounded by CARDINALITY, not by rows.
 *
 * The point of folding one hydration window at a time is that a corpus larger
 * than the window is COUNTED in full without being RETAINED in full. That
 * guarantee is only as good as the accumulators behind it: a single row-keyed
 * collection anywhere in the fold — a `Set` of session id per dimension, a cache
 * keyed by a per-session path — silently restores the corpus-sized residency the
 * windowing exists to remove, while every total stays correct and every existing
 * test stays green.
 *
 * These tests pin the bound itself rather than the totals, so the residency
 * regression is caught on its own terms. Each is written to DIVERGE with the
 * population: same dimensional cardinality, ten times the rows.
 */
describe("session folds — bounded accumulators (ISS-6895)", () => {
  /**
   * Every entry retained anywhere inside a fold accumulator.
   *
   * Deep-counts the Map/Set/array entries reachable from the accumulator, which
   * is the property under test stated directly: "bounded by the corpus's
   * cardinality, never by its row count" means this number does not move when
   * only the row count moves. A `Set` of session id shows up here as one entry
   * per row; a counter shows up as nothing at all.
   */
  function retainedEntryCount(
    value: unknown,
    seen = new Set<object>()
  ): number {
    if (value === null || typeof value !== "object") {
      return 0;
    }
    if (seen.has(value)) {
      return 0;
    }
    seen.add(value);
    if (value instanceof Set) {
      return value.size;
    }
    if (value instanceof Map) {
      let total = value.size;
      for (const entry of value.values()) {
        total += retainedEntryCount(entry, seen);
      }
      return total;
    }
    if (Array.isArray(value)) {
      let total = value.length;
      for (const entry of value) {
        total += retainedEntryCount(entry, seen);
      }
      return total;
    }
    let total = 0;
    for (const entry of Object.values(value)) {
      total += retainedEntryCount(entry, seen);
    }
    return total;
  }

  /**
   * `count` sessions of IDENTICAL dimensionality — one harness, one model, one
   * tool, no repository — so every dimension the folds key on has cardinality 1
   * no matter how many rows are folded. Only the session id varies, which is
   * exactly the axis a row-keyed accumulator would retain.
   */
  function uniformSessions(count: number): SyncedAgentSession[] {
    const sessions: SyncedAgentSession[] = [];
    for (let index = 0; index < count; index++) {
      sessions.push(
        session({ id: `uniform-${String(index).padStart(6, "0")}` })
      );
    }
    return sessions;
  }

  test("the usage fold retains the same entries for 10x the rows at equal cardinality", () => {
    const foldSmall = createUsageSummaryFold();
    for (const uniform of uniformSessions(200)) {
      addSessionToUsageSummaryFold(foldSmall, uniform);
    }
    const foldLarge = createUsageSummaryFold();
    for (const uniform of uniformSessions(2000)) {
      addSessionToUsageSummaryFold(foldLarge, uniform);
    }

    assert.equal(
      retainedEntryCount(foldLarge),
      retainedEntryCount(foldSmall),
      `the usage accumulator retained ${retainedEntryCount(foldLarge)} entries for 2000 rows but ${retainedEntryCount(foldSmall)} for 200 of the SAME one harness / one model — it is sized by rows, not by dimensions`
    );
    // The bound must not have been bought by miscounting: both folds still
    // report their full population on the single dimension they share.
    assert.equal(finishUsageSummaryFold(foldLarge).totalSessions, 2000);
    assert.equal(
      finishUsageSummaryFold(foldSmall).byHarness[0].sessionCount,
      200
    );
  });

  test("the analytics fold retains the same entries for 10x the rows at equal cardinality", () => {
    const foldSmall = createAnalyticsFold();
    for (const uniform of uniformSessions(200)) {
      addSessionToAnalyticsFold(foldSmall, uniform);
    }
    const foldLarge = createAnalyticsFold();
    for (const uniform of uniformSessions(2000)) {
      addSessionToAnalyticsFold(foldLarge, uniform);
    }

    assert.equal(
      retainedEntryCount(foldLarge),
      retainedEntryCount(foldSmall),
      `the analytics accumulator retained ${retainedEntryCount(foldLarge)} entries for 2000 rows but ${retainedEntryCount(foldSmall)} for 200 using the SAME single tool — it is sized by rows, not by dimensions`
    );
    const [tool] = finishAnalyticsFold(foldLarge).byTool;
    assert.equal(tool.sessionCount, 2000, "every row still counts once");
  });

  test("a session using one tool many times counts once for that tool", () => {
    const fold = createAnalyticsFold();
    const repeated = session({ id: "repeat-tool" });
    // Three invocations of the same tool inside ONE session: the per-tool
    // session count is a DISTINCT-session count, so replacing the id set with a
    // counter must still deduplicate within the session.
    repeated.events = [
      {
        externalEventId: "repeat-tool-1",
        eventType: "tool_use",
        toolName: "Bash",
        createdAt: "2026-01-01T00:05:00.000Z",
      },
      {
        externalEventId: "repeat-tool-2",
        eventType: "tool_use",
        toolName: "Bash",
        createdAt: "2026-01-01T00:06:00.000Z",
      },
      {
        externalEventId: "repeat-tool-3",
        eventType: "tool_use",
        toolName: "Bash",
        createdAt: "2026-01-01T00:07:00.000Z",
      },
    ];
    addSessionToAnalyticsFold(fold, repeated);

    const [tool] = finishAnalyticsFold(fold).byTool;
    assert.equal(tool.invocationCount, 3, "every invocation is still counted");
    assert.equal(
      tool.sessionCount,
      1,
      "one session using a tool three times is ONE session for that tool"
    );
  });

  test("a session billing the same model twice counts once for that model", () => {
    const fold = createUsageSummaryFold();
    const repeated = session({ id: "repeat-model" });
    // Two usage rows for the SAME model on one session — the shape the former
    // `sessionIds` set absorbed silently.
    repeated.tokenUsageByModel = [
      {
        model: "gpt-test",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        estimatedCostUsd: 0.25,
      },
      {
        model: "gpt-test",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.75,
      },
    ];
    addSessionToUsageSummaryFold(fold, repeated);

    const finished = finishUsageSummaryFold(fold);
    // ISS-8554 made `byModel` OPTIONAL on the contract, because the SQL producer
    // does not compute it. The DESKTOP fold under test still does, and asserting
    // that is the point — a narrowing that let undefined through would turn this
    // into a test that cannot fail.
    assert.ok(finished.byModel, "the desktop fold still produces byModel");
    const [model] = finished.byModel;
    assert.equal(
      model.sessionCount,
      1,
      "one session billing a model twice is ONE session for that model"
    );
    // Totals still sum EVERY usage row — the deduplication is of identity, not
    // of tokens.
    assert.equal(model.inputTokens, 11);
    assert.equal(model.outputTokens, 22);
  });

  test("the attribution cache does not outlive its hydration window", async () => {
    const overWindow = SESSION_HYDRATION_WINDOW + 137;
    const cursorRows: SessionCursorRow[] = [];
    const sessions: Record<string, SyncedAgentSession> = {};
    for (let index = 0; index < overWindow; index++) {
      const id = `match-${String(index).padStart(6, "0")}`;
      cursorRows.push(cursor(id));
      // A DISTINCT cwd per session — a worktree-per-task layout, where the
      // "bounded by distinct working directories" argument stops bounding
      // anything because distinct cwds scale with the corpus.
      sessions[id] = session({ id, cwd: `/tmp/match/${id}` });
    }
    const base = createFakeSource({ cursorRows, sessions });
    const observedCacheSizes: number[] = [];
    const source: AgentSessionSyncSource = {
      ...base,
      async loadSyncedSessions(ids, cache, loadOptions) {
        const loaded = await base.loadSyncedSessions(ids, cache, loadOptions);
        // Model the real source: resolving a session's attribution memoizes one
        // entry per cwd into the caller-owned cache.
        for (const loadedSession of loaded) {
          if (loadedSession.cwd) {
            cache.attributionByCwd.set(
              loadedSession.cwd,
              loadedSession.attribution ?? null
            );
          }
        }
        observedCacheSizes.push(cache.attributionByCwd.size);
        return loaded;
      },
    };

    // This source exposes neither `loadUsageSessions` nor `aggregateUsage`, so
    // the summary lands on `streamWorkingSessions` — the hydrating fallback that
    // walks the whole matched set one window at a time.
    const usage = await getSharedAgentSessionUsage(source, { search: "match" });

    assert.equal(
      usage.totalSessions,
      overWindow,
      "the read must still see every match"
    );
    assert.ok(
      observedCacheSizes.length > 1,
      `expected the corpus to span several hydration windows, saw ${observedCacheSizes.length}`
    );
    const peak = Math.max(...observedCacheSizes);
    assert.ok(
      peak <= SESSION_HYDRATION_WINDOW,
      `the attribution cache held ${peak} entries — past the ${SESSION_HYDRATION_WINDOW}-row residency ceiling, so it is accumulating across windows for the whole read instead of being scoped to one`
    );
  });
});
