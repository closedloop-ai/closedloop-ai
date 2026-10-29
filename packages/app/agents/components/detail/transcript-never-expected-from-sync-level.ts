import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  dataSyncLevelAllowsTranscripts,
  toDataSyncLevel,
} from "@repo/api/src/types/data-sync-level";

/**
 * @file transcript-never-expected-from-sync-level.ts
 * @description ISS-7516 — fold the served `AgentSessionDetail.dataSyncLevel`
 * into the boolean `SessionTranscriptPanel` already understands.
 *
 * This is the WEB half of ISS-7516. #5713 shipped the render state and the
 * desktop's answer to "is this transcript ever coming?"; it could not answer it
 * on the web, because the level was a device-local setting with no cloud
 * representation. Now that the producing machine's level rides the session
 * payload, the same panel, the same copy, and the same flag serve both surfaces
 * — no second disclosure mechanism, and no second vocabulary.
 *
 * Pure and React-free so the precedence below can be tested directly rather than
 * through a render.
 */

/**
 * Resolve the panel's `transcriptNeverExpected` prop.
 *
 * THREE-VALUED, and the third value is the point. `undefined` means "no evidence
 * either way" and makes the panel render exactly what it renders today; it is
 * NOT a `false`. Collapsing the two would turn every session on a server or
 * desktop build that does not report a level into a positive claim that the
 * transcript is still coming — which is the falsehood this ticket exists to
 * remove, reintroduced one layer up.
 *
 * PRECEDENCE — the served level wins over the shell's answer whenever it is
 * present, and that ordering is load-bearing:
 *
 * - The served level describes the machine that PRODUCED the session, as of its
 *   last sync (see the field's own doc — it is last-write-wins, not a
 *   record-time fact, so a stale stamp is possible and is a known limitation
 *   raised on ISS-7516). The
 *   desktop shell's answer describes the machine the reader is SITTING AT, and
 *   #5713 had to scope it to same-machine sessions precisely because the two are
 *   not the same question. Where both are available the server's is the one that
 *   is about the right device, so it is not merely preferred — the shell's
 *   answer is `false` for a colleague's session whose transcript genuinely is
 *   never coming, and taking `false` there would suppress a true disclosure.
 * - `shellValue` remains the fallback so a desktop talking to an older server —
 *   or reading a session synced before the column existed — keeps the local
 *   answer #5713 shipped rather than silently losing it. That is the version-skew
 *   path, and it degrades to the previous behaviour rather than to nothing.
 *
 * The verdict itself is `dataSyncLevelAllowsTranscripts`, the shared predicate,
 * NOT an inline `=== "full"`. Only `full` queues transcripts, so every other
 * level — including `redacted`, which is easy to misread as "some transcripts" —
 * yields `true` here.
 *
 * THE SERVED VALUE IS NARROWED, NOT TRUSTED (review cid 3840055937). The type
 * says `DataSyncLevel` but the HTTP read only CASTS the parsed JSON, so at
 * runtime this receives whatever the server sent. That matters here more than at
 * most boundaries because the predicate is negative-by-default: every string
 * except `full` yields `true`, so a level this build does not know — a newer
 * server's tier, a corrupt row — would not degrade to "no evidence", it would
 * assert to the reader that a transcript is never coming. `toDataSyncLevel`
 * collapses unrecognized to `undefined`, which falls through to `shellValue` on
 * exactly the same path as an absent level: an unknown answer and no answer are
 * the same amount of evidence, and neither is a verdict.
 */
export function resolveTranscriptNeverExpected(
  session: Pick<AgentSessionDetail, "dataSyncLevel">,
  shellValue: boolean | undefined
): boolean | undefined {
  const servedLevel = toDataSyncLevel(session.dataSyncLevel);
  if (servedLevel === undefined) {
    return shellValue;
  }
  return !dataSyncLevelAllowsTranscripts(servedLevel);
}
