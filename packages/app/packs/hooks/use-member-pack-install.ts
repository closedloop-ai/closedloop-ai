"use client";

import type {
  MemberPackInstallRequest,
  MemberPackInstallResponse,
} from "@repo/api/src/types/member-pack-install";
import { useMutation } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * Member self-service pack install (ISS-5125, dispatching the FEA-4082 route).
 *
 * `POST /compute-targets/{targetId}/member-installs` — pushes an install of one
 * catalog pack, for one harness, to ONE of the member's OWN registered nodes.
 * The API authorizes ownership (`computeTargetsService.findOwnedById`, owner-only
 * and org-scoped, no org-share fallback), so this hook adds no client-side
 * permission logic of its own: a member who does not own the node gets a 404
 * from the server, not a hidden button that pretends the node isn't theirs.
 *
 * ## Why no `onSuccess` cache invalidation
 *
 * A resolved dispatch is NOT a completed install. Every non-`Failed` outcome
 * means the node has (or may have) taken the command and will report terminal
 * on-device state later over its own command-event stream. Invalidating the
 * per-machine read the moment the POST resolves would refetch state that
 * provably cannot have changed yet and repaint the row back to `NotInstalled`,
 * telling the member their install did not happen. The caller owns when to
 * re-read; this hook only reports what the dispatch itself proved.
 */

/** What the caller supplies to dispatch one install. */
export type MemberPackInstallInput = MemberPackInstallRequest & {
  /** The member's own compute target (registered machine) to install onto. */
  computeTargetId: string;
};

export function useMemberPackInstall() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      computeTargetId,
      packId,
      harness,
    }: MemberPackInstallInput) =>
      apiClient.post<MemberPackInstallResponse>(
        `/compute-targets/${computeTargetId}/member-installs`,
        { packId, harness } satisfies MemberPackInstallRequest
      ),
  });
}
