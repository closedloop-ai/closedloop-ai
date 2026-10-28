"use client";

import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { QueryClientContext } from "@tanstack/react-query";
import { useContext } from "react";
import { useCurrentUser } from "../../users/hooks/use-users";
import {
  AgentSessionCapability,
  agentSessionSourceSupports,
} from "../data-source/agent-sessions-data-source";
import { useAgentSessionsDataSourceOptional } from "../data-source/provider";
import {
  type SessionRenameSubject,
  sessionNameIsEditableBy,
} from "../lib/session-name-editable";
import { useRenameSession } from "./use-rename-session";

/**
 * ISS-8718 — the ONE gate deciding whether a viewer is offered inline rename
 * for a session, shared by the Sessions list lead cell and Session detail so
 * the two cannot disagree. A session renameable in the list and not on its own
 * detail page is the cross-surface inconsistency `packages/app/AGENTS.md`
 * forbids, and two copies of the gate drift on the first change to either.
 *
 * ## No feature flag
 *
 * Operator ruling, 2026-10-01: this ships enabled. The closed-by-default UI
 * policy (ISS-4779 / ISS-10348) requires a gate for a net-new surface, screen or
 * nav item, and this is none of those — it adds a control to the Sessions list
 * and to Session detail, both of which already ship. ISS-8718's body asks for a
 * default-off PostHog key; the operator's present instruction supersedes it, and
 * the ticket has NOT been edited to match (that would be a spec this agent does
 * not own). The disagreement is a finding for whoever grooms ISS-8718.
 *
 * ## Why it is TWO hooks and not one
 *
 * The second stage reads `GET /me` through `useApiClient`, which THROWS without
 * an `<AuthAdapterProvider>` — at hook-call time, so `enabled: false` does not
 * save it. A single hook therefore crashed every mount that has no providers:
 * a bare table render, a mini-table test, Storybook. Measured, not assumed —
 * collapsing the two is what the "no data source can write" case caught.
 *
 * So the caller mounts stage two in a child component, behind stage one:
 *
 *   const ready = useSessionRenamePreconditions(session.id);
 *   if (!ready) return <PlainName />;
 *   return <Editable … />;   // this child calls useSessionRenameOwnerGate
 *
 * Both stages live here, so the logic is shared even though the mount is
 * two-step.
 */

/**
 * Stage one: everything answerable without auth or an API client.
 *
 *  - the active data source offers `renameSession`. A source that cannot write
 *    offers no verb, and a control that cannot commit must not be offered. This
 *    is also what makes OFFLINE DESKTOP correct rather than broken: the local
 *    SQLite source has no rename verb, so the signed-out/offline/sync-off
 *    renderer shows the name exactly as it does today. Operator ruling,
 *    2026-10-01: not offering rename offline is acceptable, so the local write
 *    chain is deliberately not built.
 *  - a query client exists to settle the write in (a bare render, Storybook).
 */
export function useSessionRenamePreconditions(sessionId: string): boolean {
  const source = useAgentSessionsDataSourceOptional();
  const hasQueryClient = useContext(QueryClientContext) !== undefined;
  return Boolean(
    source?.renameSession &&
      agentSessionSourceSupports(
        source,
        sessionId,
        AgentSessionCapability.Rename
      ) &&
      hasQueryClient
  );
}

/**
 * Stage two: ownership, plus the mutation to commit through. Call ONLY behind
 * {@link useSessionRenamePreconditions} — it reads `GET /me`, cached under one
 * key with a 5-minute `staleTime` so a page of rows shares a single request
 * rather than one apiece.
 *
 * `sessionNameIsEditableBy` says why an org admin is not offered the control
 * despite the API admitting one.
 */
export function useSessionRenameOwnerGate(
  session: SessionRenameSubject,
  surface: ArtifactStatusEditSurface
): {
  canRename: boolean;
  rename: ReturnType<typeof useRenameSession>;
} {
  const viewer = useCurrentUser();
  const rename = useRenameSession(surface);
  return {
    canRename: sessionNameIsEditableBy(session, viewer.data?.id),
    rename,
  };
}
