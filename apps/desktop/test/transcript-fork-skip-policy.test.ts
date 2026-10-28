/**
 * ISS-12552 (PRD-800 "Rollout"): the live-hook token reader skips a
 * fork's inherited history (a stamped `forkedFrom` replay) only under a fork
 * skip, which the hook passes with the attribution policy on. Without one it
 * counts the history, as it did before PRD-800.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, test } from "vitest";
import {
  createTranscriptCache,
  extractTranscriptTokens,
} from "../src/main/database/transcript.js";

const MODEL = "claude-opus-4-5";
const DIR = mkdtempSync(path.join(tmpdir(), "iss12552-fork-skip-"));

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function assistant(uuid: string, input: number, replayed: boolean) {
  return {
    type: "assistant",
    uuid,
    timestamp: "2026-10-20T10:00:00.000Z",
    requestId: `req_${uuid}`,
    ...(replayed
      ? { forkedFrom: { sessionId: "parent-session", messageUuid: uuid } }
      : {}),
    message: {
      id: `msg_${uuid}`,
      model: MODEL,
      usage: { input_tokens: input, output_tokens: 1 },
      content: [{ type: "text", text: "ok" }],
    },
  };
}

const TRANSCRIPT = path.join(DIR, "fork.jsonl");
writeFileSync(
  TRANSCRIPT,
  `${[
    assistant("11111111-1111-4111-8111-111111111111", 100, true),
    assistant("22222222-2222-4222-8222-222222222222", 7, false),
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`
);

describe("the live-hook reader's fork skip", () => {
  test("skips a stamped replay only under a fork skip", () => {
    const skipping = { replayed: undefined };
    assert.equal(
      extractTranscriptTokens(TRANSCRIPT, skipping)?.tokensByModel.get(MODEL)
        ?.input,
      7
    );
    assert.equal(
      extractTranscriptTokens(TRANSCRIPT)?.tokensByModel.get(MODEL)?.input,
      107
    );
  });

  test("a cached read under one skip is not served for the other", () => {
    const cached = createTranscriptCache();
    assert.equal(cached(TRANSCRIPT)?.tokensByModel.get(MODEL)?.input, 107);
    assert.equal(
      cached(TRANSCRIPT, { replayed: undefined })?.tokensByModel.get(MODEL)
        ?.input,
      7
    );
    assert.equal(cached(TRANSCRIPT)?.tokensByModel.get(MODEL)?.input, 107);
  });
});
