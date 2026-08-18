import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMonitorRuntimeStatusKind } from "../../../shared/agent-monitor-status";
import {
  __resetRuntimeStatusPollForTests,
  parseAgentMonitorStatus,
} from "../../hooks/use-ingest-progress";
import {
  AgentMonitorDbAheadBanner,
  DB_AHEAD_BANNER_MESSAGE,
} from "../agent-monitor-db-ahead-banner";

// ISS-4714: mount the real banner, drive the shared runtime-status poll it
// subscribes to (window.desktopApi.getRuntimeStatus), and assert it surfaces the
// prominent DB-ahead / update-required state ONLY when the runtime reports the DB
// is ahead of the app — and stays silent for a healthy, absent, or malformed
// status so it never lies about sync health.

// ISS-4834: assert against the exported message, not a copy of it, so the
// tightened wording can't drift from what the banner actually renders.
const DB_AHEAD_COPY = DB_AHEAD_BANNER_MESSAGE;
const CHECK_FOR_UPDATES_LABEL = /check for updates/i;
// Em/en dashes, and the engineer-facing nouns ISS-4834 took out of the copy.
// "paused" is banned too: Settings already uses "Paused" for a stop the user
// CHOSE and can undo, so reusing it here would promise a self-serve recovery
// that does not exist (only updating the app reopens this).
const RE_BANNED_BANNER_COPY = /[—–]|database|migration|paused/i;
// The substring the Electron e2e spec pins as a literal (it cannot import this
// module without aborting the Playwright loader).
const E2E_PINNED_PHRASE = "saved by a newer version of this app";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function installRuntimeStatus(
  status: unknown,
  extra: Record<string, unknown> = {}
): ReturnType<typeof vi.fn> {
  const getRuntimeStatus = vi.fn(() => Promise.resolve(status));
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { getRuntimeStatus, ...extra },
    writable: true,
  });
  return getRuntimeStatus;
}

