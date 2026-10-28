import {
  createSocketIoRealtimeClient,
  type RealtimeClient,
  type SocketIoRealtimeClientOptions,
} from "@repo/realtime-client/connection";
import {
  type RealtimeChannelListener,
  RealtimeStatus,
} from "@repo/realtime-client/port";
import type { IssuedRealtimeToken } from "@repo/realtime-contract/protocol";
import {
  type DesktopRealtimeEvent,
  DesktopRealtimeEventKind,
  type DesktopRealtimeJoinResult,
} from "../../shared/desktop-realtime-contract.js";
import {
  type DesktopAccountAdmission,
  isSameDesktopAccountAdmission,
} from "../session/desktop-account-admission.js";

/** One renderer that holds channels; `id` is its `webContents` id. */
export type DesktopRealtimeHolder = {
  id: number;
  send: (event: DesktopRealtimeEvent) => void;
};

export type DesktopRealtimeHostOptions = {
  /** Null while signed out or while sign-out cleanup is pending. */
  getAccountAdmission: () => DesktopAccountAdmission | null;
  /** `POST /realtime/token` with the signed-in session (PLN-2162 decision 12). */
  fetchToken: () => Promise<IssuedRealtimeToken>;
  clientVersion: string;
  /** Defaults to the socket.io client. */
  createClient?: (options: SocketIoRealtimeClientOptions) => RealtimeClient;
};

/**
 * PLN-2162 M4 (decision 10): the one realtime socket on desktop, held in the
 * main process for every renderer. Joins are counted per (renderer, channel),
 * and a channel is joined on the socket once while any renderer holds it.
 *
 * The client is built on the first join and bound to the account admitted
 * then, and closed when the last channel is left or released, so an idle host
 * fetches no tokens. An account change, a sign-out, or `stop()` also closes
 * it; the renderers' holds survive, and the next admitted client rejoins them.
 * A token fetched for a superseded client or account is refused, the way
 * `CloudSocketService` fences its start.
 */
export class DesktopRealtimeHost {
  private readonly options: DesktopRealtimeHostOptions;
  private readonly channels = new Map<string, ChannelHold>();
  private readonly holders = new Map<number, DesktopRealtimeHolder>();
  private client: RealtimeClient | undefined;
  private clientAdmission: DesktopAccountAdmission | null = null;
  private generation = 0;
  private disposed = false;
  private reportedStatus: RealtimeStatus = RealtimeStatus.Closed;

  constructor(options: DesktopRealtimeHostOptions) {
    this.options = options;
  }

  join(
    holder: DesktopRealtimeHolder,
    channel: string
  ): DesktopRealtimeJoinResult {
    if (this.disposed || !this.mayHold(holder.id, channel)) {
      return { status: this.status(), joined: false };
    }
    this.holders.set(holder.id, holder);
    let hold = this.channels.get(channel);
    if (hold === undefined) {
      hold = { holders: new Map(), leave: undefined, acked: false };
      this.channels.set(channel, hold);
    }
    hold.holders.set(holder.id, (hold.holders.get(holder.id) ?? 0) + 1);
    this.ensureClient();
    this.subscribe(channel, hold);
    return { status: this.status(), joined: this.isLive(hold) };
  }

  leave(holderId: number, channel: string): void {
    const hold = this.channels.get(channel);
    const count = hold?.holders.get(holderId);
    if (hold === undefined || count === undefined) {
      return;
    }
    if (count > 1) {
      hold.holders.set(holderId, count - 1);
      return;
    }
    hold.holders.delete(holderId);
    this.retireIfUnheld(channel, hold);
    this.forgetIfIdle(holderId);
  }

  /** Drops every hold a renderer has: it was destroyed, crashed, or navigated. */
  release(holderId: number): void {
    for (const [channel, hold] of [...this.channels]) {
      if (hold.holders.delete(holderId)) {
        this.retireIfUnheld(channel, hold);
      }
    }
    this.holders.delete(holderId);
  }

  /**
   * Called when an account is admitted. A client bound to another account, or
   * to none, is closed; the held channels move to a client for the account
   * admitted now.
   */
  reconcileAccount(): void {
    if (this.disposed) {
      return;
    }
    if (this.hasClientFor(this.options.getAccountAdmission())) {
      return;
    }
    this.closeClient();
    if (this.channels.size > 0) {
      this.ensureClient();
    }
    this.reportStatus();
  }

  /** Closes the client; the next join, or account boundary, builds another. */
  stop(): void {
    this.closeClient();
    this.reportStatus();
  }

  /** Shutdown: closes the client and refuses every later join. */
  dispose(): void {
    this.disposed = true;
    this.closeClient();
    this.channels.clear();
    this.holders.clear();
  }

  private status(): RealtimeStatus {
    return this.client?.status() ?? RealtimeStatus.Closed;
  }

  /** A new channel for a renderer already at the cap is refused, so it polls. */
  private mayHold(holderId: number, channel: string): boolean {
    if (this.channels.get(channel)?.holders.has(holderId)) {
      return true;
    }
    let held = 0;
    for (const hold of this.channels.values()) {
      if (hold.holders.has(holderId)) {
        held += 1;
      }
    }
    return held < MAX_CHANNELS_PER_HOLDER;
  }

