import type {
  BrowserKeyTargetContext,
  OrganizationPublicKeySummary,
  PublicKeyRegistrationRequest,
  UserPublicKeySummary,
} from "@repo/api/src/types/compute-target";
import { BrowserKeyTargetAccess } from "@repo/api/src/types/compute-target";
import {
  type Result as DomainResult,
  Result,
} from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  dispatchRelayCommandToRelay,
  toRelayOperation,
} from "@/app/compute-targets/relay-command-helpers";
import { validateCommandPublicKeyRegistration } from "@/lib/auth/command-signing-crypto";
import {
  buildBrowserKeyApprovalRequestCommandInput,
  buildBrowserKeyRevocationCommandInput,
} from "@/lib/browser-key-revocation-command";
import { desktopCommandStore } from "@/lib/desktop-command-store";

export type PublicKeyRegistrationError =
  | "malformed_public_key"
  | "fingerprint_mismatch"
  | "unsupported_public_key";

type UserPublicKeyRecord = {
  id: string;
  userId: string;
  organizationId: string;
  publicKeyBase64: string;
  fingerprint: string;
  createdAt: Date;
};

type OrganizationPublicKeyRecord = UserPublicKeyRecord & {
  user: {
    email: string;
    firstName: string | null;
    lastName: string | null;
  };
};

type BrowserKeyNotificationTargetRecord = {
  id: string;
  gatewayId: string | null;
};

type BrowserKeyNotificationKind = "approval_request" | "revocation";

const browserKeyNotificationLogNames: Record<
  BrowserKeyNotificationKind,
  {
    notDelivered: string;
    dispatchFailed: string;
    targetLookupFailed: string;
  }
> = {
  approval_request: {
    notDelivered: "browser_key_approval_request_not_delivered",
    dispatchFailed: "browser_key_approval_request_dispatch_failed",
    targetLookupFailed: "browser_key_approval_request_target_lookup_failed",
  },
  revocation: {
    notDelivered: "browser_key_revocation_not_delivered",
    dispatchFailed: "browser_key_revocation_dispatch_failed",
    targetLookupFailed: "browser_key_revocation_target_lookup_failed",
  },
};

function toPublicKeySummary(record: UserPublicKeyRecord): UserPublicKeySummary {
  return {
    id: record.id,
    userId: record.userId,
    organizationId: record.organizationId,
    publicKeyBase64: record.publicKeyBase64,
    fingerprint: record.fingerprint,
    createdAt: record.createdAt.toISOString(),
  };
}

function formatOwnerName(
  user: Pick<
    OrganizationPublicKeyRecord["user"],
    "email" | "firstName" | "lastName"
  >
): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email;
}

function toOrganizationPublicKeySummary(
  record: OrganizationPublicKeyRecord,
  targetContext?: BrowserKeyTargetContext
): OrganizationPublicKeySummary {
  const summary: OrganizationPublicKeySummary = {
    ...toPublicKeySummary(record),
    ownerName: formatOwnerName(record.user),
    ownerEmail: record.user.email,
  };
  if (targetContext) {
    summary.targetContext = targetContext;
  }
  return summary;
}

function deleteOwnedPublicKeyForRevocation(input: {
  userId: string;
  organizationId: string;
  fingerprint: string;
}): Promise<UserPublicKeyRecord | null> {
  return withDb.tx(async (db) => {
    const row = await db.userPublicKey.findFirst({
      where: {
        userId: input.userId,
        organizationId: input.organizationId,
        fingerprint: input.fingerprint,
      },
    });
    if (!row) {
      return null;
    }

    const deleted = await db.userPublicKey.deleteMany({
      where: {
        id: row.id,
        userId: input.userId,
        organizationId: input.organizationId,
        fingerprint: row.fingerprint,
      },
    });
    return deleted.count > 0 ? row : null;
  });
}

async function listAccessibleBrowserKeyNotificationTargets(input: {
  userId: string;
  organizationId: string;
  kind?: BrowserKeyNotificationKind;
}): Promise<BrowserKeyNotificationTargetRecord[]> {
  const targets = await withDb((db) =>
    db.computeTarget.findMany({
      where: {
        organizationId: input.organizationId,
        isOnline: true,
        userId: input.userId,
      },
      select: {
        id: true,
        gatewayId: true,
      },
    })
  );
  log.info("browser_key_notification_targets_scoped", {
    kind: input.kind,
    requesterUserId: input.userId,
    organizationId: input.organizationId,
    targetCount: targets.length,
    ownerOnly: true,
  });
  return targets;
}

