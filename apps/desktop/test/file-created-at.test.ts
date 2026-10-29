/**
 * @file file-created-at.test.ts
 * @description ISS-12251 (PLN-2176 T-6.2): `fileCreatedAtFromStats` keeps only
 * a usable birth time, and every file-backed parser shell stamps it as
 * `fileCreatedAt` (omitting the key when there is none) from the same stat that
 * gives `fileModifiedAt`.
 *
 * Birth time cannot be set on a real file, and some filesystems report none, so
 * the parser cases make `statSync` of the transcript report chosen times over
 * the real stat of a real temp file.
 */
import assert from "node:assert/strict";
import type * as NodeFs from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { parseSessionFile } from "../src/main/collectors/claude/claude-parser.js";
import { parseRolloutFile } from "../src/main/collectors/codex/codex-parser.js";
import {
  parseChatSessionFile,
  parseCliEventFile,
} from "../src/main/collectors/copilot/copilot-parser.js";
import { parseTranscriptFile } from "../src/main/collectors/cursor/cursor-parser.js";
import { fileCreatedAtFromStats } from "../src/main/collectors/file-created-at.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { CODEX_UUID, minimalCodexRollout } from "./codex-rollout-fixture.js";
import {
  cleanupTempDirs,
  makeTempDir,
  writeJsonl,
} from "./normalized-session-test-utils.js";

const BIRTH_MS = Date.parse("2024-03-09T15:00:00.000Z");
const MTIME_MS = Date.parse("2024-03-09T17:00:00.000Z");

type StatTimes = { birthtimeMs: number | undefined; mtimeMs: number };

