/**
 * ISS-12032: the gatewayId this socket's last hello declared, and the repair
 * for a hello that declared none.
 *
 * The cloud stamps whatever gatewayId a hello carries onto the compute target
 * and clears it when a hello omits it, so a desktop whose signing key was
 * unavailable at hello time is left with no gatewayId on its row. Once an id
 * resolves again, re-sending the hello is what restores it.
 *
 * `resendHello` reports whether it sent. The cloud handles a repeat hello as a
 * reconnect and requeues every command outside its replay slice, so the socket
 * refuses while commands are in flight and the refresh simply tries again.
 */
export class HelloGatewayIdTracker {
  private declared: string | undefined;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly getGatewayId: (() => string | null) | undefined;
  private readonly resendHello: () => boolean;

  constructor(deps: {
    getGatewayId: (() => string | null) | undefined;
    resendHello: () => boolean;
  }) {
    this.getGatewayId = deps.getGatewayId;
    this.resendHello = deps.resendHello;
  }

  /** Resolves and records the id the hello about to be sent declares. */
  resolveForHello(): string | undefined {
    this.clearRefresh();
    this.declared = this.getGatewayId?.() ?? undefined;
    return this.declared;
  }

  /** The id the last hello declared; undefined when it declared none. */
  getDeclared(): string | undefined {
    return this.declared;
  }

  /** Arms the repair when the acknowledged hello declared no gatewayId. */
  onHelloAck(): void {
    if (this.declared !== undefined || !this.getGatewayId) {
      return;
    }
    this.scheduleRefresh();
  }

  reset(): void {
    this.clearRefresh();
    this.declared = undefined;
  }

  private scheduleRefresh(): void {
    this.clearRefresh();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.getGatewayId?.() && this.resendHello()) {
        return;
      }
      this.scheduleRefresh();
    }, HELLO_GATEWAY_REFRESH_INTERVAL_MS);
  }

  private clearRefresh(): void {
    if (!this.refreshTimer) {
      return;
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }
}

export const HELLO_GATEWAY_REFRESH_INTERVAL_MS = 5 * 60_000;
