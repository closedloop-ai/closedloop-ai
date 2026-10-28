import { withDb } from "@repo/database";
import { IntegrationTokenOwner } from "@/lib/observability/integration-token-plaintext-telemetry";

// NULL or "": `resolveEncryptedIntegrationToken` treats both as missing, so both
// fail every read closed.
const NO_ACCESS_CIPHERTEXT_WHERE = {
  OR: [{ accessTokenEncrypted: null }, { accessTokenEncrypted: "" }],
};

export type IntegrationTokenOwnerBacklog = {
  owner: IntegrationTokenOwner;
  unencrypted: number;
};

export type IntegrationTokenEncryptionBacklog = {
  unencrypted: number;
  /**
   * Which integration owns the backlog. Derived from an exhaustive record over
   * {@link IntegrationTokenOwner}, so the values are a closed, code-owned set
   * and carry no Datadog label-cardinality hazard.
   */
  byOwner: IntegrationTokenOwnerBacklog[];
};

/**
 * Both integration tables are one row per organization, so these are two small
 * counts rather than a scan worth batching.
 */
export function checkIntegrationTokenEncryption(): Promise<IntegrationTokenEncryptionBacklog> {
  return withDb(async (db) => {
    const [googleUnencrypted, linearUnencrypted] = await Promise.all([
      db.googleIntegration.count({ where: NO_ACCESS_CIPHERTEXT_WHERE }),
      db.linearIntegration.count({ where: NO_ACCESS_CIPHERTEXT_WHERE }),
    ]);

    // EXHAUSTIVE over `IntegrationTokenOwner`, and the emitted array is derived
    // from it rather than hand-listed: a new owner fails `tsc` here until
    // someone states whether it belongs in the backlog, where a list of the two
    // owners that happen to be counted today would have accepted it silently
    // (root `AGENTS.md`, side-inventory rule).
    const backlogByOwner: Record<
      IntegrationTokenOwner,
      IntegrationTokenOwnerBacklog | null
    > = {
      [IntegrationTokenOwner.Google]: {
        owner: IntegrationTokenOwner.Google,
        unencrypted: googleUnencrypted,
      },
      [IntegrationTokenOwner.Linear]: {
        owner: IntegrationTokenOwner.Linear,
        unencrypted: linearUnencrypted,
      },
      // Not gauged, deliberately: see this file's header. Slack is still named
      // by the `integration_token_plaintext_read` event.
      [IntegrationTokenOwner.Slack]: null,
    };
    const byOwner = Object.values(backlogByOwner).filter(
      (entry): entry is IntegrationTokenOwnerBacklog => entry !== null
    );

    return {
      unencrypted: googleUnencrypted + linearUnencrypted,
      byOwner,
    };
  });
}
