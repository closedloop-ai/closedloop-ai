import type { MemberPackInstallResponse } from "@repo/api/src/types/member-pack-install";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { parseBody } from "@/lib/route-utils";
import { dispatchMemberPackInstall } from "../../member-pack-install-service";
import { memberPackInstallValidator } from "../../validators";

/**
 * POST /compute-targets/:id/member-installs
 *
 * Member self-service pack install (FEA-4082): a WebMember pushes an install of
 * a catalog pack to one of their OWN registered Electron nodes. Authorization
 * (member owns the target, org-scoped) and honest offline/failure state mapping
 * live in `dispatchMemberPackInstall`.
 */
export const POST = withAnyAuth<
  MemberPackInstallResponse,
  "/compute-targets/[id]/member-installs"
>(async ({ user }, request, params) => {
  const { id: targetId } = await params;
  const { body, errorResponse: parseError } = await parseBody(
    request,
    memberPackInstallValidator
  );
  if (parseError || !body) {
    return parseError;
  }

  return dispatchMemberPackInstall({
    targetId,
    packId: body.packId,
    harness: body.harness,
    user,
  });
});
