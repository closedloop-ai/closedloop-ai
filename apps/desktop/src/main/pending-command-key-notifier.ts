import type { OrganizationCommandPublicKey } from "./authorized-public-keys-client.js";

export type PendingCommandKeyNotificationKey = Pick<
  OrganizationCommandPublicKey,
  "fingerprint" | "ownerEmail" | "ownerName"
>;

export type PendingCommandKeyNotificationOptions = {
  title: string;
  body: string;
  actions?: Array<{ type: "button"; text: string }>;
};

export type PendingCommandKeyNotification = {
  on(event: "action", listener: (_event: unknown, index: number) => void): void;
  on(event: "close" | "click", listener: () => void): void;
  close(): void;
  show(): void;
};

type PendingCommandKeyNotifierOptions = {
  getPendingKeys: () => Promise<OrganizationCommandPublicKey[]>;
  createNotification: (
    options: PendingCommandKeyNotificationOptions
  ) => PendingCommandKeyNotification;
  supportsActions: () => boolean;
  onOpenSettings: () => void;
  onApprove: (fingerprint: string) => Promise<void> | void;
  onDecline: (fingerprint: string) => Promise<void> | void;
  onChanged: () => void;
  log?: (message: string) => void;
};

/**
 * Shows one Desktop-session notification per newly pending browser command key
 * fingerprint after the relay confirms command-signing protocol support.
 */
export class PendingCommandKeyNotifier {
  private readonly options: PendingCommandKeyNotifierOptions;
  private readonly notifiedFingerprints = new Set<string>();
  private readonly activeSingleKeyNotifications = new Map<
    string,
    PendingCommandKeyNotification
  >();

  constructor(options: PendingCommandKeyNotifierOptions) {
    this.options = options;
  }

  async notifyPendingKeys(
    prefetchedPendingKeys?: PendingCommandKeyNotificationKey[]
  ): Promise<void> {
    let pendingKeys: PendingCommandKeyNotificationKey[];
    if (prefetchedPendingKeys) {
      pendingKeys = prefetchedPendingKeys;
    } else {
      try {
        pendingKeys = await this.options.getPendingKeys();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "failed to fetch pending keys";
        this.options.log?.(
          `Skipping pending command key notification: ${message}`
        );
        return;
      }
    }

    const newKeys = pendingKeys.filter(
      (key) => !this.notifiedFingerprints.has(key.fingerprint)
    );
    if (newKeys.length === 0) {
      return;
    }

    for (const key of newKeys) {
      this.notifiedFingerprints.add(key.fingerprint);
    }

    const singlePendingKey = pendingKeys.length === 1 ? pendingKeys[0] : null;
    const notification = this.options.createNotification({
      title:
        newKeys.length === 1
          ? "Browser command key awaiting approval"
          : "Browser command keys awaiting approval",
      body:
        newKeys.length === 1
          ? `${displayKeyOwner(newKeys[0])} registered a browser command key.`
          : `${newKeys.length} browser command keys are awaiting Desktop approval.`,
      ...(singlePendingKey && this.options.supportsActions()
        ? {
            actions: [
              { type: "button" as const, text: "Approve" },
              { type: "button" as const, text: "Decline" },
            ],
          }
        : {}),
    });

    let actionInvoked = false;
    notification.on("click", () => {
      if (actionInvoked) {
        actionInvoked = false;
        return;
      }
      this.options.onOpenSettings();
    });
    if (singlePendingKey) {
      this.trackSingleKeyNotification(
        singlePendingKey.fingerprint,
        notification
      );
      notification.on("action", (_event, index) => {
        actionInvoked = true;
        void this.handleSingleKeyAction(singlePendingKey.fingerprint, index);
      });
    }
    notification.show();
  }

  /**
   * Closes an active one-fingerprint notification after that fingerprint is
   * resolved through the API-backed approve/reject path.
   */
  dismiss(fingerprint: string): void {
    const trimmedFingerprint = fingerprint.trim();
    if (!trimmedFingerprint) {
      return;
    }
    const notification =
      this.activeSingleKeyNotifications.get(trimmedFingerprint);
    if (!notification) {
      return;
    }
    this.activeSingleKeyNotifications.delete(trimmedFingerprint);
    notification.close();
  }

  private trackSingleKeyNotification(
    fingerprint: string,
    notification: PendingCommandKeyNotification
  ): void {
    this.activeSingleKeyNotifications.set(fingerprint, notification);
    notification.on("close", () => {
      if (this.activeSingleKeyNotifications.get(fingerprint) === notification) {
        this.activeSingleKeyNotifications.delete(fingerprint);
      }
    });
  }

  private async handleSingleKeyAction(
    fingerprint: string,
    index: number
  ): Promise<void> {
    try {
      if (index === 0) {
        await this.options.onApprove(fingerprint);
        this.dismiss(fingerprint);
        this.options.onChanged();
      } else if (index === 1) {
        await this.options.onDecline(fingerprint);
        this.dismiss(fingerprint);
        this.options.onChanged();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "command key action failed";
      this.options.log?.(
        `Pending command key notification action failed: ${message}`
      );
      this.options.onChanged();
    }
  }
}

function displayKeyOwner(key: PendingCommandKeyNotificationKey): string {
  return key.ownerEmail || key.ownerName || key.fingerprint;
}
