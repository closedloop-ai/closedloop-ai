import { rewriteVibeCorpusText } from "./vibe-seed-corpus.ts";
import {
  shiftVibeCorpusInstants,
  type VibeCorpusTimeMap,
} from "./vibe-seed-corpus-time.ts";

/**
 * ISS-12135: a golden-corpus session's main transcript as a vibe environment
 * presents it, shared by the web seed (which uploads it) and the vibe Desktop
 * profile (which writes it where the session's transcript sync row says it
 * lives), so both read the same Acme work on the same clock as the store.
 */

const JSONL_EXTENSION = ".jsonl";

/**
 * Which of a dossier's `raw/` file names is the session's main transcript:
 * Claude names it `<id>.jsonl`, Codex `rollout-<stamp>-<id>.jsonl`. Null when
 * there is none (OpenCode keeps its sessions in `opencode.db`); throws when
 * there are two, which would make the choice arbitrary.
 */
export function pickVibeCorpusMainTranscript(
  fileNames: readonly string[],
  externalSessionId: string
): string | null {
  const fileName = `${externalSessionId}${JSONL_EXTENSION}`;
  const matches = fileNames.filter(
    (name) => name === fileName || name.endsWith(`-${fileName}`)
  );
  if (matches.length > 1) {
    throw new Error(
      `golden dossier ${externalSessionId} has more than one main transcript: ${matches.join(", ")}`
    );
  }
  return matches[0] ?? null;
}

/** The transcript text relabeled to Acme work and moved onto the store's clock. */
export function vibeCorpusTranscriptText(
  raw: string,
  timeMap: VibeCorpusTimeMap
): string {
  return shiftVibeCorpusInstants(rewriteVibeCorpusText(raw), timeMap);
}
