import { buildUserColor } from "@repo/api/src/agent-session-user-color";
import type { BasicUser } from "@repo/api/src/types/user";
import type { SharedAgentSessionListItem } from "../../shared/shared-agent-sessions-contract.js";
import { resolveOwner } from "./org-directory-cache.js";

/**
 * The local list item's people fields, all from the session's one local
 * `user_id` resolved against the cloud org directory snapshot, so the Owner
 * cell's identity and its dot color (`buildUserColor`, FEA-3456) come from the
 * same read.
 *
 * ISS-12251 D-7: on Desktop's local read the Owner is the session's creator, so
 * `assignee` and `createdBy` are both that user, as the cloud ingest create arm
 * sets both to the uploading user. Desktop has no assignee feed, so a session
 * reassigned through the API still reads its creator here (AC-011's exception).
 * An id the directory cannot resolve (not loaded yet, or unknown) serves `user`
 * as null and omits `assignee` and `createdBy`: a `null` assignee is an
 * unassigned session to the shared Owner resolver, which this is not.
 */
export function buildLocalSessionPeople(
  userId: string | null | undefined,
  orgDirectory: ReadonlyMap<string, BasicUser>
): Pick<
  SharedAgentSessionListItem,
  "assignee" | "createdBy" | "user" | "userColor"
> {
  const owner = resolveOwner(userId, orgDirectory);
  return {
    user: owner,
    userColor: buildUserColor(owner),
    ...(owner ? { assignee: owner, createdBy: owner } : {}),
  };
}
