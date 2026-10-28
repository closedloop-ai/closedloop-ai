export type ExternalSyncProvider = "github" | "linear" | "google" | "other";

/**
 * Shared relationship metadata for any artifact content mirrored to an
 * external system. Native content does not carry this relationship and should
 * not render a sync affordance.
 */
export type ExternalSyncRelationship = {
  href?: string;
  label: string;
  provider: ExternalSyncProvider;
  state?: "synced" | "syncing" | "error";
};
