import type { HandshakeAuth } from "@repo/realtime-contract/protocol";
import {
  PROTOCOL_VERSION,
  RealtimeEvent,
} from "@repo/realtime-contract/protocol";
import type {
  CreateRealtimeSocket,
  RealtimeSocket,
  RealtimeSocketOptions,
} from "../socket";

type Handler = (...args: unknown[]) => void;

export type EmittedPacket = { event: string; args: unknown[] };

/** Every socket the client created, in order. */
export class FakeSockets {
  readonly created: FakeSocket[] = [];

  readonly create: CreateRealtimeSocket = (url, options) => {
    const socket = new FakeSocket(url, options);
    this.created.push(socket);
    return socket;
  };
}

/**
 * Stands in for a socket.io-client `Socket`. The test plays the server:
 * `handshake()` runs the auth function, `accept()` connects and welcomes.
 */
export class FakeSocket implements RealtimeSocket {
  connected = false;
  readonly url: string;
  readonly options: RealtimeSocketOptions;
  readonly emitted: EmittedPacket[] = [];
  /** Every connect and disconnect the client made, in order. */
  readonly calls: ("connect" | "disconnect")[] = [];
  readonly io = {
    on: (event: "reconnect_attempt", listener: () => void) => {
      this.addHandler(`manager:${event}`, listener);
    },
  };
  private readonly handlers = new Map<string, Handler[]>();

  constructor(url: string, options: RealtimeSocketOptions) {
    this.url = url;
    this.options = options;
  }

  connect(): void {
    this.calls.push("connect");
  }

  disconnect(): void {
    this.calls.push("disconnect");
    if (this.connected) {
      this.connected = false;
      this.fire("disconnect", "io client disconnect");
    }
  }

  on(event: string, listener: Handler): void {
    this.addHandler(event, listener);
  }

  emit(event: string, ...args: unknown[]): void {
    this.emitted.push({ event, args });
  }

  /** Runs the handshake auth function and resolves with what it presented. */
  handshake(): Promise<HandshakeAuth> {
    return new Promise((resolve) =>
      this.runAuth(resolve as (data: object) => void)
    );
  }

  runAuth(callback: (data: object) => void): void {
    const { auth } = this.options;
    if (typeof auth !== "function") {
      throw new Error("auth is not a function");
    }
    auth(callback);
  }

  accept(): void {
    this.connected = true;
    this.fire("connect");
    this.fire(RealtimeEvent.Welcome, {
      connectionId: "conn-1",
      protocol: PROTOCOL_VERSION,
    });
  }

  refuse(code: string): void {
    this.fire(
      "connect_error",
      Object.assign(new Error(code), { data: { code } })
    );
  }

  drop(reason: string): void {
    this.connected = false;
    this.fire("disconnect", reason);
  }

  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  fireManager(event: "reconnect_attempt"): void {
    this.fire(`manager:${event}`);
  }

  sent(event: string): EmittedPacket[] {
    return this.emitted.filter((packet) => packet.event === event);
  }

  /** Answers the latest emit of `event` through its ack callback. */
  ack(event: string, response: unknown): void {
    const packet = this.sent(event).at(-1);
    if (packet === undefined) {
      throw new Error(`nothing sent on ${event}`);
    }
    ackPacket(packet, response);
  }

  private addHandler(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
}

export function ackPacket(packet: EmittedPacket, response: unknown): void {
  const callback = packet.args.at(-1);
  if (typeof callback !== "function") {
    throw new Error(`no ack callback on ${packet.event}`);
  }
  callback(response);
}
