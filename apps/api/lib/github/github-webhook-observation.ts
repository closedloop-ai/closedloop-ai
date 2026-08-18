/** Stable per-delivery context used by repository authority producers. */
export type GitHubWebhookObservationContext = {
  deliveryId: string;
  observedAt: Date;
};
