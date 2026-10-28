/**
 * The terminal `outcome` the Liveblocks route logs once per request
 * (`apps/api/app/webhooks/AGENTS.md`, Logging Conventions).
 */
export const LiveblocksWebhookOutcome = {
  Ignored: "ignored",
  Processed: "processed",
  UnsupportedEvent: "unsupported_event",
} as const;
export type LiveblocksWebhookOutcome =
  (typeof LiveblocksWebhookOutcome)[keyof typeof LiveblocksWebhookOutcome];

/** What a handler for a supported event reports back to the route. */
export type LiveblocksHandlerOutcome =
  | typeof LiveblocksWebhookOutcome.Ignored
  | typeof LiveblocksWebhookOutcome.Processed;
