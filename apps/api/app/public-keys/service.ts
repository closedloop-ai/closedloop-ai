import type {
  OrganizationPublicKeySummary,
  PublicKeyRegistrationRequest,
  UserPublicKeySummary,
} from "@repo/api/src/types/compute-target";
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
  userId: string;
  isOnline: boolean;
  isSharedWithOrg: boolean;
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
  record: OrganizationPublicKeyRecord
): OrganizationPublicKeySummary {
  return {
    ...toPublicKeySummary(record),
    ownerName: formatOwnerName(record.user),
    ownerEmail: record.user.email,
  };
}

function isAccessibleBrowserKeyNotificationTarget(
  target: BrowserKeyNotificationTargetRecord,
  userId: string
): boolean {
  return (
    target.isOnline && (target.userId === userId || target.isSharedWithOrg)
  );
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
}): Promise<BrowserKeyNotificationTargetRecord[]> {
  const targets = await withDb((db) =>
    db.computeTarget.findMany({
      where: {
        organizationId: input.organizationId,
        isOnline: true,
        OR: [{ userId: input.userId }, { isSharedWithOrg: true }],
      },
      select: {
        id: true,
        userId: true,
        isOnline: true,
        isSharedWithOrg: true,
      },
    })
  );
  return targets.filter((target) =>
    isAccessibleBrowserKeyNotificationTarget(target, input.userId)
  );
}

function buildBrowserKeyNotificationCommandInput(input: {
  kind: BrowserKeyNotificationKind;
  key: UserPublicKeyRecord;
}) {
  const commandInput = {
    publicKeyId: input.key.id,
    userId: input.key.userId,
    fingerprint: input.key.fingerprint,
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
   * Lists same-org browser public keys for active users who can issue signed
   * Desktop commands: direct compute-target owners plus org users when shared
   * targets are available.
   */
  async listOrganizationPublicKeys(
    organizationId: string
  ): Promise<OrganizationPublicKeySummary[]> {
    const rows = await withDb((db) =>
      db.userPublicKey.findMany({
        where: {
          organizationId,
          user: {
            active: true,
            OR: [
              {
                computeTargets: {
                  some: {
                    organizationId,
                  },
                },
              },
              {
                organization: {
                  computeTargets: {
                    some: {
                      organizationId,
                      isSharedWithOrg: true,
                    },
                  },
                },
              },
            ],
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

    return rows.map(toOrganizationPublicKeySummary);
  },
};
