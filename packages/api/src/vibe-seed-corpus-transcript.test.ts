import { describe, expect, it } from "vitest";
import {
  pickVibeCorpusMainTranscript,
  vibeCorpusTranscriptText,
} from "./vibe-seed-corpus-transcript.ts";

describe("pickVibeCorpusMainTranscript", () => {
  it("finds Claude's `<id>.jsonl` and Codex's `rollout-<stamp>-<id>.jsonl`", () => {
    expect(
      pickVibeCorpusMainTranscript(["claude-1.jsonl", "notes.md"], "claude-1")
    ).toBe("claude-1.jsonl");
    expect(
      pickVibeCorpusMainTranscript(
        ["rollout-2026-08-01T10-00-00-codex-1.jsonl"],
        "codex-1"
      )
    ).toBe("rollout-2026-08-01T10-00-00-codex-1.jsonl");
  });

  it("answers null when the dossier has no JSONL main transcript", () => {
    expect(pickVibeCorpusMainTranscript(["opencode.db"], "open-1")).toBeNull();
  });

  it("refuses to choose between two main transcripts", () => {
    expect(() =>
      pickVibeCorpusMainTranscript(
        ["twin.jsonl", "rollout-x-twin.jsonl"],
        "twin"
      )
    ).toThrow("more than one main transcript");
  });
});

describe("vibeCorpusTranscriptText", () => {
  it("relabels the text to Acme work and moves its instants by the map", () => {
    const raw = `{"timestamp":"2026-08-01T10:00:00.000Z","cwd":"closedloop-ai/closedloop-ai"}\n`;

    expect(
      vibeCorpusTranscriptText(raw, {
        shiftMs: 60_000,
        importStartedAt: "2026-10-07T00:00:00.000Z",
        idleGaps: [],
      })
    ).toBe(
      `{"timestamp":"2026-08-01T10:01:00.000Z","cwd":"acme-co/acme-web"}\n`
    );
  });
});
