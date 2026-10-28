/**
 * ISS-7223: the ack outcome that has no ack.
 *
 * `relay.command_acks` can only ever count acks that arrived, so 595 of 10,449
 * dispatched commands over 24h were a subtraction rather than a bucket — no
 * command named, no reason carried, nothing to correlate against the 289
 * concurrent disconnects. These cases pin the three things that make the third
 * outcome real: it is EMITTED, it is emitted ONCE per command, and it carries
 * the cause split the ticket's open question asks for.
 *
 * Outcome and cause literals are written out here rather than imported from the
 * module under test. They are Datadog tag values a dashboard queries by name, so
 * an assertion that reads them from the enum would agree with a rename that
 * silently broke every query. The duplication is the point.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockListCommandsCrossingAckDeadline,
  mockListComputeTargetLastSeen,
  mockCountInFlightCommandsByTarget,
  mockLogWarn,
  mockLogError,
} = vi.hoisted(() => ({
  mockListCommandsCrossingAckDeadline: vi.fn(),
  mockListComputeTargetLastSeen: vi.fn(),
  mockCountInFlightCommandsByTarget: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@/lib/desktop-command-dispatch-queries", () => ({
  listCommandsCrossingAckDeadline: mockListCommandsCrossingAckDeadline,
  listComputeTargetLastSeen: mockListComputeTargetLastSeen,
  countInFlightCommandsByTarget: mockCountInFlightCommandsByTarget,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: mockLogWarn,
    error: mockLogError,
    debug: vi.fn(),
  },
}));

import { DESKTOP_COMMAND_ACK_DEADLINE_MS } from "@repo/api/src/types/desktop-command-ack";
import {
  ACK_TIMEOUT_LOG_MESSAGE,
  ACK_TIMEOUT_MAX_PER_TICK,
  ACK_TIMEOUT_PAGE_SIZE,
  ACK_TIMEOUT_TICK_MS,
  ACK_TIMEOUT_TRUNCATED_LOG_MESSAGE,
  sweepUnackedCommands,
} from "@/lib/desktop-command-ack-timeout";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const MINUTE_MS = 60 * 1000;

function crossing(
  commandId: string,
  computeTargetId = "target-1",
  ackedAt: Date | null = null
) {
  return {
    commandId,
    computeTargetId,
    queuedAt: new Date(
      NOW.getTime() - DESKTOP_COMMAND_ACK_DEADLINE_MS - MINUTE_MS
    ),
    ackedAt,
  };
}

/** The `queuedAt` every {@link crossing} carries, for building acks around it. */
const CROSSING_QUEUED_AT = new Date(
  NOW.getTime() - DESKTOP_COMMAND_ACK_DEADLINE_MS - MINUTE_MS
);

