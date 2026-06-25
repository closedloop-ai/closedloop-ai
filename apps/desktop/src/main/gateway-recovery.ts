export type GatewayRecoveryDeps = {
  probe: () => Promise<boolean>;
  restart: () => Promise<void>;
  getCloudStatus: () => { state: string };
  setConnected: (connected: boolean) => void;
  sendPresence: (state: "online" | "degraded", error?: string) => void;
  refreshTray: (detail?: string) => void;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  isShuttingDown: () => boolean;
  isPaused: () => boolean;
};

export class GatewayRecoveryManager {
  private epoch = 0;
  private recoveryInFlight: Promise<void> | null = null;
  gatewayHealthy = true;

  constructor(private readonly deps: GatewayRecoveryDeps) {}

  recoverGateway(reason: string): Promise<void> {
    if (this.recoveryInFlight) {
      this.deps.log(
        "warn",
        `Recovery already in flight, deduplicating: ${reason}`
      );
      return this.recoveryInFlight;
    }
    this.epoch++;
    this.gatewayHealthy = false;
    this.deps.setConnected(false);
    this.deps.sendPresence("degraded", `gateway recovering: ${reason}`);

    this.recoveryInFlight = this.doRecover(reason).finally(() => {
      this.recoveryInFlight = null;
    });
    return this.recoveryInFlight;
  }

  private async doRecover(reason: string): Promise<void> {
    this.deps.log("warn", `Gateway recovery started: ${reason}`);
    try {
      await this.deps.restart();
      this.gatewayHealthy = true;
      this.deps.log("info", "Gateway recovered");
      if (this.deps.getCloudStatus().state === "online") {
        this.deps.setConnected(true);
        this.deps.sendPresence(
          this.deps.isPaused() ? "degraded" : "online",
          this.deps.isPaused() ? "cloud commands paused by user" : undefined
        );
      }
      this.deps.refreshTray();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown error";
      this.deps.log("error", `Gateway recovery failed: ${msg}`);
      this.deps.refreshTray(`Gateway down -- restart failed: ${msg}`);
    }
  }

  async onCloudOnline(): Promise<void> {
    const epoch = ++this.epoch;
    const alive = await this.deps.probe();

    if (this.epoch !== epoch || this.deps.getCloudStatus().state !== "online") {
      return;
    }

    if (!alive) {
      await this.recoverGateway("liveness probe failed on cloud reconnect");
      return;
    }

    this.gatewayHealthy = true;
    this.deps.setConnected(true);
    this.deps.sendPresence(
      this.deps.isPaused() ? "degraded" : "online",
      this.deps.isPaused() ? "cloud commands paused by user" : undefined
    );
    this.deps.refreshTray();
  }

  onUnexpectedClose(): void {
    if (this.deps.isShuttingDown()) {
      return;
    }
    void this.recoverGateway("unexpected server close");
  }
}
