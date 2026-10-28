export const CloudSocketState = {
  Degraded: "degraded",
  /**
   * ISS-4715: cloud egress is OFF BY CHOICE — the user switched the connection
   * off, or the build runs in golden mode. Distinct from {@link Degraded} on
   * purpose: degraded means the cloud was asked to work and did not, which is a
   * fault worth a user's attention, while this is the product doing exactly
   * what it was told. Collapsing the two made the startup readiness panel latch
   * `NeedsAttention` — permanently, since it only clears on `Ready` — for every
   * install with cloud sync turned off.
   *
   * It is not the absence of a state either: the cloud row still SAYS the
   * connection is off. Off is a fact about the product, and stating it quietly
   * is the point; `Idle` would claim a connection that is merely between
   * attempts.
   */
  Disabled: "disabled",
  Idle: "idle",
  Online: "online",
} as const;

export type CloudSocketState =
  (typeof CloudSocketState)[keyof typeof CloudSocketState];

export const CloudSocketError = {
  /**
   * ISS-11843: the cloud refused the device handshake and the desktop stopped
   * reconnecting. Copy is the operator's ruling verbatim (Marisol Ashgrove,
   * 2026-10-05, ISS-11843 thread).
   */
  HandshakeRefused: "unable to connect to server",
  DecryptionFailed:
    "Stored API key could not be decrypted — re-enter the key in Settings",
  MissingApiKey: "Missing API key for cloud socket connection",
} as const;

/**
 * ISS-11843: why a `degraded` status is degraded, when the cause is one a
 * surface acts on. Optional on the wire: a status without it is an ordinary
 * degraded connection.
 */
export const CloudSocketDegradedReason = {
  /** The cloud keeps closing the handshake without a nack; reconnects stopped. */
  HandshakeRefused: "handshake_refused",
} as const;

export type CloudSocketDegradedReason =
  (typeof CloudSocketDegradedReason)[keyof typeof CloudSocketDegradedReason];
