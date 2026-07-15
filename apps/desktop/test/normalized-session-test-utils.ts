/**
 * @file normalized-session-test-utils.ts
 * @description Shared fixtures for collector tests. Centralizes the
 * `NormalizedSession` builder that was previously hand-rolled (a ~30-field
 * literal) in 10+ test files, so adding a field to `NormalizedSession` updates
 * one default here instead of silently drifting across every copy. Also provides
 * temp-dir tracking so file-touching collector tests stop leaking directories
 * into `os.tmpdir()`.
 *
 * `makeSession` delegates to the production `createNormalizedSession` factory
 * (collectors/types.ts) so the test default and the prod default share a single
 * source of truth — only the few test-friendly default values are layered on top.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexRolloutLinkage } from "../src/main/collectors/codex/codex-subagent-rollouts.js";
import {
  type BatchHarnessCollector,
  createNormalizedSession,
  type FileHarnessCollector,
  type Harness,
  type HarnessCollector,
  type NormalizedSession,
  type NormalizedToolUse,
} from "../src/main/collectors/types.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

/**
 * Build a `NormalizedSession` with sensible defaults, overriding only the fields
 * a test cares about. Pass `sessionId` (or any field) via `overrides`.
 *
 * Every caller-facing local `makeSession(...)` wrapper should delegate here,
 * passing only its file-specific values, so the full default contract lives in
 * exactly one place.
 */
export function makeSession(
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  const sessionId = overrides.sessionId ?? "test-session";
  // Delegate the full ~30-field contract to the production factory so adding a
  // field to NormalizedSession updates one default (in collectors/types.ts)
  // rather than drifting here. Only the fields where a test-friendly default
  // differs from the factory's neutral prod default are spelled out below; the
  // rest (empty arrays/maps, null scalars, usageExtras, artifacts) come from
  // createNormalizedSession.
  return createNormalizedSession({
    sessionId,
    name: sessionId,
    cwd: "/test/project",
    model: "test-model",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    entrypoint: "claude",
    plans: [],
    ...overrides,
  });
}

/**
 * Build a fully-populated `NormalizedSession` — a single Claude turn with token
 * counts, a token-series point, and message timestamps — over the neutral
 * `makeSession` defaults. Used by the attribution-accuracy suites and the
 * data-revision rebuild suite, which both need a realistic non-empty session
 * rather than the minimal `makeSession` fixture.
 */
export function makePopulatedSession(
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return makeSession({
    sessionId: "test-session-1",
    name: "Test Session",
    cwd: "/workspace/test",
    model: "claude-sonnet-4-5",
    version: "1.0.0",
    gitBranch: "main",
    startedAt: "2026-06-07T10:00:00.000Z",
    endedAt: "2026-06-07T11:00:00.000Z",
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {
      "claude-sonnet-4-5": {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
      },
    },
    messageTimestamps: ["2026-06-07T10:00:30.000Z"],
    tokenSeries: [
      {
        timestamp: "2026-06-07T10:00:30.000Z",
        model: "claude-sonnet-4-5",
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
      },
    ],
    ...overrides,
  });
}

/**
 * Build a minimal `NormalizedToolUse` (name + timestamp only) for evidence /
 * classifier tests. Shared so the FEA-2269 timeline and classifier suites use one
 * fixture builder instead of re-declaring a near-identical local literal.
 */
export function toolUse(
  name: string,
  timestamp: string | null
): NormalizedToolUse {
  return { name, timestamp };
}

/**
 * Build a `CodexRolloutLinkage` for the Codex rollout-graph tests. `depth`
 * defaults to the parent-derived `1 | 0` (a linkage with a parent sits at depth
 * 1) and `sourcePath` to a per-`rolloutId` `/codex/*.jsonl` path; pass either
 * explicitly for tests that assert on depth-sorting or specific source paths.
 * Shared by the discovery ref-mapping and cycle-guard suites so the null-field
 * contract lives in one place.
 */
