import type { OrganizationCommandPublicKey } from "./authorized-public-keys-client.js";
import {
  type ActiveCommandKeyTargetContext,
  type CommandKeyReconciliationReason,
  classifyOrganizationCommandKeysForTarget,
  type OrganizationCommandKeyClassification,
  selectOrganizationCommandKeyForApproval,
} from "./command-key-target-context.js";

type BrowserCommandKeyAppLifecycleOptions = {
  getActiveGatewayId: () => string | undefined;
  log?: (message: string) => void;
};

type FetchAvailableCommandSigningKeys = (options: {
  requireApiKey?: boolean;
  targetContext?: ActiveCommandKeyTargetContext;
}) => Promise<OrganizationCommandPublicKey[]>;

/**
 * Owns DesktopApplication's in-memory browser command-key target identity.
 * Profile/socket lifecycle code must clear this state before any later
 * reconciliation or reserved command decision can observe a stale target.
 */
export class BrowserCommandKeyAppLifecycle {
  private readonly options: BrowserCommandKeyAppLifecycleOptions;
  private activeTargetContext: ActiveCommandKeyTargetContext | undefined;
  private readonly legacyContextlessApprovalFingerprints = new Set<string>();

  constructor(options: BrowserCommandKeyAppLifecycleOptions) {
    this.options = options;
  }

  getActiveTargetContext(): ActiveCommandKeyTargetContext | undefined {
    return this.activeTargetContext;
  }

  setActiveTargetContext(
    computeTargetId: string
  ): ActiveCommandKeyTargetContext {
    const gatewayId = this.options.getActiveGatewayId();
    this.legacyContextlessApprovalFingerprints.clear();
    this.activeTargetContext = {
      computeTargetId,
      ...(gatewayId ? { gatewayId } : {}),
    };
    this.options.log?.(
      `Active browser command key target context set: computeTargetId=${computeTargetId}, gatewayPresent=${Boolean(gatewayId)}`
    );
    return this.activeTargetContext;
  }

  clearTargetContext(reason: string): void {
    const previousContext = this.activeTargetContext;
    this.activeTargetContext = undefined;
    this.legacyContextlessApprovalFingerprints.clear();
    if (!previousContext) {
      return;
    }
    this.options.log?.(
      `Cleared browser command key target context: reason=${reason}, computeTargetId=${previousContext.computeTargetId}`
    );
  }

  rememberLegacyContextlessApproval(fingerprint: string): void {
    this.legacyContextlessApprovalFingerprints.add(fingerprint);
  }

  consumeLegacyContextlessApproval(fingerprint: string): void {
    this.legacyContextlessApprovalFingerprints.delete(fingerprint);
  }

  async fetchOrganizationKeyClassification(input: {
    reason: CommandKeyReconciliationReason;
    fetchAvailableCommandSigningKeys: FetchAvailableCommandSigningKeys;
  }): Promise<OrganizationCommandKeyClassification> {
    const activeContext = this.getActiveTargetContext();
    const keys = await input.fetchAvailableCommandSigningKeys({
      requireApiKey: true,
      targetContext: activeContext,
    });
    return classifyOrganizationCommandKeysForTarget({
      keys,
      activeContext,
      reason: input.reason,
    });
  }

  selectOrganizationCommandKeyForManualApproval(input: {
    keys: OrganizationCommandPublicKey[];
    fingerprint: string;
  }): OrganizationCommandPublicKey | null {
    const activeContext = this.getActiveTargetContext();
    const commandTargetContext = this.legacyContextlessApprovalFingerprints.has(
      input.fingerprint
    )
      ? { kind: "absent" as const }
      : activeContext
        ? { kind: "present" as const, context: activeContext }
        : { kind: "invalid" as const };
    return selectOrganizationCommandKeyForApproval({
      keys: input.keys,
      fingerprint: input.fingerprint,
      activeContext,
      commandTargetContext,
    });
  }
}

/**
 * Clears browser command-key profile state and stops reconciliation for
 * profile/config transitions that do not emit the normal socket disconnect
 * callback.
 */
export function resetBrowserCommandKeyProfileState(input: {
  lifecycle: BrowserCommandKeyAppLifecycle;
  stopReconciliation: () => void;
  reason: string;
}): void {
  input.lifecycle.clearTargetContext(input.reason);
  input.stopReconciliation();
}