/** The payload of the timeout line the sweep emitted for `commandId`. */
function timeoutLine(commandId: string): Record<string, unknown> | undefined {
  return mockLogWarn.mock.calls.find(
    (call) =>
      call[0] === ACK_TIMEOUT_LOG_MESSAGE &&
      (call[1] as { commandId?: string }).commandId === commandId
  )?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockListCommandsCrossingAckDeadline.mockResolvedValue({
    commands: [],
    cursor: undefined,
  });
  mockListComputeTargetLastSeen.mockResolvedValue(new Map());
  mockCountInFlightCommandsByTarget.mockResolvedValue(new Map());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sweepUnackedCommands", () => {
  it("emits the timed_out ack outcome for a command whose ack never arrived", async () => {
    // The whole defect: before this, such a command produced NO line at all.
    mockListCommandsCrossingAckDeadline.mockResolvedValue({
      commands: [crossing("cmd-lost")],
      cursor: undefined,
    });
    mockListComputeTargetLastSeen.mockResolvedValue(
      new Map([["target-1", NOW]])
    );

    const summary = await sweepUnackedCommands();

    expect(timeoutLine("cmd-lost")).toEqual(
      expect.objectContaining({
        commandId: "cmd-lost",
        computeTargetId: "target-1",
        ackOutcome: "timed_out",
        timeoutCause: "target_present",
        unackedMs: DESKTOP_COMMAND_ACK_DEADLINE_MS + MINUTE_MS,
      })
    );
    expect(summary.timedOut).toBe(1);
  });

  it("reads a half-open band exactly one tick wide, so no command is counted twice", async () => {
    // A command that stays queued is still queued next tick. An open-ended
    // "older than the deadline" predicate would re-report it every five minutes
    // and turn 595 distinct silent commands into an unbounded multiple — a
    // confidently wrong number, which is worse than the missing one.
    await sweepUnackedCommands();

    expect(mockListCommandsCrossingAckDeadline).toHaveBeenCalledWith({
      now: NOW,
      olderThanMs: DESKTOP_COMMAND_ACK_DEADLINE_MS,
      youngerThanMs: DESKTOP_COMMAND_ACK_DEADLINE_MS + ACK_TIMEOUT_TICK_MS,
      limit: ACK_TIMEOUT_PAGE_SIZE,
    });
  });

  it("anchors the band to the tick grid, not to the delayed firing instant", async () => {
    // Cron delay varies per firing. Anchored to the raw instant, a firing that
    // is LESS delayed than the one before it produces a band overlapping the
    // previous one, and every command in the overlap is reported twice — the
    // exact double-count the half-open band exists to prevent. Snapping makes
    // consecutive bands abut.
    const delayedFiring = new Date(NOW.getTime() + 137_000);
    vi.setSystemTime(delayedFiring);

    await sweepUnackedCommands(delayedFiring);

    const args = mockListCommandsCrossingAckDeadline.mock.calls[0]?.[0] as {
      now: Date;
    };
    expect(args.now).toEqual(NOW);
    expect(args.now).not.toEqual(delayedFiring);
  });

  it("snaps two differently-delayed firings in one tick to the same band", async () => {
    const early = new Date(NOW.getTime() + 4000);
    const late = new Date(NOW.getTime() + 210_000);

    await sweepUnackedCommands(early);
    await sweepUnackedCommands(late);

    const first = mockListCommandsCrossingAckDeadline.mock.calls[0]?.[0];
    const second = mockListCommandsCrossingAckDeadline.mock.calls[1]?.[0];
    expect(first).toEqual(second);
  });

  it("splits a silent target from a live one, which is what correlates the disconnects", async () => {
    mockListCommandsCrossingAckDeadline.mockResolvedValue({
      commands: [
        crossing("cmd-gone", "target-gone"),
        crossing("cmd-live", "target-live"),
      ],
      cursor: undefined,
    });
    mockListComputeTargetLastSeen.mockResolvedValue(
      new Map([
        ["target-gone", new Date(NOW.getTime() - 30 * MINUTE_MS)],
        ["target-live", NOW],
      ])
    );

    const summary = await sweepUnackedCommands();

    expect(timeoutLine("cmd-gone")?.timeoutCause).toBe("target_silent");
    expect(timeoutLine("cmd-live")?.timeoutCause).toBe("target_present");
    expect(summary.byCause).toEqual({
      target_silent: 1,
      target_busy: 0,
      target_present: 1,
      target_unknown: 0,
    });
  });

  it("holds a live target's other in-flight work apart from a lost ack", async () => {
    // A command queued behind the target's in-flight ceiling is waiting its
    // turn. Counting it as a lost ack would publish a lost-ack rate that is not
    // true.
    mockListCommandsCrossingAckDeadline.mockResolvedValue({
      commands: [crossing("cmd-waiting", "target-busy")],
      cursor: undefined,
    });
    mockListComputeTargetLastSeen.mockResolvedValue(
      new Map([["target-busy", NOW]])
    );
    mockCountInFlightCommandsByTarget.mockResolvedValue(
      new Map([["target-busy", 2]])
    );

    await sweepUnackedCommands();

    expect(timeoutLine("cmd-waiting")?.timeoutCause).toBe("target_busy");
    expect(timeoutLine("cmd-waiting")?.timeoutCause).not.toBe("target_present");
  });

  it("reports an unreadable target as unknown rather than as a lost ack", async () => {
    // A target deleted between the two reads is absent, not silent for zero ms.
    mockListCommandsCrossingAckDeadline.mockResolvedValue({
      commands: [crossing("cmd-orphan", "target-vanished")],
      cursor: undefined,
    });
    mockListComputeTargetLastSeen.mockResolvedValue(new Map());

    const summary = await sweepUnackedCommands();

    expect(timeoutLine("cmd-orphan")?.timeoutCause).toBe("target_unknown");
    expect(summary.byCause.target_present).toBe(0);
  });

  it("walks the band to exhaustion instead of dropping the crossings past one page", async () => {
    // The band is half-open and its far edge has moved by the next tick, so a
    // crossing left behind by a page cap is not deferred — it is lost, with
    // nothing anywhere naming it. That is the exact silence this sweep exists
    // to end, one level up.
    mockListCommandsCrossingAckDeadline
      .mockResolvedValueOnce({
        commands: [crossing("cmd-page1")],
        cursor: { queuedAt: NOW, id: "cmd-page1" },
      })
      .mockResolvedValueOnce({
        commands: [crossing("cmd-page2")],
        cursor: undefined,
      });

    const summary = await sweepUnackedCommands();

    expect(timeoutLine("cmd-page2")).toBeDefined();
    expect(summary).toMatchObject({ timedOut: 2, truncated: false });
  });

  it("resumes from the cursor rather than re-reading the rows it already reported", async () => {
    const cursor = { queuedAt: NOW, id: "cmd-page1" };
    mockListCommandsCrossingAckDeadline
      .mockResolvedValueOnce({ commands: [crossing("cmd-page1")], cursor })
      .mockResolvedValueOnce({ commands: [], cursor: undefined });

    await sweepUnackedCommands();

    expect(mockListCommandsCrossingAckDeadline).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ after: cursor })
    );
  });

  it("puts a truncated tick on its own monitored line, not only in the returned summary", async () => {
    // A caller that only forwards `truncated` writes it to a message the ack
    // metric's filter does not read, so the metric could never see its own
    // source going short. It is emitted here instead — and deliberately NOT on
    // the timeout message, where it would count as one more timed-out command.
    mockListCommandsCrossingAckDeadline.mockResolvedValue({
      commands: Array.from({ length: ACK_TIMEOUT_PAGE_SIZE }, (_unused, i) =>
        crossing(`cmd-${i}`)
      ),
      cursor: { queuedAt: NOW, id: "cmd-last" },
    });

    const summary = await sweepUnackedCommands();

    expect(summary).toMatchObject({
      timedOut: ACK_TIMEOUT_MAX_PER_TICK,
      truncated: true,
    });
    expect(mockLogError).toHaveBeenCalledWith(
      ACK_TIMEOUT_TRUNCATED_LOG_MESSAGE,
      expect.objectContaining({ reported: ACK_TIMEOUT_MAX_PER_TICK })
    );
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      ACK_TIMEOUT_TRUNCATED_LOG_MESSAGE,
      expect.anything()
    );
  });

  it("skips both correlation reads when the band is empty", async () => {
    // The empty case is the overwhelmingly common one; it must not cost two
    // queries per tick forever.
    const summary = await sweepUnackedCommands();

    expect(mockListComputeTargetLastSeen).not.toHaveBeenCalled();
    expect(mockCountInFlightCommandsByTarget).not.toHaveBeenCalled();
    expect(summary).toEqual({
      timedOut: 0,
      truncated: false,
      byCause: {
        target_silent: 0,
        target_busy: 0,
        target_present: 0,
        target_unknown: 0,
      },
    });
  });

  it("asks for each target's presence and in-flight count once, not once per command", async () => {
    mockListCommandsCrossingAckDeadline.mockResolvedValue({
      commands: [
        crossing("cmd-a", "target-1"),
        crossing("cmd-b", "target-1"),
        crossing("cmd-c", "target-2"),
      ],
      cursor: undefined,
    });

    await sweepUnackedCommands();

    expect(mockListComputeTargetLastSeen).toHaveBeenCalledTimes(1);
    expect(mockListComputeTargetLastSeen).toHaveBeenCalledWith([
      "target-1",
      "target-2",
    ]);
    expect(mockCountInFlightCommandsByTarget).toHaveBeenCalledTimes(1);
  });
});