// The Claude shell imports `statSync` by name, which `vi.spyOn(fs, …)` does not
// reach; a module mock reaches the named and the default-import callers alike.
const transcriptStat = vi.hoisted(() => ({
  filePath: undefined as string | undefined,
  timesForCall: (_call: number): StatTimes | null => null,
  calls: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const statSync = ((
    target: NodeFs.PathLike,
    options?: NodeFs.StatSyncOptions
  ) => {
    const stat = actual.statSync(target, options) as NodeFs.Stats;
    if (target !== transcriptStat.filePath) {
      return stat;
    }
    const times = transcriptStat.timesForCall(transcriptStat.calls++);
    if (times === null) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return Object.assign(stat, {
      birthtimeMs: times.birthtimeMs,
      birthtime: new Date(times.birthtimeMs ?? Number.NaN),
      mtimeMs: times.mtimeMs,
      mtime: new Date(times.mtimeMs),
    });
  }) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

afterEach(async () => {
  transcriptStat.filePath = undefined;
  await cleanupTempDirs();
});

/**
 * Each stat of `filePath` reports the times `timesForCall` returns for that
 * call (0-based), or throws when it returns `null`; other paths stat normally.
 */
function stubTranscriptStat(
  filePath: string,
  timesForCall: (call: number) => StatTimes | null
): { readonly calls: number } {
  transcriptStat.filePath = filePath;
  transcriptStat.timesForCall = timesForCall;
  transcriptStat.calls = 0;
  return transcriptStat;
}

function writeFile(name: string, body: string): string {
  const filePath = path.join(makeTempDir("file-created-at-"), name);
  fs.writeFileSync(filePath, body, "utf8");
  return filePath;
}

describe("fileCreatedAtFromStats", () => {
  test("returns a real birth time", () => {
    assert.equal(fileCreatedAtFromStats({ birthtimeMs: BIRTH_MS }), BIRTH_MS);
  });

  test("omits an epoch-0, negative, NaN or infinite birth time", () => {
    for (const birthtimeMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      assert.equal(
        fileCreatedAtFromStats({ birthtimeMs }),
        undefined,
        String(birthtimeMs)
      );
    }
  });
});

type ParserCase = {
  name: string;
  write: () => string;
  parse: (filePath: string) => Promise<NormalizedSession | null>;
  /** Stats of the transcript before the one that gives `fileModifiedAt`. */
  earlierStats: number;
};

const PARSER_CASES: ParserCase[] = [
  {
    name: "Claude",
    write: () =>
      writeFile(
        "claude-session.jsonl",
        `${JSON.stringify({
          type: "user",
          timestamp: "2024-03-09T16:00:00.000Z",
          cwd: "/workspace/project",
          message: { role: "user", content: "hello" },
        })}\n`
      ),
    parse: (filePath) => parseSessionFile(filePath),
    earlierStats: 0,
  },
  {
    name: "Codex",
    write: () =>
      writeJsonl(
        makeTempDir("file-created-at-codex-"),
        `rollout-2024-03-09T16-00-00-${CODEX_UUID}.jsonl`,
        minimalCodexRollout(CODEX_UUID, "2024-03-09T16:00:00.000Z", {
          input: 10,
          cached: 0,
          output: 5,
        })
      ),
    parse: (filePath) => parseRolloutFile(filePath),
    earlierStats: 0,
  },
  {
    name: "Cursor",
    write: () =>
      writeJsonl(
        makeTempDir("file-created-at-cursor-"),
        "cursor-session.jsonl",
        [
          {
            timestamp: "2024-03-09T16:00:05.000Z",
            type: "user_message",
            payload: { message: "hello" },
          },
        ]
      ),
    parse: (filePath) => parseTranscriptFile(filePath),
    earlierStats: 0,
  },
  {
    name: "Copilot Chat",
    write: () =>
      writeFile(
        "session.json",
        JSON.stringify({
          sessionId: "copilot-birth",
          requests: [
            {
              timestamp: 1_710_000_000_000,
              message: { text: "hello" },
              response: { markdown: "hi" },
            },
          ],
        })
      ),
    parse: (filePath) => Promise.resolve(parseChatSessionFile(filePath, null)),
    // The size gate before the read.
    earlierStats: 1,
  },
  {
    name: "Copilot CLI",
    write: () =>
      writeFile(
        "events.jsonl",
        `${JSON.stringify({
          type: "user_message",
          timestamp: "2024-03-09T16:00:01.000Z",
          payload: { text: "hello" },
        })}\n`
      ),
    parse: (filePath) => parseCliEventFile(filePath, "cli-birth"),
    earlierStats: 0,
  },
];

describe.each(PARSER_CASES)("$name parser shell", (parserCase) => {
  test("stamps fileCreatedAt and fileModifiedAt from one stat", async () => {
    const filePath = parserCase.write();
    const stat = stubTranscriptStat(filePath, (call) => ({
      birthtimeMs: BIRTH_MS + call,
      mtimeMs: MTIME_MS + call,
    }));
    const session = await parserCase.parse(filePath);
    const statCall = parserCase.earlierStats;
    assert.equal(stat.calls, statCall + 1);
    assert.equal(session?.fileCreatedAt, BIRTH_MS + statCall);
    assert.equal(session?.fileModifiedAt, MTIME_MS + statCall);
  });

  test("omits fileCreatedAt when the birth time is missing", async () => {
    const filePath = parserCase.write();
    stubTranscriptStat(filePath, () => ({
      birthtimeMs: undefined,
      mtimeMs: MTIME_MS,
    }));
    const session = await parserCase.parse(filePath);
    assert.equal(session?.fileModifiedAt, MTIME_MS);
    assert.equal(session && "fileCreatedAt" in session, false);
  });

  test("keeps the parse, without either time, when that stat fails", async () => {
    const filePath = parserCase.write();
    stubTranscriptStat(filePath, (call) =>
      call < parserCase.earlierStats
        ? { birthtimeMs: BIRTH_MS, mtimeMs: MTIME_MS }
        : null
    );
    const session = await parserCase.parse(filePath);
    assert.ok(session);
    assert.equal(session.fileModifiedAt, null);
    assert.equal("fileCreatedAt" in session, false);
  });
});

describe("Copilot Chat startedAt fallback", () => {
  const UNTIMED_CHAT = JSON.stringify({
    sessionId: "copilot-untimed",
    requests: [{ message: { text: "hello" }, response: { markdown: "hi" } }],
  });

  test("uses the birth time when usable", () => {
    const filePath = writeFile("session.json", UNTIMED_CHAT);
    stubTranscriptStat(filePath, () => ({
      birthtimeMs: BIRTH_MS,
      mtimeMs: MTIME_MS,
    }));
    const session = parseChatSessionFile(filePath, null);
    assert.equal(session?.startedAt, new Date(BIRTH_MS).toISOString());
  });

  test("falls back to the mtime, not 1970, on an epoch-0 birth time", () => {
    const filePath = writeFile("session.json", UNTIMED_CHAT);
    stubTranscriptStat(filePath, () => ({ birthtimeMs: 0, mtimeMs: MTIME_MS }));
    const session = parseChatSessionFile(filePath, null);
    assert.equal(session?.startedAt, new Date(MTIME_MS).toISOString());
    assert.equal(session && "fileCreatedAt" in session, false);
  });
});