export function codexLinkage(
  rolloutId: string,
  parentThreadId: string | null,
  depth: number | null = parentThreadId ? 1 : 0,
  sourcePath = `/codex/${rolloutId}.jsonl`
): CodexRolloutLinkage {
  return {
    rolloutId,
    parentThreadId,
    depth,
    agentNickname: null,
    agentRole: null,
    forkedFromId: null,
    sourcePath,
  };
}

// ── Temp-dir tracking ───────────────────────────────────────────────────────
// File-touching collector tests create scratch directories through the shared
// temp-dir manager. The manager supports per-call prefixes so collector tests can
// use several directory families while still draining every dir from one import.
// The explicit cleanup export is kept for tests with custom `afterEach` blocks.

const tempDirManager = createTempDirManager("normalized-session-test-");

/** Create a tracked temp directory under `os.tmpdir()`. Removed by `cleanupTempDirs`. */
export function makeTempDir(prefix: string): string {
  return tempDirManager.makeTempDir(prefix);
}

/** Remove (recursively, best-effort) every directory created via `makeTempDir`. */
export function cleanupTempDirs(): Promise<void> {
  return tempDirManager.cleanupTempDirs();
}

/**
 * Build a minimal in-memory `HarnessCollector` for CollectorManager / ingest
 * tests. Pass `sessions` for the common "parse returns these" case, or a custom
 * `parse`; the remaining optional members map straight through.
 */
export function fakeCollector(
  key: Harness,
  opts: {
    sources?: string[];
    sessions?: NormalizedSession[];
    parse?: (source: string) => Promise<NormalizedSession[]>;
    sessionIdForSource?: (source: string) => string | null;
    listSourcesForRebuild?: () => string[];
    batch?: boolean;
  } = {}
): HarnessCollector {
  // Shared base; the kind-specific members are layered on per the `batch`
  // discriminant so the result is a valid FileHarnessCollector | BatchHarnessCollector
  // (sessionIdForSource is file-only, listSourcesForRebuild is batch-only).
  const base = {
    key,
    cacheName: key,
    allowUnscopedSourceAdmission: true,
    watchRoots: () => [],
    watchMatch: () => true,
    listSources: () => opts.sources ?? [],
    parse: opts.parse ?? (() => Promise.resolve(opts.sessions ?? [])),
  };
  if (opts.batch) {
    return {
      ...base,
      batch: true,
      listSourcesForRebuild: opts.listSourcesForRebuild,
    } satisfies BatchHarnessCollector;
  }
  return {
    ...base,
    sessionIdForSource: opts.sessionIdForSource,
  } satisfies FileHarnessCollector;
}

/**
 * Write `lines` as JSONL (one `JSON.stringify` per line) into `dir/name`,
 * terminated by a trailing newline to match real on-disk transcripts; returns
 * the path.
 */
export function writeJsonl(
  dir: string,
  name: string,
  lines: readonly unknown[]
): string {
  const filePath = path.join(dir, name);
  writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8"
  );
  return filePath;
}

/**
 * Write a Claude JSONL transcript (and optional `agent-<name>.jsonl` subagent
 * sidecars) into a fresh temp project dir; returns the transcript path. Shared
 * by the attribution and data-revision suites.
 */
export function writeClaudeTranscript(
  sessionId: string,
  lines: unknown[],
  opts?: { subagents?: Record<string, unknown[]> }
): string {
  const projDir = mkdtempSync(path.join(os.tmpdir(), "claude-proj-"));
  const filePath = path.join(projDir, `${sessionId}.jsonl`);
  writeFileSync(
    filePath,
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    "utf8"
  );
  if (opts?.subagents) {
    const subDir = path.join(projDir, sessionId, "subagents");
    mkdirSync(subDir, { recursive: true });
    for (const [name, subLines] of Object.entries(opts.subagents)) {
      writeFileSync(
        path.join(subDir, `agent-${name}.jsonl`),
        `${subLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
        "utf8"
      );
    }
  }
  return filePath;
}
