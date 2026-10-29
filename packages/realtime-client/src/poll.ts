import { type Backoff, backoffDelayMs } from "./backoff";
import type { RealtimeChannelListener } from "./port";

export type PollLoopOptions = {
  poll: () => Promise<void>;
  /** A poll rejected or threw; the loop carries on. */
  onError?: (error: unknown) => void;
  /** Whether the channel is live when the loop starts. */
  live: boolean;
};

export type PollLoop = {
  setLive: (live: boolean) => void;
  /** Ends the loop; a poll already in flight settles unobserved. */
  stop: () => void;
};

/**
 * PLN-2106 step 5. Polls only while the channel is not live: the first poll
 * 2 s after it stops being live, then each wait doubles up to 30 s. A wait is
 * counted from when the previous poll settled, so one poll at most is in
 * flight. Going live cancels the wait and resets the schedule.
 */
export function startPollLoop(options: PollLoopOptions): PollLoop {
  let live = options.live;
  let stopped = false;
  let inFlight = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    if (stopped || live || inFlight || timer !== undefined) {
      return;
    }
    timer = setTimeout(run, backoffDelayMs(attempt, POLL_BACKOFF, unjittered));
  };

  const run = () => {
    timer = undefined;
    attempt += 1;
    inFlight = true;
    settle(options.poll)
      .catch((error: unknown) => {
        if (stopped) {
          return;
        }
        // A throwing onError would otherwise reject this chain with nothing
        // attached, and Node exits on an unhandled rejection by default.
        try {
          options.onError?.(error);
        } catch {
          // The consumer's own failure; the loop carries on regardless.
        }
      })
      .finally(() => {
        inFlight = false;
        schedule();
      });
  };

  schedule();

  return {
    setLive(next) {
      if (next === live) {
        return;
      }
      live = next;
      if (live) {
        clearTimer();
        attempt = 0;
      } else {
        schedule();
      }
    },
    stop() {
      stopped = true;
      clearTimer();
    },
  };
}

/** The listener's poll loop, or undefined when it supplies no `poll`. */
export function startListenerPoll(
  listener: RealtimeChannelListener,
  live: boolean
): PollLoop | undefined {
  const { poll } = listener;
  if (poll === undefined) {
    return;
  }
  return startPollLoop({
    poll,
    onError: (error) => listener.onPollError?.(error),
    live,
  });
}

/** "Starting at 2 s and backing off to 30 s" (ISS-11211 requirement 18). */
export const POLL_BACKOFF: Backoff = {
  minMs: 2000,
  maxMs: 30_000,
  randomizationFactor: 0,
};

const unjittered = () => 0.5;

/** A poll that throws synchronously is treated as one that rejected. */
function settle(poll: () => Promise<void>): Promise<void> {
  try {
    return Promise.resolve(poll());
  } catch (error) {
    return Promise.reject(error);
  }
}
