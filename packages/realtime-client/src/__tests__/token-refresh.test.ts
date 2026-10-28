import type {
  IssuedRealtimeToken,
  RefreshAck,
} from "@repo/realtime-contract/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenRefresher, REFRESH_AT_FRACTION } from "../token-refresh";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createTokenRefresher", () => {
  it("fetches and sends a new token at 80% of the lifetime", async () => {
    const { refresher, getToken, sent } = createRefresher();

    refresher.start({ expiresAt: START + LIFETIME_MS, receivedAt: START });
    await vi.advanceTimersByTimeAsync(LIFETIME_MS * REFRESH_AT_FRACTION - 1);
    expect(getToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(sent.map((s) => s.token)).toEqual(["token-1"]);
  });

  it.each([
    ["an expiry at receipt", START],
    ["an expiry before receipt", START - 1],
    ["a NaN expiry", Number.NaN],
  ])("schedules nothing for %s", async (_label, expiresAt) => {
    const { refresher, getToken } = createRefresher();

    refresher.start({ expiresAt, receivedAt: START });
    await vi.advanceTimersByTimeAsync(LIFETIME_MS * 10);

    expect(getToken).not.toHaveBeenCalled();
  });

  it("drops a token whose fetch settles after stop", async () => {
    let resolve: (token: IssuedRealtimeToken) => void = () => undefined;
    const getToken = vi.fn(
      () =>
        new Promise<IssuedRealtimeToken>((r) => {
          resolve = r;
        })
    );
    const { refresher, sent } = createRefresher(getToken);

    refresher.start({ expiresAt: START + LIFETIME_MS, receivedAt: START });
    await vi.advanceTimersByTimeAsync(LIFETIME_MS * REFRESH_AT_FRACTION);
    expect(getToken).toHaveBeenCalledTimes(1);

    refresher.stop();
    resolve({ token: "late", expiresAt: Date.now() + LIFETIME_MS });
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toEqual([]);
  });

  it("drops a token whose fetch settles after a stop and restart", async () => {
    let resolve: (token: IssuedRealtimeToken) => void = () => undefined;
    const getToken = vi.fn(
      () =>
        new Promise<IssuedRealtimeToken>((r) => {
          resolve = r;
        })
    );
    const { refresher, sent } = createRefresher(getToken);

    refresher.start({ expiresAt: START + LIFETIME_MS, receivedAt: START });
    await vi.advanceTimersByTimeAsync(LIFETIME_MS * REFRESH_AT_FRACTION);
    refresher.stop();
    refresher.start({
      expiresAt: Date.now() + LIFETIME_MS,
      receivedAt: Date.now(),
    });
    resolve({ token: "late", expiresAt: Date.now() + LIFETIME_MS });
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toEqual([]);
  });

  it("schedules no further refresh from an ack that arrives after stop", async () => {
    const { refresher, getToken, sent } = createRefresher();

    refresher.start({ expiresAt: START + LIFETIME_MS, receivedAt: START });
    await vi.advanceTimersByTimeAsync(LIFETIME_MS * REFRESH_AT_FRACTION);
    expect(sent).toHaveLength(1);

    refresher.stop();
    sent[0]?.onAck({ ok: true, expiresAt: Date.now() + LIFETIME_MS });
    await vi.advanceTimersByTimeAsync(LIFETIME_MS * 10);

    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("reschedules from the ack's expiry, measured from when the token arrived", async () => {
    const { refresher, getToken, sent } = createRefresher();

    refresher.start({ expiresAt: START + LIFETIME_MS, receivedAt: START });
    await vi.advanceTimersByTimeAsync(LIFETIME_MS * REFRESH_AT_FRACTION);
    const receivedAt = Date.now();
    await vi.advanceTimersByTimeAsync(ACK_DELAY_MS);
    sent[0]?.onAck({ ok: true, expiresAt: receivedAt + ACK_LIFETIME_MS });

    await vi.advanceTimersByTimeAsync(
      ACK_LIFETIME_MS * REFRESH_AT_FRACTION - ACK_DELAY_MS - 1
    );
    expect(getToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getToken).toHaveBeenCalledTimes(2);
  });
});

const START = 1_000_000;
const LIFETIME_MS = 100_000;
const ACK_LIFETIME_MS = 50_000;
const ACK_DELAY_MS = 10_000;

function createRefresher(
  getToken = vi.fn(
    (): Promise<IssuedRealtimeToken> =>
      Promise.resolve({
        token: `token-${getToken.mock.calls.length}`,
        expiresAt: Date.now() + LIFETIME_MS,
      })
  )
) {
  const sent: { token: string; onAck: (ack: RefreshAck) => void }[] = [];
  const refresher = createTokenRefresher({
    getToken,
    now: () => Date.now(),
    sendRefresh: (token, onAck) => {
      sent.push({ token, onAck });
    },
  });
  return { refresher, getToken, sent };
}