function buildBrowserKeyNotificationCommandInput(input: {
  kind: BrowserKeyNotificationKind;
  key: UserPublicKeyRecord;
  target: BrowserKeyNotificationTargetRecord;
}) {
  const commandInput = {
    publicKeyId: input.key.id,
    userId: input.key.userId,
    fingerprint: input.key.fingerprint,
    computeTargetId: input.target.id,
    gatewayId: input.target.gatewayId,
  };

  if (input.kind === "approval_request") {
    return buildBrowserKeyApprovalRequestCommandInput(commandInput);
  }

  return buildBrowserKeyRevocationCommandInput(commandInput);
}

async function notifyTargetOfBrowserKeyCommand(input: {
  kind: BrowserKeyNotificationKind;
  target: BrowserKeyNotificationTargetRecord;
  key: UserPublicKeyRecord;
}): Promise<void> {
  const logNames = browserKeyNotificationLogNames[input.kind];
  try {
    const commandInput = buildBrowserKeyNotificationCommandInput({
      kind: input.kind,
      key: input.key,
      target: input.target,
    });
    const createResult = await desktopCommandStore.createCommand(
      input.target.id,
      commandInput
    );
    const commandId = createResult.command.commandId;
    const relayOperation = toRelayOperation(commandId, commandInput);
    const dispatchResult = await dispatchRelayCommandToRelay({
      targetId: input.target.id,
      commandId,
      relayOperation,
      requestId: crypto.randomUUID(),
    });
    if (!dispatchResult.delivered) {
      log.warn(logNames.notDelivered, {
        computeTargetId: input.target.id,
        commandId,
        publicKeyId: input.key.id,
        fingerprint: input.key.fingerprint,
        reason: dispatchResult.reason,
      });
    }
  } catch (error) {
    log.warn(logNames.dispatchFailed, {
      computeTargetId: input.target.id,
      publicKeyId: input.key.id,
      fingerprint: input.key.fingerprint,
      error,
    });
  }
}

async function notifyBrowserKeyTargets(input: {
  kind: BrowserKeyNotificationKind;
  userId: string;
  organizationId: string;
  key: UserPublicKeyRecord;
}): Promise<void> {
  const targets = await listAccessibleBrowserKeyNotificationTargets(input);
  await Promise.all(
    targets.map((target) =>
      notifyTargetOfBrowserKeyCommand({
        kind: input.kind,
        target,
        key: input.key,
      })
    )
  );
}

function toBrowserKeyTargetContext(target: {
  id: string;
  gatewayId: string | null;
}): BrowserKeyTargetContext {
  const context: BrowserKeyTargetContext = {
    computeTargetId: target.id,
    access: BrowserKeyTargetAccess.OwnedTarget,
  };
  if (target.gatewayId) {
    context.gatewayId = target.gatewayId;
  }
  return context;
}

async function findOwnedBrowserKeyTargetContext(input: {
  organizationId: string;
  requesterUserId: string;
  computeTargetId: string;
  gatewayId?: string;
}): Promise<BrowserKeyTargetContext | null> {
  const target = await withDb((db) =>
    db.computeTarget.findFirst({
      where: {
        id: input.computeTargetId,
        organizationId: input.organizationId,
        userId: input.requesterUserId,
      },
      select: {
        id: true,
        gatewayId: true,
      },
    })
  );
  if (!target) {
    log.info("browser_key_public_keys_target_scope_rejected", {
      organizationId: input.organizationId,
      requesterUserId: input.requesterUserId,
      computeTargetId: input.computeTargetId,
      gatewayProvided: input.gatewayId !== undefined,
      reason: "target_not_owned",
    });
    return null;
  }

  if (input.gatewayId !== undefined) {
    const gatewayMatches = target.gatewayId === input.gatewayId;
    if (!gatewayMatches) {
      log.info("browser_key_public_keys_target_scope_rejected", {
        organizationId: input.organizationId,
        requesterUserId: input.requesterUserId,
        computeTargetId: input.computeTargetId,
        gatewayProvided: true,
        targetHasGateway: target.gatewayId !== null,
        reason: "gateway_mismatch",
      });
      return null;
    }
  }

  return toBrowserKeyTargetContext(target);
}

