/**
 * Deterministic validation failure raised when one stable token transport id
 * names different immutable event content.
 */
export class TokenEventTransportIdentityCollisionError extends Error {
  constructor() {
    super("token_event_transport_identity_collision");
    this.name = "TokenEventTransportIdentityCollisionError";
  }
}