  /**
   * A client the account no longer matches, or one that closed itself (a
   * refused handshake, an unknown protocol), is replaced rather than reused.
   */
  private hasClientFor(admission: DesktopAccountAdmission | null): boolean {
    return (
      this.client !== undefined &&
      this.client.status() !== RealtimeStatus.Closed &&
      isSameDesktopAccountAdmission(this.clientAdmission, admission)
    );
  }

  private ensureClient(): void {
    const admission = this.options.getAccountAdmission();
    if (this.hasClientFor(admission)) {
      return;
    }
    this.closeClient();
    if (admission === null) {
      return;
    }
    this.generation += 1;
    const generation = this.generation;
    this.clientAdmission = admission;
    const create = this.options.createClient ?? createSocketIoRealtimeClient;
    const client = create({
      clientVersion: this.options.clientVersion,
      getToken: () => this.fetchTokenFor(generation, admission),
    });
    this.client = client;
    client.onStatus((status) => {
      if (generation !== this.generation) {
        return;
      }
      if (status !== RealtimeStatus.Open) {
        // A rejoin follows every reconnect, and it acknowledges afresh.
        for (const hold of this.channels.values()) {
          hold.acked = false;
        }
      }
      this.reportStatus();
    });
    for (const [channel, hold] of this.channels) {
      this.subscribe(channel, hold);
    }
    this.reportStatus();
  }

  private closeClient(): void {
    this.generation += 1;
    const client = this.client;
    this.client = undefined;
    this.clientAdmission = null;
    for (const hold of this.channels.values()) {
      hold.leave = undefined;
      hold.acked = false;
    }
    client?.close();
  }

  private async fetchTokenFor(
    generation: number,
    admission: DesktopAccountAdmission
  ): Promise<IssuedRealtimeToken> {
    this.assertCurrent(generation, admission);
    const token = await this.options.fetchToken();
    this.assertCurrent(generation, admission);
    return token;
  }

  private assertCurrent(
    generation: number,
    admission: DesktopAccountAdmission
  ): void {
    if (
      generation !== this.generation ||
      !isSameDesktopAccountAdmission(
        admission,
        this.options.getAccountAdmission()
      )
    ) {
      throw new Error(SUPERSEDED_TOKEN_MESSAGE);
    }
  }

  private subscribe(channel: string, hold: ChannelHold): void {
    if (this.client === undefined || hold.leave !== undefined) {
      return;
    }
    hold.leave = this.client.join(
      channel,
      this.listenerFor(channel, hold, this.generation)
    );
  }

  private listenerFor(
    channel: string,
    hold: ChannelHold,
    generation: number
  ): RealtimeChannelListener {
    const forward = (event: DesktopRealtimeEvent) => {
      if (
        generation === this.generation &&
        this.channels.get(channel) === hold
      ) {
        this.sendTo(hold, event);
      }
    };
    return {
      onSignal: (signal) =>
        forward({ event: DesktopRealtimeEventKind.Signal, channel, signal }),
      onResync: () =>
        forward({ event: DesktopRealtimeEventKind.Resync, channel }),
      onError: (code) => {
        forward({ event: DesktopRealtimeEventKind.Error, channel, code });
        // The client dropped the channel; a later join asks for it afresh.
        if (
          generation === this.generation &&
          this.channels.get(channel) === hold
        ) {
          this.channels.delete(channel);
          for (const holderId of hold.holders.keys()) {
            this.forgetIfIdle(holderId);
          }
        }
      },
      // The client asks for this only when the service acknowledges the join.
      // Each renderer applies the resync rule against its own consumers' load
      // times, so the client is told nothing was loaded before the ack.
      dataLoadedAt: () => {
        if (generation === this.generation) {
          hold.acked = true;
          forward({ event: DesktopRealtimeEventKind.Joined, channel });
        }
        return Number.POSITIVE_INFINITY;
      },
    };
  }

  private isLive(hold: ChannelHold): boolean {
    return hold.acked && this.status() === RealtimeStatus.Open;
  }

  private sendTo(hold: ChannelHold, event: DesktopRealtimeEvent): void {
    for (const holderId of hold.holders.keys()) {
      this.holders.get(holderId)?.send(event);
    }
  }

  private reportStatus(): void {
    const status = this.status();
    if (status === this.reportedStatus) {
      return;
    }
    this.reportedStatus = status;
    for (const holder of this.holders.values()) {
      holder.send({ event: DesktopRealtimeEventKind.Status, status });
    }
  }

  private retireIfUnheld(channel: string, hold: ChannelHold): void {
    if (hold.holders.size > 0 || this.channels.get(channel) !== hold) {
      return;
    }
    this.channels.delete(channel);
    hold.leave?.();
    if (this.channels.size === 0) {
      this.stop();
    }
  }

  private forgetIfIdle(holderId: number): void {
    for (const hold of this.channels.values()) {
      if (hold.holders.has(holderId)) {
        return;
      }
    }
    this.holders.delete(holderId);
  }
}

type ChannelHold = {
  /** Renderer id to the number of joins it holds. */
  holders: Map<number, number>;
  /** The client's leave, while the channel is joined on the current client. */
  leave: (() => void) | undefined;
  /** The service acknowledged the join on the current connection. */
  acked: boolean;
};

/**
 * Well above the service's own per-connection limit, which refuses the excess
 * with `rate_limited` and retries it; this only bounds what one renderer can
 * make main remember.
 */
const MAX_CHANNELS_PER_HOLDER = 1000;

const SUPERSEDED_TOKEN_MESSAGE =
  "Realtime token request superseded by an account change or a newer client";