function listRequesterPublicKeys(input: {
  organizationId: string;
  requesterUserId: string;
}): Promise<OrganizationPublicKeyRecord[]> {
  return withDb((db) =>
    db.userPublicKey.findMany({
      where: {
        organizationId: input.organizationId,
        userId: input.requesterUserId,
        user: {
          active: true,
        },
      },
      include: {
        user: {
          select: {
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }],
    })
  );
}

export const publicKeysService = {
  /**
   * Registers an authenticated user's browser command-signing public key.
   * Duplicate `(userId, fingerprint)` submissions return the existing row.
   */
  async registerUserPublicKey(input: {
    userId: string;
    organizationId: string;
    payload: PublicKeyRegistrationRequest;
  }): Promise<DomainResult<UserPublicKeySummary, PublicKeyRegistrationError>> {
    const publicKey = validateCommandPublicKeyRegistration(input.payload);
    if (!publicKey.ok) {
      return Result.err(publicKey.reason);
    }

    const row = await withDb((db) =>
      db.userPublicKey.upsert({
        where: {
          userId_fingerprint: {
            userId: input.userId,
            fingerprint: publicKey.fingerprint,
          },
        },
        create: {
          userId: input.userId,
          organizationId: input.organizationId,
          publicKeyBase64: input.payload.publicKeyBase64.trim(),
          fingerprint: publicKey.fingerprint,
        },
        update: {
          publicKeyBase64: input.payload.publicKeyBase64.trim(),
        },
      })
    );

    try {
      await notifyBrowserKeyTargets({
        kind: "approval_request",
        userId: input.userId,
        organizationId: input.organizationId,
        key: row,
      });
    } catch (error) {
      log.warn(
        browserKeyNotificationLogNames.approval_request.targetLookupFailed,
        {
          publicKeyId: row.id,
          fingerprint: row.fingerprint,
          error,
        }
      );
    }

    return Result.ok(toPublicKeySummary(row));
  },

  /**
   * Unregisters a browser command-signing public key for the authenticated
   * user. Missing rows are treated as already unregistered so browser reset
   * flows remain idempotent.
   */
  async unregisterUserPublicKey(input: {
    userId: string;
    organizationId: string;
    fingerprint: string;
  }): Promise<{ deleted: boolean }> {
    const deletedKey = await deleteOwnedPublicKeyForRevocation(input);
    if (!deletedKey) {
      return { deleted: false };
    }

    try {
      await notifyBrowserKeyTargets({
        kind: "revocation",
        userId: input.userId,
        organizationId: input.organizationId,
        key: deletedKey,
      });
    } catch (error) {
      log.warn(browserKeyNotificationLogNames.revocation.targetLookupFailed, {
        publicKeyId: deletedKey.id,
        fingerprint: deletedKey.fingerprint,
        error,
      });
    }

    return { deleted: true };
  },

  /**
   * Lists browser public keys visible to the authenticated requester. Target
   * scoped listing is owner-only; shared compute targets are intentionally not
   * browser-key trust targets.
   */
  async listOrganizationPublicKeys(input: {
    organizationId: string;
    requesterUserId: string;
    computeTargetId?: string;
    gatewayId?: string;
  }): Promise<OrganizationPublicKeySummary[]> {
    const targetContext = input.computeTargetId
      ? await findOwnedBrowserKeyTargetContext({
          organizationId: input.organizationId,
          requesterUserId: input.requesterUserId,
          computeTargetId: input.computeTargetId,
          gatewayId: input.gatewayId,
        })
      : undefined;

    if (input.computeTargetId && !targetContext) {
      return [];
    }

    const rows = await listRequesterPublicKeys(input);
    log.debug("browser_key_public_keys_list_scoped", {
      organizationId: input.organizationId,
      requesterUserId: input.requesterUserId,
      computeTargetId: input.computeTargetId,
      targetScoped: targetContext !== undefined,
      gatewayProvided: input.gatewayId !== undefined,
      returnedCount: rows.length,
    });

    return rows.map((row) =>
      toOrganizationPublicKeySummary(row, targetContext || undefined)
    );
  },
};
