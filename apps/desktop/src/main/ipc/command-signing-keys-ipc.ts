import type { AuthorizedCommandKeyStore } from "../command-signing/authorized-command-key-store.js";
import type { OrganizationCommandPublicKey } from "../command-signing/authorized-public-keys-client.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

export const CommandSigningKeysIpcChannel = {
  ListCommandSigningKeys: "desktop:list-command-signing-keys",
  ListAuthorizedKeys: "desktop:list-authorized-keys",
  AuthorizeKey: "desktop:authorize-key",
  RemoveAuthorizedKey: "desktop:remove-authorized-key",
  ListOrgPublicKeys: "desktop:list-org-public-keys",
  ApproveOrgPublicKey: "desktop:approve-org-public-key",
  RejectOrgPublicKey: "desktop:reject-org-public-key",
  AuthorizeCommandSigningKey: "desktop:authorize-command-signing-key",
  RevokeCommandSigningKey: "desktop:revoke-command-signing-key",
} as const;

export type CommandSigningKeysIpcChannel =
  (typeof CommandSigningKeysIpcChannel)[keyof typeof CommandSigningKeysIpcChannel];

/**
 * The `desktop:list-command-signing-keys` payload the renderer's command-key UI
 * consumes. `listCommandSigningKeys` in app.ts produces this shape; the approve
 * and reject handlers echo the same snapshot after mutating the store.
 */
export type CommandSigningKeysState = {
  available: OrganizationCommandPublicKey[];
  authorized: ReturnType<AuthorizedCommandKeyStore["list"]>;
  rejectedFingerprints: string[];
  serverSupported: boolean;
  enforcementEnabled: boolean;
  availableError?: string;
};

type IpcMainLike = {
  handle: (
    channel: CommandSigningKeysIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type CommandSigningKeysIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  authorizedCommandKeys: AuthorizedCommandKeyStore;
  listCommandSigningKeys: () => Promise<CommandSigningKeysState>;
  notifyCommandKeysChanged: () => void;
  // approve/reject validate the fingerprint internally, so they accept unknown.
  approveOrganizationCommandPublicKey: (
    fingerprint: unknown
  ) => Promise<CommandSigningKeysState>;
  rejectOrganizationCommandPublicKey: (
    fingerprint: unknown
  ) => Promise<CommandSigningKeysState>;
};

/**
 * Owner label precedence for a manually-authorized key: the explicit `label`
 * wins, then `ownerName`, else undefined. (Preserves the original nested-ternary
 * behavior from app.ts without nesting.)
 */
function resolveManualOwnerName(
  input: Record<string, unknown>
): string | undefined {
  if (typeof input.label === "string") {
    return input.label;
  }
  if (typeof input.ownerName === "string") {
    return input.ownerName;
  }
  return undefined;
}

export function registerCommandSigningKeysIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: CommandSigningKeysIpcDeps
): void {
  ipcMainLike.handle(CommandSigningKeysIpcChannel.ListCommandSigningKeys, () =>
    deps.listCommandSigningKeys()
  );
  ipcMainLike.handle(CommandSigningKeysIpcChannel.ListAuthorizedKeys, () =>
    deps.authorizedCommandKeys.list()
  );
  ipcMainLike.handle(
    CommandSigningKeysIpcChannel.AuthorizeKey,
    (event, payload) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("public key payload is required");
      }
      const input = payload as Record<string, unknown>;
      if (typeof input.publicKeyBase64 !== "string") {
        throw new Error("publicKeyBase64 is required");
      }
      deps.authorizedCommandKeys.authorize({
        publicKeyBase64: input.publicKeyBase64,
        ownerName: resolveManualOwnerName(input),
        ownerEmail:
          typeof input.ownerEmail === "string" ? input.ownerEmail : undefined,
        fingerprint:
          typeof input.fingerprint === "string" ? input.fingerprint : undefined,
        source: "manual",
      });
      deps.notifyCommandKeysChanged();
      return deps.authorizedCommandKeys.list();
    }
  );
  ipcMainLike.handle(
    CommandSigningKeysIpcChannel.RemoveAuthorizedKey,
    (event, fingerprint) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      if (typeof fingerprint !== "string" || !fingerprint.trim()) {
        throw new Error("fingerprint is required");
      }
      deps.authorizedCommandKeys.remove(fingerprint);
      deps.notifyCommandKeysChanged();
      return deps.authorizedCommandKeys.list();
    }
  );
  ipcMainLike.handle(
    CommandSigningKeysIpcChannel.ListOrgPublicKeys,
    async () => (await deps.listCommandSigningKeys()).available
  );
  ipcMainLike.handle(
    CommandSigningKeysIpcChannel.ApproveOrgPublicKey,
    (event, fingerprint) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      return deps.approveOrganizationCommandPublicKey(fingerprint);
    }
  );
  ipcMainLike.handle(
    CommandSigningKeysIpcChannel.RejectOrgPublicKey,
    (event, fingerprint) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      return deps.rejectOrganizationCommandPublicKey(fingerprint);
    }
  );
  ipcMainLike.handle(
    CommandSigningKeysIpcChannel.AuthorizeCommandSigningKey,
    (event, fingerprint) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      return deps.approveOrganizationCommandPublicKey(fingerprint);
    }
  );
  ipcMainLike.handle(
    CommandSigningKeysIpcChannel.RevokeCommandSigningKey,
    async (event, fingerprint) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      if (typeof fingerprint !== "string" || !fingerprint.trim()) {
        throw new Error("fingerprint is required");
      }
      deps.authorizedCommandKeys.remove(fingerprint.trim());
      const state = await deps.listCommandSigningKeys();
      deps.notifyCommandKeysChanged();
      return state;
    }
  );
}
