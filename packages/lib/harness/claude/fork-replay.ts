/**
 * @file fork-replay.ts
 * @description ISS-8659 — the single test for "this transcript line was replayed
 * verbatim out of a PARENT session by Claude Code's fork feature".
 *
 * DISTINCT from `replayed-entry.ts`, and the two must not be conflated. That one
 * catches a resume/compaction replay WITHIN one file, where the harness rewrites
 * earlier lines and a repeated `uuid` is the marker. A fork replays the parent's
 * records into a DIFFERENT file, so every `uuid` still appears exactly once per
 * file and the uuid test cannot see a fork replay at all. What marks it is the
 * harness's own `forkedFrom` stamp on the record.
 *
 * Measured on the ISS-8659 corpus, the stamp and the replay set coincide
 * exactly: on the `aff9f567` dossier 154 of 154 stamped uuids are also the
 * parent's, and on the largest fork observed, 5,308 of 5,308. So the marker is
 * the whole test and no parent file has to be read — which is what makes the
 * Claude fix strictly cheaper than the Codex one, where
 * `codex-collector.ts` must read the parent rollout to build its
 * `replayedUsageIdentities` set.
 *
 * A replayed record is KEPT and processed, not skipped: it is the fork's
 * inherited conversation, and dropping it would open session detail
 * mid-conversation and break the `readContentByPath` overwrite baseline that a
 * later own `Write` diffs against. It is excluded from the session's TALLIES
 * only — `parse-claude.ts`'s `processRecord` names every gated site.
 *
 * Hand-rolled narrowing rather than Zod, matching `replayed-entry.ts` and for
 * the same reason: this runs per line of a streaming parse over transcripts that
 * reach six figures of lines, and the only question is whether a well-formed
 * stamp is present.
 */
import { asRecord, stringValue } from "../parser-utils";

/** Whether this record is a verbatim replay of a parent session's record. */
export function isForkReplayedRecord(record: Record<string, unknown>): boolean {
  return forkParentSessionId(record) !== null;
}

/**
 * The session this record was replayed out of, or null when it is the fork's own
 * work.
 *
 * BOTH fields the harness writes are required. A stamp carrying only one of them
 * is not a shape this parser has ever seen, and reading a half-formed marker as a
 * fork replay would silently drop a real record out of every tally — a failure
 * that looks exactly like correct exclusion and is invisible in the totals.
 */
export function forkParentSessionId(
  record: Record<string, unknown>
): string | null {
  const forkedFrom = asRecord(record.forkedFrom);
  const sessionId = stringValue(forkedFrom.sessionId);
  return sessionId && stringValue(forkedFrom.messageUuid) ? sessionId : null;
}

/**
 * ISS-12552: a headless fork (`--resume --fork-session`) copies its parent's
 * history into the new file with the session id rewritten and NO `forkedFrom`
 * stamp, so nothing inside the file marks the copy. The caller that can see
 * the parent transcript (Desktop's `parseSessionFile`) supplies the copied
 * entry uuids and, when known, the parent's session id.
 */
export type ClaudeLineageReplay = {
  parentSessionId: string | null;
  entryUuids: ReadonlySet<string>;
};

/** Whether this record is one of the parent's entries a headless fork copied. */
export function isLineageReplayedRecord(
  record: Record<string, unknown>,
  lineage: ClaudeLineageReplay | null
): boolean {
  const uuid = stringValue(record.uuid);
  return lineage !== null && uuid !== null && lineage.entryUuids.has(uuid);
}
