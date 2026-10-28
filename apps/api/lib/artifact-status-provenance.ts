import "server-only";

import {
  ArtifactStatusEditSurface,
  type ArtifactStatusGroupedEditSurface,
  type ArtifactStatusProvenance,
} from "@repo/api/src/types/artifact-status-contract";
import type { ArtifactEditAuthMethod } from "@/lib/auth/artifact-edit-auth-method";

export type { ArtifactEditAuthMethod } from "@/lib/auth/artifact-edit-auth-method";

/**
 * Turns a CLAIMED edit surface into the provenance a receipt may actually carry
 * (ISS-9436).
 *
 * Two things happen here that a validator cannot do on its own:
 *
 * 1. A grouped surface gets its `commitGroupId`. `board` and `bulk` REQUIRE one
 *    (`ArtifactStatusCommitFor`), and nothing in a request body supplies it —
 *    it identifies one server-side commit, so a client could not be trusted to
 *    mint it even if it sent one. A BULK caller passes the transaction id its
 *    audit entries already carry (ISS-9465) rather than letting this mint a
 *    second one: one commit with two group ids is two answers to the same
 *    question, and nothing downstream could reconcile them.
 * 2. A NON-FIRST-PARTY caller's claim is dropped. `surface` names a UI a human
 *    clicked; an `sk_live_*` API key or an MCP agent can put any member of the
 *    taxonomy in the body, and persisting that would let a script manufacture
 *    "board" activity nobody dragged and move a real number onto a bar nobody
 *    clicked. Such a write is UNATTRIBUTED, which is exactly what an absent
 *    provenance already means — the same shape this path emitted before
 *    receipts existed, so nothing about it has to be special-cased downstream.
 */
export function resolveStatusProvenance(params: {
  surface?: ArtifactStatusEditSurface;
  authMethod: ArtifactEditAuthMethod;
  /** The caller's own commit id, when it has one. Minted here otherwise. */
  commitGroupId?: string;
}): ArtifactStatusProvenance | undefined {
  const { surface } = params;
  if (surface === undefined || params.authMethod === "api_key") {
    return;
  }
  if (isGroupedEditSurface(surface)) {
    return {
      surface,
      commitGroupId: params.commitGroupId ?? crypto.randomUUID(),
    };
  }
  return { surface };
}

/**
 * Which surfaces commit more than one row at a time, keyed exhaustively.
 *
 * A `Record` over the whole union rather than a set of the two that are grouped
 * today: a set built from today's members still compiles when a sixth surface
 * is added, and the new member would silently take the single-row branch and
 * persist a grouped receipt with no group. This shape cannot be written without
 * naming every member, so that addition fails `tsc` instead.
 */
const IS_GROUPED_EDIT_SURFACE: Readonly<
  Record<ArtifactStatusEditSurface, boolean>
> = Object.freeze({
  [ArtifactStatusEditSurface.Detail]: false,
  [ArtifactStatusEditSurface.InlineCell]: false,
  [ArtifactStatusEditSurface.Board]: true,
  [ArtifactStatusEditSurface.Bulk]: true,
  [ArtifactStatusEditSurface.RowAction]: false,
});

function isGroupedEditSurface(
  surface: ArtifactStatusEditSurface
): surface is ArtifactStatusGroupedEditSurface {
  return IS_GROUPED_EDIT_SURFACE[surface];
}
