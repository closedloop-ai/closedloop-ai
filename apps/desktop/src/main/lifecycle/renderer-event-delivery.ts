import { DesktopRendererEventChannel } from "../../shared/desktop-renderer-event-channel.js";
import { rendererRouteOpenDecision } from "./renderer-window-session-state.js";

export type RendererDelivery = {
  channel: string;
  args: unknown[];
};

const RENDERER_EVENT_POLICY = {
  [DesktopRendererEventChannel.AuthStateChanged]: "drop",
  [DesktopRendererEventChannel.DbChanged]: "drop",
  [DesktopRendererEventChannel.DbReady]: "drop",
  [DesktopRendererEventChannel.DistributionsOptInAvailable]: "snapshot",
  [DesktopRendererEventChannel.FlagsChanged]: "drop",
  [DesktopRendererEventChannel.GithubResyncNudge]: "drop",
  [DesktopRendererEventChannel.NavigateTab]: "last-wins",
  [DesktopRendererEventChannel.OnboardingStateChanged]: "drop",
  [DesktopRendererEventChannel.PackInstallOutput]: "drop",
  [DesktopRendererEventChannel.Realtime]: "drop",
  [DesktopRendererEventChannel.ShowOnboardingPopup]: "drop",
  [DesktopRendererEventChannel.SyncConsentChanged]: "drop",
  [DesktopRendererEventChannel.UpdateAvailable]: "drop",
  [DesktopRendererEventChannel.UpdateStatus]: "drop",
} satisfies Record<
  DesktopRendererEventChannel,
  "snapshot" | "last-wins" | "drop"
>;

/**
 * Defines delivery while no renderer generation is ready. State notifications
 * retain one current snapshot, discrete intents retain one pending value, and
 * unlisted/high-rate streams are dropped until a renderer rejoins.
 */
export class RendererEventDelivery {
  private ready = false;
  private readonly snapshots = new Map<string, unknown[]>();
  private readonly pending = new Map<string, unknown[]>();

  startGeneration(): void {
    this.ready = false;
  }

  /** Remove a retained snapshot after its owning action makes it stale. */
  clearSnapshot(channel: string): void {
    if (rendererEventPolicy(channel) === "snapshot") {
      this.snapshots.delete(channel);
    }
  }

  /** Remove an older discrete intent superseded by fresher external state. */
  clearPendingIntent(channel: string): void {
    if (rendererEventPolicy(channel) === "last-wins") {
      this.pending.delete(channel);
    }
  }

  record(channel: string, args: unknown[]): RendererDelivery | null {
    const policy = rendererEventPolicy(channel);
    if (policy === "snapshot") {
      this.snapshots.set(channel, args);
      return this.ready ? { channel, args } : null;
    }
    if (policy === "last-wins") {
      this.pending.set(channel, args);
      if (!this.ready) {
        return null;
      }
      this.pending.delete(channel);
      return { channel, args };
    }
    return this.ready ? { channel, args } : null;
  }

  deliveryFailed(delivery: RendererDelivery): void {
    if (rendererEventPolicy(delivery.channel) === "last-wins") {
      this.pending.set(delivery.channel, delivery.args);
    }
  }

  markReady(): RendererDelivery[] | null {
    if (this.ready) {
      return null;
    }
    this.ready = true;
    const deliveries = [
      ...this.snapshots.entries(),
      ...this.pending.entries(),
    ].map(([channel, args]) => ({ channel, args }));
    this.pending.clear();
    return deliveries;
  }

  dispose(): void {
    this.ready = false;
    this.snapshots.clear();
    this.pending.clear();
  }
}

/** Attempt a guarded send and restore a last-wins intent when it races teardown. */
export function attemptRendererDelivery(
  owner: RendererEventDelivery,
  delivery: RendererDelivery,
  send: (delivery: RendererDelivery) => boolean
): boolean {
  const sent = send(delivery);
  if (!sent) {
    owner.deliveryFailed(delivery);
  }
  return sent;
}

/**
 * Apply one route intent to the current generation or the next renderer URL.
 * A route embedded in a fresh URL supersedes any queued route from a retired
 * generation so readiness cannot replay the older intent afterward.
 */
export function prepareRendererRouteOpen(
  owner: RendererEventDelivery,
  hasLiveWindow: boolean,
  route: string
): { initialHash: string | null; queuedRoute: string | null } {
  const decision = rendererRouteOpenDecision(hasLiveWindow, route);
  if (decision.initialHash !== null) {
    owner.clearPendingIntent(DesktopRendererEventChannel.NavigateTab);
  }
  return decision;
}

/**
 * Flush retained delivery once per generation and republish owner state for
 * every navigation mount, including same-generation application remounts.
 */
export function completeRendererNavigationReady(
  owner: RendererEventDelivery,
  deliver: (delivery: RendererDelivery) => void,
  republishOwnerState: () => void
): void {
  const deliveries = owner.markReady();
  if (deliveries) {
    for (const delivery of deliveries) {
      deliver(delivery);
    }
  }
  republishOwnerState();
}

function rendererEventPolicy(
  channel: string
): "snapshot" | "last-wins" | "drop" {
  if (!Object.hasOwn(RENDERER_EVENT_POLICY, channel)) {
    return "drop";
  }
  return RENDERER_EVENT_POLICY[channel as DesktopRendererEventChannel];
}
