import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { createCodexCollector } from "../src/main/collectors/codex/codex-collector.js";
import {
  getWorkerCollector,
  parseHistoricalSource,
  resetWorkerCollectorsForTesting,
} from "../src/main/collectors/engine/historical-parse-source.js";
import { Harness } from "../src/main/collectors/types.js";

// Distinct, regex-valid Codex rollout ids (sessionIdFromRolloutPath extracts the
// uuid from the filename).
const ROLLOUT_IDS = [
  "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "c3c3c3c3-cccc-4ccc-8ccc-cccccccccccc",
  "d4d4d4d4-dddd-4ddd-8ddd-dddddddddddd",
];

function rolloutLines(id: string): unknown[] {
  const timestamp = "2026-06-28T10:00:00.000Z";
  return [
    {
      timestamp,
      type: "session_meta",
      payload: {
        cwd: "/workspace/project",
        cli_version: "0.40.0",
        id,
        source: "exec",
      },
    },
    {
      timestamp,
      type: "turn_context",
      payload: { model: "gpt-5-codex", cwd: "/workspace/project" },
    },
    {
      timestamp,
      type: "event_msg",
      payload: { type: "user_message", message: "work" },
    },
    {
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 20,
          },
        },
        turn_context: { model: "gpt-5-codex" },
      },
    },
  ];
}

function writeSessionsFixture(): { root: string; sources: string[] } {
  const root = mkdtempSync(path.join(tmpdir(), "codex-worker-reuse-"));
  const dayDir = path.join(root, "2026", "06", "28");
  mkdirSync(dayDir, { recursive: true });
  const sources = ROLLOUT_IDS.map((id, index) => {
    const filePath = path.join(
      dayDir,
      `rollout-2026-06-28T10-00-0${index}-${id}.jsonl`
    );
    const body = rolloutLines(id)
      .map((line) => JSON.stringify(line))
      .join("\n");
    writeFileSync(filePath, `${body}\n`, "utf8");
    return filePath;
  });
  return { root, sources };
}

describe("historical parse source worker-collector reuse", () => {
  afterEach(() => {
    resetWorkerCollectorsForTesting();
  });

  test("reuses one collector instance per harness", () => {
    resetWorkerCollectorsForTesting();

    const codexA = getWorkerCollector(Harness.Codex);
    const codexB = getWorkerCollector(Harness.Codex);
    assert.equal(codexA, codexB, "the same harness reuses its collector");

    const claude = getWorkerCollector(Harness.Claude);
    assert.notEqual(
      codexA,
      claude,
      "a different harness gets its own collector"
    );

    resetWorkerCollectorsForTesting();
    assert.notEqual(
      getWorkerCollector(Harness.Codex),
      codexA,
      "reset drops the cache"
    );
  });

  test("builds the collector once across many parses, not per source", async () => {
    const { root, sources } = writeSessionsFixture();
    let built = 0;
    resetWorkerCollectorsForTesting((collectorKey) => {
      built += 1;
      assert.equal(collectorKey, Harness.Codex);
      return createCodexCollector({
        sessionsDir: root,
        archivedDir: path.join(root, "archived"),
        listSources: () => sources,
      });
    });

    try {
      for (const source of sources) {
        const sessions = await parseHistoricalSource(Harness.Codex, source);
        // Every fixture rollout is a root session, so it parses to exactly one.
        assert.equal(sessions.length, 1, `parsed ${path.basename(source)}`);
      }
      assert.equal(
        built,
        1,
        "the worker builds the collector once and reuses it for every source"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