/**
 * ISS-9630: a crossing now says whether an EARLIER delivery was already
 * answered.
 *
 * `previouslyAcked` is written out as a literal and the fixtures' timestamps are
 * built from explicit offsets, never from `wasAnsweredOnEarlierDelivery`. A
 * fixture that derived its expectation from the predicate it guards would agree
 * with that predicate's own inversion, which is the mutation these cases exist
 * to kill.
 */
describe("sweepUnackedCommands reports previously-acked crossings", () => {
  it("calls a command that was never answered not previously acked", async () => {
    mockListCommandsCrossingAckDeadline.mockResolvedValue({
      commands: [crossing("cmd-never-answered")],
      cursor: undefined,
    });

    await sweepUnackedCommands();

    expect(timeoutLine("cmd-never-answered")?.previouslyAcked).toBe(false);
  });

  it("calls a command answered before its current queue entry previously acked", async () => {
    // The population a retry must NOT re-dispatch: the target answered this
    // command once, a reconnect requeued it, and the answer on record predates
    // the delivery now outstanding. Before this column that row was
    // indistinguishable from one the target never received.
    mockListCommandsCrossingAckDeadline.mockResolvedValue({
      commands: [
        crossing(
          "cmd-already-ran",
          "target-1",
          new Date(CROSSING_QUEUED_AT.getTime() - MINUTE_MS)
        ),
      ],
      cursor: undefined,
    });

    await sweepUnackedCommands();

    expect(timeoutLine("cmd-already-ran")?.previouslyAcked).toBe(true);
  });

  it("does not treat an ack on the queue-entry millisecond as an earlier delivery", async () => {
    // The strict less-than boundary. An ack and the queue entry it answers can
    // land on the same millisecond; reading that as stale would report a
    // correctly-acked command as one that had already run, and send exactly the
    // wrong signal to whoever sizes the retry population.
    mockListCommandsCrossingAckDeadline.mockResolvedValue({
      commands: [
        crossing(
          "cmd-same-millisecond",
          "target-1",
          new Date(CROSSING_QUEUED_AT.getTime())
        ),
      ],
      cursor: undefined,
    });

    await sweepUnackedCommands();

    expect(timeoutLine("cmd-same-millisecond")?.previouslyAcked).toBe(false);
  });
});
