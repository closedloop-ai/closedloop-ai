import type {
  IssuedRealtimeToken,
  RefreshAck,
} from "@repo/realtime-contract/protocol";
import { clampTimerDelayMs } from "./backoff";

export type TokenLifetime = {
  /** Epoch milliseconds. */
  expiresAt: number;
  /** The client's clock when `getToken` resolved. */
  receivedAt: number;
};

export type TokenRefresherOptions = {
  getToken: () => Promise<IssuedRealtimeToken>;
  now: () => number;
  /** Sends `rt:refresh`; `onAck` runs only for a well-formed ack on the same connection. */
  sendRefresh: (token: string, onAck: (ack: RefreshAck) => void) => void;
};

export type TokenRefresher = {
  /** (Re)starts the schedule for a new connection's token. */
  start: (lifetime: TokenLifetime) => void;
  stop: () => void;
};

/**
 * PLN-2106 step 3: at 80% of the token's lifetime, fetch a new token and swap
 * it in place with `rt:refresh`, keeping the connection. A failed fetch or a
 * refused refresh schedules nothing more: the service's `token_expired` then
 * forces a reconnect, whose handshake fetches a fresh token.
 */
export function createTokenRefresher(
  options: TokenRefresherOptions
): TokenRefresher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bumped on every start and stop, so work begun for an earlier connection
  // never schedules on this one.
  let generation = 0;

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const refresh = (startedIn: number) => {
    options.getToken().then(
      (issued) => {
        if (startedIn !== generation) {
          return;
        }
        const receivedAt = options.now();
        options.sendRefresh(issued.token, (ack) => {
          if (startedIn === generation && ack.ok) {
            schedule({ expiresAt: ack.expiresAt, receivedAt });
          }
        });
      },
      () => undefined
    );
  };

  const schedule = (lifetime: TokenLifetime) => {
    clear();
    const lifetimeMs = lifetime.expiresAt - lifetime.receivedAt;
    // Also false for NaN, so a malformed expiry schedules nothing.
    if (!(lifetimeMs > 0)) {
      return;
    }
    const refreshAt = lifetime.receivedAt + lifetimeMs * REFRESH_AT_FRACTION;
    const startedIn = generation;
    timer = setTimeout(
      () => {
        timer = undefined;
        refresh(startedIn);
      },
      clampTimerDelayMs(refreshAt - options.now())
    );
  };

  return {
    start(lifetime) {
      generation += 1;
      schedule(lifetime);
    },
    stop() {
      generation += 1;
      clear();
    },
  };
}

export const REFRESH_AT_FRACTION = 0.8;
