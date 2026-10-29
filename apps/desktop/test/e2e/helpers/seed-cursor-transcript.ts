/**
 * @file seed-cursor-transcript.ts
 * @description Write one Cursor background-agent transcript into a CURSOR_HOME,
 * in the layout the real collector discovers.
 *
 * Its own module rather than another concern piled onto `seed.ts`, which frames
 * itself around the two Claude paths (transcripts and the approvals store).
 * Cursor is the cheapest NON-Claude collector to seed for real — a plain JSONL
 * file walked by `collectTranscriptFiles`, with none of Copilot's VS Code
 * storage layout or OpenCode's SQLite batch source — which is what makes it the
 * usable probe for whether a launch's harness homes are actually isolated.
 *
 * The layout is dictated by `main/collectors/cursor/cursor-home.ts`:
 * `<CURSOR_HOME>/projects/<project>/agent-transcripts/<sessionId>/<sessionId>.jsonl`,
 * and `sessionIdFromTranscriptPath` takes the PARENT DIRECTORY name as the id.
 */

import fs from "node:fs";
import path from "node:path";

/** Record types `parseCursorTranscript` folds; anything else is skipped. */
const SESSION_META = "session_meta";
const TURN_CONTEXT = "turn_context";
const USER_MESSAGE = "user_message";
const ASSISTANT_MESSAGE = "assistant_message";

export type CursorTranscriptSeed = {
  /** Transcript directory + file stem; the collector derives the session id from it. */
  sessionId: string;
  /**
   * `session_meta.payload.cwd`. Its BASENAME becomes the session's rendered
   * name (`parse-cursor.ts` derives `name` from the cwd basename), so a caller
   * that wants a recognizable row controls it here.
   */
  cwd: string;
  /** ISO instant for the first record; later records are offset from it. */
  startedAt: string;
};

/**
 * Write one Cursor transcript under `cursorHome` and return its file path.
 *
 * A four-record transcript is the minimum the parser turns into a session: the
 * meta record supplies cwd/version/branch, and at least one timestamped turn is
 * required or `parseCursorTranscript` returns null and the session never exists.
 */
export function seedCursorTranscript(
  cursorHome: string,
  seed: CursorTranscriptSeed,
  project = "e2e-cursor-project"
): string {
  const sessionDir = path.join(
    cursorHome,
    "projects",
    project,
    "agent-transcripts",
    seed.sessionId
  );
  fs.mkdirSync(sessionDir, { recursive: true });

  const started = Date.parse(seed.startedAt);
  const at = (offsetMs: number) => new Date(started + offsetMs).toISOString();
  const lines = [
    {
      type: SESSION_META,
      timestamp: at(0),
      payload: {
        cwd: seed.cwd,
        cursor_version: "0.42.0",
        git: { branch: "main" },
      },
    },
    {
      type: TURN_CONTEXT,
      timestamp: at(500),
      payload: { model: "claude-sonnet-4-6" },
    },
    {
      type: USER_MESSAGE,
      timestamp: at(1000),
      payload: { content: "seeded cursor turn" },
    },
    {
      type: ASSISTANT_MESSAGE,
      timestamp: at(2000),
      payload: { content: "seeded cursor reply" },
    },
  ];

  const transcriptPath = path.join(sessionDir, `${seed.sessionId}.jsonl`);
  fs.writeFileSync(
    transcriptPath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8"
  );
  return transcriptPath;
}
