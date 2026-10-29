"use client";

import type {
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import type { BasicUser } from "@repo/api/src/types/user";
import type { NormalizedSession } from "@repo/lib/harness/types";
import { useMemo } from "react";
import { getUserDisplayName } from "../../shared/lib/user-utils";
import {
  humanActorColor,
  withAuthorityHumanActorColor,
} from "../lib/trace-human-actor-color";
import {
  buildTurnItemsFromNormalizedSession,
  type TranscriptActorContext,
} from "../lib/transcript-turn-items";

/**
 * The transcript panel's two candidate row sets and the actor identity both
 * are painted with. Extracted from the panel by ISS-9857 so the union walk
 * could take the same `context` the parsed-transcript projection takes.
 *
 * `humanActor` is the session's creator (ISS-12585; the server trace names the
 * same person). An API that predates `createdBy` omits it, and then the
 * deprecated `user` field stands in. It is memoised on that person alone, and
 * that is load-bearing: the union projection re-runs whenever `context`
 * changes, and its rows feed
 * the row translators the parent stores in state — a fresh object per render
 * would loop that effect.
 */
export function useTranscriptTraceItems(input: {
  session: AgentSessionDetail;
  fallbackItems: readonly TurnItem[] | undefined;
  parsedSession: NormalizedSession | null | undefined;
}): {
  context: TranscriptActorContext;
  projectedItems: readonly TurnItem[] | undefined;
  cloudItems: TurnItem[] | undefined;
  /**
   * ISS-12666: the person `humanActor` names, or null when it is the stand-in
   * ("You") because the session row resolved no one.
   */
  humanUser: BasicUser | null;
} {
  const { session, fallbackItems, parsedSession } = input;
  const actor =
    session.createdBy === undefined ? session.user : session.createdBy;
  const humanActor = useMemo(
    () => ({
      name: actor ? getUserDisplayName(actor) : "You",
      color: humanActorColor(Boolean(actor)),
    }),
    [actor]
  );
  const context = useMemo(
    () => ({
      harness: session.harness,
      primaryModel: session.primaryModel ?? session.model,
      humanActor,
    }),
    [session.harness, session.primaryModel, session.model, humanActor]
  );
  // The DB-projected trace is built by a producer that still stamps its own
  // human-actor colour, so without this the SAME session resolves one colour
  // when its transcript parses and another when it falls back. Re-seat it here
  // rather than at the producer: the seat is a design token this package owns,
  // and `apps/api` cannot reach the authority that decides it.
  const projectedItems = useMemo(
    () => withAuthorityHumanActorColor(fallbackItems, humanActor.color),
    [fallbackItems, humanActor.color]
  );
  const cloudItems = useMemo(
    () =>
      parsedSession
        ? buildTurnItemsFromNormalizedSession(parsedSession, context)
        : undefined,
    [parsedSession, context]
  );
  return {
    context,
    projectedItems,
    cloudItems,
    humanUser: actor ?? null,
  };
}
