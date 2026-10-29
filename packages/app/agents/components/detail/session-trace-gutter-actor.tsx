"use client";

import type { TurnActor } from "@repo/api/src/types/agent-session";
import type { BasicUser } from "@repo/api/src/types/user";
import { BranchTraceActorAvatar } from "@repo/app/branches/components/branch-trace-actor-avatar";
import { useCallback } from "react";
import type { GutterActorRenderer } from "./session-trace-row-contract";

/**
 * ISS-12666: the standalone Session trace's per-turn actor avatar, the same
 * `BranchTraceActorAvatar` the Branch combined trace renders in this gutter.
 *
 * A human turn names the session's creator only when the session row resolved
 * one. Otherwise the producer stamps a stand-in ("You" on the web, the Desktop
 * local-session label), and the avatar must not present that as a person, so
 * the actor is cleared and the avatar falls back to the Branch trace's own
 * unattributed state. Agent turns keep their model, else harness, identity.
 */
export function sessionTraceGutterActor(
  actor: TurnActor,
  humanResolved: boolean
): TurnActor {
  if (actor.human == null || humanResolved) {
    return actor;
  }
  return { ...actor, harness: null, human: null, name: null };
}

/**
 * The gutter renderer for one session's trace. Only the resolved creator's
 * turns carry their photo; every other avatar is one initial on the shared
 * avatar colours (Nerys, 2026-10-22), so no actor colour domain is needed.
 */
export function useSessionTraceGutterActor(
  humanUser: BasicUser | null
): GutterActorRenderer {
  const humanResolved = humanUser != null;
  const humanImageUrl = humanUser?.avatarUrl ?? null;
  return useCallback(
    (actor: TurnActor) => {
      const shown = sessionTraceGutterActor(actor, humanResolved);
      return (
        <BranchTraceActorAvatar
          actor={shown}
          imageUrl={shown.human == null ? null : humanImageUrl}
        />
      );
    },
    [humanResolved, humanImageUrl]
  );
}
