import { AuditAction, AuditObjectType } from "@repo/api/src/types/audit";
import {
  dispatchAuditEvent,
  userAuditActor,
} from "@/app/audit/audit-emit-service";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
} from "@/lib/route-utils";
import { apiKeysService } from "../service";

export const DELETE = withAuth<{ deleted: true }, "/api-keys/[id]">(
  async ({ user, orgRole }, _, params) => {
    try {
      const { id } = await params;
      const revoked = await apiKeysService.revoke(
        id,
        user.organizationId,
        user.id,
        orgRole
      );

      if (!revoked) {
        return notFoundResponse("API key");
      }

      // Record the key revocation on the tamper-evident audit ledger (FEA-3862).
      // Non-blocking/best-effort; only the key id is recorded, no secret.
      dispatchAuditEvent({
        organizationId: user.organizationId,
        actor: userAuditActor(user.id),
        action: AuditAction.ApiKeyRevoked,
        objectType: AuditObjectType.ApiKey,
        objectId: id,
      });

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to revoke API key", error);
    }
  }
);
