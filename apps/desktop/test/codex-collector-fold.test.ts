/**
 * @file codex-collector-fold.test.ts
 * @description Behavioral coverage for the Codex descendant fold
 * (`codex-collector.ts`). Scope split from `collectors-parsers.test.ts`
 * (grandfathered shrink-only): that suite owns the happy-path fold, this one
 * owns the edges — drops, linkage-cache validation and pruning, the lazy graph
 * build, fork provenance, and the parse-quality and `last_token_usage` folds.
 * The shared per-model token merge those folds call lives in its own owner,
 * `merge-tokens-by-model.test.ts`. Every fixture is synthetic; nothing here
 * reads `packages/golden-sessions`.
 */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import path from "node:path";
import {
  ImportIngestFailure,
  ImportParseDegradedSite,
} from "@closedloop-ai/telemetry-contract/app";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
  createCodexCollector,
  foldCodexDescendants,
} from "../src/main/collectors/codex/codex-collector.js";
import { parseRolloutFile } from "../src/main/collectors/codex/codex-parser.js";
import {
  parseDegradedSite,
  parseQualityIngestFailures,
} from "../src/main/collectors/engine/collector-ingest-failure.js";
import type { IngestStorePort } from "../src/main/collectors/engine/ingest-store-port.js";
import type { NormalizedTokenCounts } from "../src/main/collectors/types.js";
import {
  CODEX_CHILD_UUID,
  CODEX_FALLBACK_MODEL,
  CODEX_FORK_UUID,
  CODEX_PARENT_UUID,
  codexAssistant,
  codexMcpToolCallEnd,
  codexSessionMeta,
  codexSubagentMeta,
  codexTokenCount,
  codexTurn,
  codexUser,
  minimalCodexRollout,
  writeCodexCollectorRollout,
} from "./codex-rollout-fixture.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
  return cleanupTempDirs();
});

function counts(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  inferred?: true
): NormalizedTokenCounts {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(inferred ? { inferred } : {}),
  };
}

/** Build a collector over an explicit source list rooted at `root`. */
function collectorOver(
  root: string,
  sources: string[],
  linkageStore?: IngestStorePort
) {
  return createCodexCollector({
    sessionsDir: root,
    archivedDir: path.join(root, "archive"),
    listSources: () => sources,
    ...(linkageStore ? { linkageStore } : {}),
  });
}

/** Token totals the fixtures use unless a test asserts on specific numbers. */
const PARENT_TOTALS = { input: 100, cached: 0, output: 10 };
const CHILD_TOTALS = { input: 50, cached: 0, output: 5 };
const CHILD_TIMESTAMP = "2026-06-24T10:01:00.000Z";

/** A root rollout with one cumulative `token_count`, written under `root`. */
function writeParent(
  root: string,
  totals = PARENT_TOTALS,
  timestamp = "2026-06-24T10:00:00.000Z"
): string {
  return writeCodexCollectorRollout(
    root,
    CODEX_PARENT_UUID,
    minimalCodexRollout(CODEX_PARENT_UUID, timestamp, totals)
  );
}

/** A depth-1 subagent rollout of {@link writeParent}, written under `root`. */
function writeChild(
  root: string,
  lines: unknown[],
  prefix = "2026-06-24T10-01-00"
): string {
  return writeCodexCollectorRollout(root, CODEX_CHILD_UUID, lines, prefix);
}

/** The `session_meta` of a depth-1 subagent rollout of the parent. */
function childMeta(timestamp = CHILD_TIMESTAMP): unknown {
  return codexSubagentMeta(timestamp, CODEX_CHILD_UUID, CODEX_PARENT_UUID, 1);
}

/** The `minimalCodexRollout` lines for a depth-1 subagent of the parent. */
function childLines(
  timestamp = CHILD_TIMESTAMP,
  totals = CHILD_TOTALS,
  parentThreadId = CODEX_PARENT_UUID
): unknown[] {
  return minimalCodexRollout(
    CODEX_CHILD_UUID,
    timestamp,
    totals,
    codexSubagentMeta(timestamp, CODEX_CHILD_UUID, parentThreadId, 1)
  );
}

