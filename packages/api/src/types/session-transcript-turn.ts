/**
 * The transcript's DERIVED render shapes — one discriminated `TurnItem` per row
 * the session transcript panel draws, plus the actor and subagent-body records
 * those rows fold in.
 *
 * Split out of `agent-session.ts` for the
 * same reason as `./session-trace-shape.ts` and `./activity-bucket.ts`, and
 * along the same seam those two established: `agent-session.ts` is the SYNC and
 * PERSISTENCE contract, while these are the presentational shapes a surface
 * renders and nothing ever writes to the wire. `TurnItem` is to the transcript
 * what `SessionPhase`/`SessionSpan` are to the trace.
 *
 * Re-exported from `agent-session.ts` so every existing importer keeps resolving
 * these unchanged.
 */

import type { ToolCats, ToolItem } from "./agent-session-tool-call.ts";
import type { TranscriptTurnIdentity } from "./transcript-turn-identity.ts";

export type TurnActor = {
  name: string | null;
  sessionId: string;
  human: string | null;
  color: string;
  harness?: string | null;
};

export type SubagentBodyLine = {
  kind: "task" | "tool" | "event" | "status";
  text: string;
  t?: string;
  err?: boolean;
};

export type TurnItem =
  | {
      type: "sessionstart";
      t: string;
      actor: TurnActor & {
        machine?: string;
        isNew?: boolean;
        isResumed?: boolean;
        ci?: boolean;
      };
    }
  | {
      type: "prompt";
      _row: number;
      t: string;
      tMs: number;
      cum: number;
      costDelta?: number;
      actor: TurnActor;
      text: string;
      transcriptIdentity?: TranscriptTurnIdentity;
    }
  | {
      type: "say";
      _row: number;
      t: string;
      tMs: number;
      cum: number;
      costDelta?: number;
      actor: TurnActor;
      text: string;
      /** Model that produced this turn, rendered as a muted bubble caption. */
      model?: string | null;
      /** True when this turn is a reasoning/thinking block, not a response. */
      isThinking?: boolean;
      /**
       * ISS-12467: first item of an agent turn whose delimiter (the importer's
       * `TurnDuration` row) is not rendered; the trace must not coalesce it
       * with the turn before.
       */
      turnStart?: boolean;
      transcriptIdentity?: TranscriptTurnIdentity;
    }
  | {
      type: "tools";
      _row: number;
      t: string;
      tMs: number;
      endMs: number;
      cum: number;
      costDelta?: number;
      actor: TurnActor;
      summary: string;
      items: ToolItem[];
      hasFail: boolean;
      failN: number;
      defaultOpen?: boolean;
      cats: ToolCats;
      /** ISS-12467: as on `say`. */
      turnStart?: boolean;
      transcriptIdentity?: TranscriptTurnIdentity;
    }
  | {
      type: "subagent";
      _row: number;
      t: string;
      tMs: number;
      cum: number;
      costDelta?: number;
      actor: TurnActor;
      sub: string;
      subagentType: string | null;
      status: string;
      model: string | null;
      duration: string | null;
      tokens: string | null;
      cost: string | null;
      body: SubagentBodyLine[];
      transcriptIdentity?: TranscriptTurnIdentity;
    }
  | {
      type: "event";
      _row: number;
      t: string;
      tMs: number;
      dot: "g" | "b" | "r";
      text: string;
      tag?: string;
      transcriptIdentity?: TranscriptTurnIdentity;
    }
  | {
      type: "idle";
      /**
       * MILLISECONDS. Unitless in the name for historical reasons, and it went
       * unread until ISS-8652 gave the span a row — so the one producer
       * (`branch-merged-trace-adapter`, `gap: item.gapMs`) settled the unit
       * without anything stating it. Stated here so a second producer does not
       * feed seconds into a row that would then print a 3-minute pause as "3ms".
       */
      gap: number;
    }
  | { type: "end"; text: string };