async function flushPoll(): Promise<void> {
  // Let the immediate poll resolve and its state update flush under fake timers.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("AgentMonitorDbAheadBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Unmount THEN reset the shared module-level poll so a later test's late
    // subscriber never replays this test's cached status (a latching consumer
    // would otherwise settle on it before the fresh poll resolves).
    cleanup();
    __resetRuntimeStatusPollForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it("keeps the banner copy tight, plain, and in sync with the e2e pin", () => {
    // ISS-4834 (Parker copy pass). The Electron e2e spec cannot import this
    // module (its `@closedloop-ai/design-system` / renderer-hook imports abort the
    // Playwright loader), so it pins a literal substring. Assert that substring
    // here - this is the only place the two can be compared.
    expect(DB_AHEAD_BANNER_MESSAGE).toContain(E2E_PINNED_PHRASE);
    // Effect first: the user reads what stopped before why it stopped.
    expect(DB_AHEAD_BANNER_MESSAGE.startsWith("Agent Monitor history")).toBe(
      true
    );
    // No em dashes in product copy, and none of the engineer-facing nouns this
    // ticket removed ("database", "migration") come back.
    expect(DB_AHEAD_BANNER_MESSAGE).not.toMatch(RE_BANNED_BANNER_COPY);
    // The strip wraps rather than truncating, so this cap is copy discipline,
    // not truncation insurance - it just keeps the banner from growing into a
    // paragraph.
    expect(DB_AHEAD_BANNER_MESSAGE.length).toBeLessThanOrEqual(110);
    // The cause sentence is the half a truncating strip used to eat first, so
    // pin that it is actually present.
    expect(DB_AHEAD_BANNER_MESSAGE).toContain(
      "Your data was saved by a newer version of this app."
    );
  });

  it("renders the DB-ahead banner with an update-check action when the DB is ahead", async () => {
    const checkForUpdate = vi.fn(() => Promise.resolve());
    installRuntimeStatus(
      {
        agentMonitor: {
          kind: AgentMonitorRuntimeStatusKind.Failed,
          dbAhead: true,
          reason:
            "The local Agent Monitor database was created by a newer version.",
        },
      },
      { checkForUpdate }
    );
    render(<AgentMonitorDbAheadBanner />);
    await flushPoll();

    expect(screen.queryByText(DB_AHEAD_COPY)).not.toBeNull();
    // The highest-severity banner must offer an action, not be mute. Clicking it
    // triggers an update CHECK (relaunching the same too-old build won't help).
    const action = screen.getByRole("button", {
      name: CHECK_FOR_UPDATES_LABEL,
    });
    await act(async () => {
      action.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("lets the message wrap and tones the severity mark, so neither the cause nor the severity is lost", async () => {
    // Review follow-up on ISS-4834. Two separate ways this strip stopped
    // carrying its own meaning:
    //   1. `truncate` cut the SECOND sentence first - the only part that says
    //      why - so a narrow window left the user with an effect and no cause.
    //   2. The TriangleAlert inherited the strip's `--foreground`, so the
    //      non-color severity channel rendered as a neutral glyph on a red wash.
    installRuntimeStatus({
      agentMonitor: {
        kind: AgentMonitorRuntimeStatusKind.Failed,
        dbAhead: true,
        reason: "newer database",
      },
    });
    const { container } = render(<AgentMonitorDbAheadBanner />);
    await flushPoll();

    const message = screen.getByText(DB_AHEAD_COPY);
    // Wrapping, not truncating: the cause sentence survives a narrow strip.
    expect(message.className).not.toContain("truncate");
    // `min-w-0` stays so the flex child can still shrink to its container.
    expect(message.className).toContain("min-w-0");

    // The severity mark carries the destructive tone itself. It cannot inherit
    // it from the strip the way UpdateBanner does, because
    // `--destructive-foreground` is white in both themes and would be
    // unreadable over the 10% wash.
    // Pinned to TriangleAlert specifically, not just "some svg" (wongk review):
    // lucide stamps `lucide-<icon>` on the element, so removing the mark OR
    // swapping it for a different glyph fails here rather than sliding through
    // on a generic `querySelector("svg")` that the next icon would satisfy.
    const severityMark = container.querySelector("svg.lucide-triangle-alert");
    expect(severityMark).not.toBeNull();
    expect(severityMark?.getAttribute("class")).toContain(
      "text-[var(--destructive)]"
    );
    // Still announced by the sentence alone, never by the glyph.
    expect(severityMark?.getAttribute("aria-hidden")).toBe("true");
  });

  it("stops polling once a terminal DB-ahead verdict is observed", async () => {
    // ISS-4714 (wongk review): the runtime verdict is terminal at boot, so the
    // shared 1s poll (which reads authorized_keys.json on main each tick) must
    // latch off after the first Failed/Ready snapshot instead of running for the
    // whole session.
    const getRuntimeStatus = installRuntimeStatus({
      agentMonitor: {
        kind: AgentMonitorRuntimeStatusKind.Failed,
        dbAhead: true,
        reason: "newer database",
      },
    });
    render(<AgentMonitorDbAheadBanner />);
    await flushPoll();
    expect(screen.queryByText(DB_AHEAD_COPY)).not.toBeNull();

    const callsAtLatch = getRuntimeStatus.mock.calls.length;
    // Advance well past several poll intervals; no further polls should fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getRuntimeStatus.mock.calls.length).toBe(callsAtLatch);
    // The banner still shows the latched terminal verdict.
    expect(screen.queryByText(DB_AHEAD_COPY)).not.toBeNull();
  });

  it("renders nothing when the runtime is healthy (never lies about sync)", async () => {
    installRuntimeStatus({
      agentMonitor: {
        kind: AgentMonitorRuntimeStatusKind.Ready,
        dbAhead: false,
        reason: null,
      },
    });
    render(<AgentMonitorDbAheadBanner />);
    await flushPoll();

    expect(screen.queryByText(DB_AHEAD_COPY)).toBeNull();
  });

  it("renders nothing when a non-DB-ahead failure is reported", async () => {
    installRuntimeStatus({
      agentMonitor: {
        kind: AgentMonitorRuntimeStatusKind.Failed,
        dbAhead: false,
        reason: "The Agent Monitor could not start.",
      },
    });
    render(<AgentMonitorDbAheadBanner />);
    await flushPoll();

    expect(screen.queryByText(DB_AHEAD_COPY)).toBeNull();
  });

  it("renders nothing when the field is absent (older main process)", async () => {
    installRuntimeStatus({});
    render(<AgentMonitorDbAheadBanner />);
    await flushPoll();

    expect(screen.queryByText(DB_AHEAD_COPY)).toBeNull();
  });
});

describe("parseAgentMonitorStatus", () => {
  it("returns the DB-ahead status for a well-formed failed payload", () => {
    const parsed = parseAgentMonitorStatus({
      agentMonitor: {
        kind: AgentMonitorRuntimeStatusKind.Failed,
        dbAhead: true,
        reason: "newer database",
      },
    });
    expect(parsed).toEqual({
      kind: AgentMonitorRuntimeStatusKind.Failed,
      dbAhead: true,
      reason: "newer database",
    });
  });

  it("never honors dbAhead on a ready status", () => {
    // A malformed/version-skewed payload claiming dbAhead while ready must not
    // surface the degraded UI.
    const parsed = parseAgentMonitorStatus({
      agentMonitor: {
        kind: AgentMonitorRuntimeStatusKind.Ready,
        dbAhead: true,
        reason: "should be ignored",
      },
    });
    expect(parsed).toEqual({
      kind: AgentMonitorRuntimeStatusKind.Ready,
      dbAhead: false,
      reason: null,
    });
  });

  it("returns null when the field is absent", () => {
    expect(parseAgentMonitorStatus({})).toBeNull();
  });

  it("returns null for an unknown/future kind", () => {
    expect(
      parseAgentMonitorStatus({ agentMonitor: { kind: "from_the_future" } })
    ).toBeNull();
  });

  it("returns null for a non-object agentMonitor entry", () => {
    expect(parseAgentMonitorStatus({ agentMonitor: "failed" })).toBeNull();
  });
});