describe("Codex descendant fold — token projections", () => {
  test("appends the child's tokenSeries AFTER the root's, so the series is NOT time-ordered", async () => {
    const root = makeTempDir("codex-fold-order-");
    const parentPath = writeCodexCollectorRollout(root, CODEX_PARENT_UUID, [
      codexSessionMeta("2026-06-24T10:00:00.000Z", {
        id: CODEX_PARENT_UUID,
        source: "exec",
      }),
      codexTurn("2026-06-24T10:00:00.000Z"),
      codexUser("2026-06-24T10:00:00.000Z"),
      codexTokenCount("2026-06-24T10:00:10.000Z", 1000, 400, 100),
      codexTokenCount("2026-06-24T10:00:20.000Z", 1400, 400, 150),
    ]);
    // The child ran BEFORE the root's own turns. A time-ordered merge would
    // interleave it first; the fold appends instead.
    const childPath = writeChild(
      root,
      childLines("2026-06-24T09:50:00.000Z", {
        input: 500,
        cached: 100,
        output: 50,
      }),
      "2026-06-24T09-50-00"
    );
    const collector = collectorOver(root, [parentPath, childPath]);

    const [parent] = await collector.parse(parentPath);

    assert.deepEqual(
      parent.tokenSeries.map((record) => record.timestamp),
      [
        "2026-06-24T10:00:10.000Z",
        "2026-06-24T10:00:20.000Z",
        "2026-06-24T09:50:00.000Z",
      ],
      "the folded child's record is appended last despite being the oldest"
    );
    // The documented trap: `.at(-1)` is the child's OLDEST record, not the latest.
    assert.ok(
      new Date(parent.tokenSeries.at(-1)?.timestamp ?? 0).getTime() <
        new Date(parent.tokenSeries[0]?.timestamp ?? 0).getTime()
    );
    // Token attribution: only the folded records carry the subagent stamp.
    assert.deepEqual(
      parent.tokenSeries.map((record) => record.subagentId),
      [undefined, undefined, CODEX_CHILD_UUID]
    );
    // ...and the subagent row is backed by the SAME record objects.
    assert.equal(
      parent.subagents?.[0].tokenSeries?.[0],
      parent.tokenSeries.at(-1)
    );
  });

  test("collapses a model-less child to one inferred gpt-5-codex key and propagates the flag to the root", async () => {
    const root = makeTempDir("codex-fold-inferred-");
    const parentPath = writeParent(root);
    // No `turn_context` anywhere in the child: the parser has no model to
    // attribute to, so it falls back to gpt-5-codex flagged `inferred`.
    const childPath = writeChild(root, [
      childMeta(),
      codexUser("2026-06-24T10:01:00.000Z"),
      codexTokenCount("2026-06-24T10:01:01.000Z", 50, 0, 5, { model: null }),
    ]);
    const collector = collectorOver(root, [parentPath, childPath]);

    const [parent] = await collector.parse(parentPath);

    assert.deepEqual(Object.keys(parent.subagents?.[0].tokensByModel ?? {}), [
      CODEX_FALLBACK_MODEL,
    ]);
    assert.deepEqual(
      parent.subagents?.[0].tokensByModel?.[CODEX_FALLBACK_MODEL],
      counts(50, 5, 0, 0, true)
    );
    // The root's own totals were NOT inferred; the merge must still mark the
    // combined key, because part of its spend is a guessed attribution.
    assert.deepEqual(
      parent.tokensByModel[CODEX_FALLBACK_MODEL],
      counts(150, 15, 0, 0, true)
    );
  });

  test("folds the child's authoritative last_token_usage snapshots after the root's own", async () => {
    const root = makeTempDir("codex-fold-last-usage-");
    const parentPath = writeCodexCollectorRollout(root, CODEX_PARENT_UUID, [
      codexSessionMeta("2026-06-24T10:00:00.000Z", {
        id: CODEX_PARENT_UUID,
        source: "exec",
      }),
      codexTurn("2026-06-24T10:00:00.000Z"),
      codexTokenCount("2026-06-24T10:00:10.000Z", 1000, 400, 100, {
        lastTokenUsage: {
          input_tokens: 1000,
          cached_input_tokens: 400,
          output_tokens: 100,
        },
      }),
    ]);
    const childPath = writeChild(root, [
      childMeta(),
      codexTurn("2026-06-24T10:01:00.000Z"),
      codexTokenCount("2026-06-24T10:01:10.000Z", 50, 0, 5, {
        lastTokenUsage: {
          input_tokens: 50,
          cached_input_tokens: 0,
          output_tokens: 5,
        },
      }),
    ]);
    const collector = collectorOver(root, [parentPath, childPath]);

    const [parent] = await collector.parse(parentPath);

    assert.deepEqual(
      parent.codexLastTokenUsage?.map((snapshot) => snapshot.timestamp),
      ["2026-06-24T10:00:10.000Z", "2026-06-24T10:01:10.000Z"]
    );
    assert.deepEqual(parent.codexLastTokenUsage?.at(-1)?.lastTokenUsage, {
      input: 50,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("seeds codexLastTokenUsage from the child when the root carries none", async () => {
    const root = makeTempDir("codex-fold-last-usage-seed-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, [
      childMeta(),
      codexTurn("2026-06-24T10:01:00.000Z"),
      codexTokenCount("2026-06-24T10:01:10.000Z", 50, 0, 5, {
        lastTokenUsage: {
          input_tokens: 50,
          cached_input_tokens: 0,
          output_tokens: 5,
        },
      }),
    ]);
    const bare = await parseRolloutFile(parentPath);
    assert.equal(
      bare?.codexLastTokenUsage?.length ?? 0,
      0,
      "fixture guard: the root itself emits no snapshots"
    );
    const collector = collectorOver(root, [parentPath, childPath]);

    const [parent] = await collector.parse(parentPath);

    assert.equal(parent.codexLastTokenUsage?.length, 1);
    assert.equal(
      parent.codexLastTokenUsage?.[0]?.timestamp,
      "2026-06-24T10:01:10.000Z"
    );
  });
});

describe("Codex descendant fold — drops", () => {
  test("drops a child rollout with no usable timestamp, leaving the root's totals untouched", async () => {
    const root = makeTempDir("codex-drop-no-ts-");
    const parentPath = writeParent(root);
    // Discoverable as a descendant (the session_meta linkage is read off the
    // first line), but the parser rejects it: not one record carries a timestamp.
    const childPath = writeChild(root, [
      {
        type: "session_meta",
        payload: {
          id: CODEX_CHILD_UUID,
          cwd: "/Users/dev/codex-parent",
          source: {
            subagent: {
              agent_nickname: "no-clock",
              agent_role: "worker",
              thread_spawn: { parent_thread_id: CODEX_PARENT_UUID, depth: 1 },
            },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 5000,
              cached_input_tokens: 0,
              output_tokens: 500,
            },
          },
          turn_context: { model: CODEX_FALLBACK_MODEL },
        },
      },
    ]);
    const collector = collectorOver(root, [parentPath, childPath]);

    const [parent] = await collector.parse(parentPath);
    const childSessions = await collector.parse(childPath);

    assert.equal(parent.subagents?.length, 0);
    assert.deepEqual(
      parent.tokensByModel[CODEX_FALLBACK_MODEL],
      counts(100, 10, 0, 0),
      "the dropped child contributed no tokens"
    );
    assert.equal(
      childSessions.length,
      0,
      "the child source stays suppressed — it is never imported standalone"
    );
  });

  test("drops a burst child rollout from the fold", async () => {
    const root = makeTempDir("codex-drop-burst-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, burstRolloutLines());
    const collector = collectorOver(root, [parentPath, childPath]);

    const [parent] = await collector.parse(parentPath);

    assert.equal(parent.subagents?.length, 0);
    assert.deepEqual(
      parent.tokensByModel[CODEX_FALLBACK_MODEL],
      counts(100, 10, 0, 0)
    );
  });

  test("yields no session at all for a burst root rollout", async () => {
    const root = makeTempDir("codex-drop-burst-root-");
    const rootPath = writeCodexCollectorRollout(
      root,
      CODEX_PARENT_UUID,
      burstRolloutLines(CODEX_PARENT_UUID, null)
    );
    const collector = collectorOver(root, [rootPath]);

    assert.deepEqual(await collector.parse(rootPath), []);
  });
});

describe("Codex descendant fold — provenance and quality", () => {
  test("stamps fork provenance and falls back to a generated name for an unnamed fork", async () => {
    const root = makeTempDir("codex-fold-fork-meta-");
    const parentPath = writeParent(root);
    // A fork/resume rollout: `forked_from_id` with NO subagent block, so it has
    // no thread parent, no nickname and no role. `cwd` is omitted too, so the
    // parser derives no session name either and the fallback chain runs out.
    const forkPath = writeCodexCollectorRollout(
      root,
      CODEX_FORK_UUID,
      [
        {
          timestamp: "2026-06-24T10:02:00.000Z",
          type: "session_meta",
          payload: {
            id: CODEX_FORK_UUID,
            forked_from_id: CODEX_PARENT_UUID,
            cli_version: "0.40.0",
          },
        },
        {
          timestamp: "2026-06-24T10:02:00.000Z",
          type: "turn_context",
          payload: { model: CODEX_FALLBACK_MODEL },
        },
        codexTokenCount("2026-06-24T10:02:10.000Z", 20, 0, 2),
      ],
      "2026-06-24T10-02-00"
    );
    const collector = collectorOver(root, [parentPath, forkPath]);

    const [parent] = await collector.parse(parentPath);

    const fork = parent.subagents?.[0];
    assert.equal(fork?.id, CODEX_FORK_UUID);
    assert.equal(fork?.type, null, "no agent_role on a fork rollout");
    // The name chain is `agentNickname ?? agentRole ?? parsedChild.name ??
    // "Codex subagent <id8>"`. With no nickname, no role and no cwd it lands on
    // the PARSER's own synthesized name.
    // NOTE (suspected dead branch, asserting current behavior): the parser
    // always names a session it returns — `parse-codex.ts` falls back to
    // `Codex Session <id8>` when `cwd` is absent — so the collector's trailing
    // `Codex subagent <id8>` arm looks unreachable for any child that parses at
    // all. Left as-is; this test pins the label users actually see.
    assert.equal(fork?.name, `Codex Session ${CODEX_FORK_UUID.slice(0, 8)}`);
    assert.deepEqual(fork?.metadata, {
      codexDepth: null,
      codexParentThreadId: null,
      codexForkedFromId: CODEX_PARENT_UUID,
    });
    // The fork's effective parent IS the root, which normalizes to the root
    // itself — recorded as a top-level subagent, not a child of one.
    assert.equal(fork?.parentId, null);
  });

  test("folds the child's parse-quality signals (unknown records, malformed rate limits, orphaned MCP outputs) into the root", async () => {
    const root = makeTempDir("codex-fold-quality-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, [
      childMeta(),
      codexTurn("2026-06-24T10:01:00.000Z"),
      // A valid-JSON record the classifier cannot route anywhere.
      { timestamp: "2026-06-24T10:01:01.000Z", surprise: "unroutable" },
      // An MCP completion naming a call_id no `begin` ever opened: orphaned.
      codexMcpToolCallEnd("2026-06-24T10:01:02.000Z", { ok: true }, "call-404"),
      // An identifier-free completion: correlated positionally, i.e. ambiguous.
      codexMcpToolCallEnd("2026-06-24T10:01:03.000Z", { ok: true }),
      // A present-but-malformed in-band rate_limits block.
      codexTokenCount("2026-06-24T10:01:04.000Z", 50, 0, 5, {
        rateLimits: "not-an-object",
      }),
    ]);
    const collector = collectorOver(root, [parentPath, childPath]);

    const parentOnly = await parseRolloutFile(parentPath, {
      mergeWorkflowJournalTokens: false,
    });
    const [parent] = await collector.parse(parentPath);

    assert.equal(
      parent.parseQuality?.totalLines,
      (parentOnly?.parseQuality?.totalLines ?? 0) + 6,
      "line counts are additive across the fold"
    );
    assert.equal(parent.parseQuality?.unknownRecords, 1);
    assert.equal(parent.parseQuality?.malformedRateLimits, 1);
    assert.equal(parent.parseQuality?.orphanedToolOutputs, 1);
    assert.equal(parent.parseQuality?.ambiguousToolOutputs, 1);
    assert.equal(
      parentOnly?.parseQuality?.unknownRecords,
      undefined,
      "fixture guard: every one of those signals came from the child"
    );
  });

  // ISS-6336 (whitlockk review): `mergeParseQuality` re-derived the child fold
  // instead of reusing the canonical one, and got both halves wrong — it summed
  // the child's `malformedLines` RAW, counting its benign live-write truncation
  // as corruption, and OR-ed `truncatedFinalLine` onto a parent whose own final
  // line was fine. A healthy multi-rollout session therefore reported
  // `session_parse_degraded`, which is a health counter firing on health.
  test("a descendant rollout's benign trailing truncation is not corruption (ISS-6336)", async () => {
    const root = makeTempDir("codex-fold-quality-truncated-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    // Append a raw truncated line — `writeChild` JSON-stringifies every element,
    // so a malformed line cannot be expressed through it.
    appendFileSync(
      childPath,
      '{"timestamp":"2026-06-24T10:01:09.000Z","payload":{"type":"even',
      "utf8"
    );
    const collector = collectorOver(root, [parentPath, childPath]);

    const parentOnly = await parseRolloutFile(parentPath, {
      mergeWorkflowJournalTokens: false,
    });
    const [parent] = await collector.parse(parentPath);

    assert.equal(
      parent.parseQuality?.malformedLines,
      parentOnly?.parseQuality?.malformedLines ?? 0,
      "the child's own trailing truncation must not inflate the parent"
    );
    assert.equal(
      parent.parseQuality?.truncatedFinalLine,
      false,
      "truncatedFinalLine belongs to the ROOT rollout's file, never a child's"
    );
    assert.equal(parent.parseQuality?.childTruncatedFinalLines, 1);
    assert.deepEqual(parseQualityIngestFailures(parent.parseQuality), []);
  });

  /**
   * ISS-12036: the fold ATTRIBUTES what it adds, so a degraded multi-rollout
   * Codex session says which writer lost the lines.
   *
   * The three shares — the root's own transcript, folded children, folded
   * descendant rollouts — sum back to the corrupt-line count exactly, which is
   * what lets `parseDegradedSite` derive the root's share as the remainder
   * rather than carry a fourth counter that could disagree with the total.
   *
   * MUTATION: drop the `foldedDescendantMalformedLines` term from
   * `mergeParseQuality` and the site falls through to `main_transcript`,
   * blaming the root for a descendant's corruption.
   */
  test("a descendant rollout's MID-FILE corruption is attributed to the fold (ISS-12036)", async () => {
    const root = makeTempDir("codex-fold-quality-attributed-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    // A corrupt line in the MIDDLE of the child, followed by a well-formed one,
    // so it is genuine corruption rather than the benign trailing truncation the
    // sibling case above covers.
    appendFileSync(
      childPath,
      '{"timestamp":"2026-06-24T10:01:09.000Z","payload":{"type":"even\n',
      "utf8"
    );
    appendFileSync(
      childPath,
      `${JSON.stringify(codexTokenCount("2026-06-24T10:01:10.000Z", 10, 0, 1))}\n`,
      "utf8"
    );
    const collector = collectorOver(root, [parentPath, childPath]);

    const parentOnly = await parseRolloutFile(parentPath, {
      mergeWorkflowJournalTokens: false,
    });
    const [parent] = await collector.parse(parentPath);

    assert.equal(
      parentOnly?.parseQuality?.malformedLines,
      0,
      "fixture guard: the root's own transcript is clean, so every corrupt line came from the descendant"
    );
    assert.equal(parent.parseQuality?.malformedLines, 1);
    assert.equal(parent.parseQuality?.foldedDescendantMalformedLines, 1);
    assert.equal(
      parent.parseQuality?.foldedChildMalformedLines,
      undefined,
      "no workflow journal was folded, so that share stays absent"
    );
    assert.deepEqual(parseQualityIngestFailures(parent.parseQuality), [
      ImportIngestFailure.SessionParseDegraded,
    ]);
    assert.equal(
      parseDegradedSite(parent.parseQuality),
      ImportParseDegradedSite.FoldedDescendant
    );
  });

  test("a clean fold leaves the optional parse-quality counters absent", async () => {
    const root = makeTempDir("codex-fold-quality-clean-");
    const parentPath = writeParent(root);
    const childPath = writeChild(root, childLines());
    const collector = collectorOver(root, [parentPath, childPath]);

    const [parent] = await collector.parse(parentPath);

    assert.equal(parent.subagents?.length, 1);
    // Exact shape, so an accidentally-emitted zero counter fails here: the
    // optional keys must be ABSENT on a clean merge, not present as 0.
    assert.deepEqual(parent.parseQuality, {
      totalLines: 10,
      malformedLines: 0,
      truncatedFinalLine: false,
    });
  });
});

describe("foldCodexDescendants (direct)", () => {
  test("is a no-op for a root with no descendants, but still recollects artifacts", async () => {
    const root = makeTempDir("codex-fold-direct-");
    const parentPath = writeParent(root);
    const session = await parseRolloutFile(parentPath);
    assert.ok(session);
    const seriesBefore = [...session.tokenSeries];

    await foldCodexDescendants(session, parentPath, [parentPath]);

    assert.deepEqual(session.subagents, []);
    assert.deepEqual(session.tokenSeries, seriesBefore);
    assert.deepEqual(session.tokensByModel, {
      [CODEX_FALLBACK_MODEL]: counts(100, 10, 0, 0),
    });
  });
});

/**
 * A rollout that trips the parser's burst guard: >= 20 records inside the 5s
 * detection window, which the parser rejects wholesale (it is a replay, not
 * real work).
 */
function burstRolloutLines(
  id: string = CODEX_CHILD_UUID,
  parentThreadId: string | null = CODEX_PARENT_UUID
): unknown[] {
  const start = Date.parse("2026-06-24T10:01:00.000Z");
  const meta = parentThreadId
    ? codexSubagentMeta(new Date(start).toISOString(), id, parentThreadId, 1)
    : codexSessionMeta(new Date(start).toISOString(), { id, source: "exec" });
  const lines: unknown[] = [meta, codexTurn(new Date(start).toISOString())];
  for (let i = 0; i < 25; i++) {
    lines.push(codexAssistant(new Date(start + i * 10).toISOString()));
  }
  return lines;
}
