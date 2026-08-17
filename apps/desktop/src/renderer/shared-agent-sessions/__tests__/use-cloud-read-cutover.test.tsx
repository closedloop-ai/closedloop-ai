import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudReadReadinessSnapshot } from "../../../shared/cloud-read-readiness-contract";
import { unknownCloudReadReadiness } from "../../../shared/cloud-read-readiness-contract";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { SyncLaneDrainState } from "../../../shared/sync-burndown-contract";
import {
  CLOUD_READ_CUTOVER_STALL_FAIL_OPEN_MS,
  CloudReadCutoverBlocker,
  DesktopAppCoreMode,
} from "../desktop-app-core-mode";
import {
  CLOUD_READ_READINESS_POLL_MS,
  useCloudReadCutover,
} from "../use-cloud-read-cutover";
import {
  drainedReadiness,
  drainingReadiness,
  fullLaneSet,
  laneReadiness,
} from "./fixtures/cloud-read-cutover-fixtures";

/**
 * The rows this machine already has locally. The whole point of ISS-5477 is that
 * signing in must not make them disappear, so the harness renders them from the
 * LOCAL source only — a cutover to a cloud that has not received them yet shows
 * an empty list, exactly as the reported bug did.
 */
const LOCAL_ROWS = ["session-a", "session-b", "session-c"];

function Harness({
  status,
  isOnline,
  userId = "user-1",
  organizationId = "org-1",
}: Readonly<{
  status: DesktopAuthStatus;
  isOnline: boolean;
  userId?: string | null;
  organizationId?: string | null;
}>) {
  const decision = useCloudReadCutover({
    isOnline,
    organizationId,
    status,
    userId,
  });
  const rows = decision.mode === DesktopAppCoreMode.Local ? LOCAL_ROWS : [];
  return (
    <div>
      <span data-testid="mode">{decision.mode}</span>
      <span data-testid="blocker">{decision.blocker ?? "none"}</span>
      <span data-testid="failed-open">{String(decision.failedOpen)}</span>
      <span data-testid="cloud-holds-history">
        {String(decision.cloudHoldsHistory)}
      </span>
      <ul data-testid="rows">
        {rows.map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
    </div>
  );
}

let readReadiness: ReturnType<typeof vi.fn>;

function installBridge(
  read: (() => Promise<CloudReadReadinessSnapshot>) | null
) {
  readReadiness = vi.fn(read ?? (() => Promise.resolve(drainedReadiness())));
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: read === null ? {} : { getCloudReadReadiness: readReadiness },
    writable: true,
  });
}

/** Let the in-flight readiness read resolve and the state land. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Advance to the next poll and let it land. */
async function nextPoll(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(CLOUD_READ_READINESS_POLL_MS);
    await Promise.resolve();
  });
}

function renderAuthenticated() {
  return render(
    <Harness isOnline={true} status={DesktopAuthStatus.Authenticated} />
  );
}

function modeText(): string {
  return screen.getByTestId("mode").textContent ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "desktopApi");
  vi.restoreAllMocks();
});

describe("useCloudReadCutover — the reported regression", () => {
  it("keeps a freshly signed-in user on their own data while the backlog uploads", async () => {
    // This is the test that would have caught the bug: a populated machine
    // authenticates with a full outbox. Before the gate, the mode flipped to
    // Cloud here and the list went empty.
    installBridge(() => Promise.resolve(drainingReadiness(3401)));
    renderAuthenticated();
    await settle();

    expect(modeText()).toBe(DesktopAppCoreMode.Local);
    expect(screen.getByTestId("blocker").textContent).toBe(
      CloudReadCutoverBlocker.SyncDraining
    );
    expect(screen.getByTestId("rows").children).toHaveLength(LOCAL_ROWS.length);
    expect(screen.getByText("session-a")).toBeTruthy();
  });

  it("moves to the cloud once every lane genuinely drains", async () => {
    let snapshot = drainingReadiness(12);
    installBridge(() => Promise.resolve(snapshot));
    renderAuthenticated();
    await settle();
    expect(modeText()).toBe(DesktopAppCoreMode.Local);

    snapshot = drainedReadiness();
    await nextPoll();

    expect(modeText()).toBe(DesktopAppCoreMode.Cloud);
    expect(screen.getByTestId("failed-open").textContent).toBe("false");
  });

  it("does not move to the cloud when the queue emptied by dead-lettering", async () => {
    installBridge(() =>
      Promise.resolve(
        drainedReadiness({
          lanes: fullLaneSet([
            laneReadiness({
              state: SyncLaneDrainState.DrainedWithDeadLetters,
              deadLetteredCount: 4,
            }),
          ]),
        })
      )
    );
    renderAuthenticated();
    await settle();

    expect(modeText()).toBe(DesktopAppCoreMode.Local);
    expect(screen.getByTestId("blocker").textContent).toBe(
      CloudReadCutoverBlocker.SyncGaveUp
    );
    expect(screen.getByTestId("rows").children).toHaveLength(LOCAL_ROWS.length);
  });

  it("never polls while signed out", async () => {
    installBridge(() => Promise.resolve(drainedReadiness()));
    render(<Harness isOnline={true} status={DesktopAuthStatus.SignedOut} />);
    await settle();
    await nextPoll();

    expect(readReadiness).not.toHaveBeenCalled();
    expect(modeText()).toBe(DesktopAppCoreMode.Local);
  });
});

describe("useCloudReadCutover — the bounded fail-open", () => {
  it("lets a wedged lane through at the bound, and keeps the app usable throughout", async () => {
    // A lane that never moves: the same snapshot forever.
    installBridge(() => Promise.resolve(drainingReadiness(500)));
    renderAuthenticated();
    await settle();

    // Well past several polls, still short of the bound: held local, usable.
    const pollsBeforeBound = Math.floor(
      (CLOUD_READ_CUTOVER_STALL_FAIL_OPEN_MS - CLOUD_READ_READINESS_POLL_MS) /
        CLOUD_READ_READINESS_POLL_MS
    );
    for (let i = 0; i < pollsBeforeBound; i += 1) {
      await nextPoll();
    }
    expect(modeText()).toBe(DesktopAppCoreMode.Local);
    expect(screen.getByTestId("rows").children).toHaveLength(LOCAL_ROWS.length);

    await nextPoll();

    expect(modeText()).toBe(DesktopAppCoreMode.Cloud);
    expect(screen.getByTestId("failed-open").textContent).toBe("true");
    // The reason is retained so the badge can say the view may be incomplete.
    expect(screen.getByTestId("blocker").textContent).toBe(
      CloudReadCutoverBlocker.SyncDraining
    );
  });

  it("does not fail open while the backlog is genuinely shrinking", async () => {
    let remaining = 4000;
    installBridge(() => {
      remaining -= 10;
      return Promise.resolve(drainingReadiness(remaining));
    });
    renderAuthenticated();
    await settle();

    const polls = Math.ceil(
      (CLOUD_READ_CUTOVER_STALL_FAIL_OPEN_MS * 2) / CLOUD_READ_READINESS_POLL_MS
    );
    for (let i = 0; i < polls; i += 1) {
      await nextPoll();
    }

    // Far past the bound in wall-clock terms, but the fingerprint kept moving,
    // so the stall clock never accumulated. A wall-clock bound would have put
    // the user back on the empty cloud view mid-drain.
    expect(modeText()).toBe(DesktopAppCoreMode.Local);
    expect(screen.getByTestId("failed-open").textContent).toBe("false");
  });
});

describe("useCloudReadCutover — hysteresis and compatibility", () => {
  it("does not flap back to local when new work appears after the cutover", async () => {
    let snapshot = drainedReadiness();
    installBridge(() => Promise.resolve(snapshot));
    renderAuthenticated();
    await settle();
    expect(modeText()).toBe(DesktopAppCoreMode.Cloud);

    snapshot = drainingReadiness(9);
    await nextPoll();
    await nextPoll();

    expect(modeText()).toBe(DesktopAppCoreMode.Cloud);
  });

  it("falls back to the shipped behaviour when the preload has no such channel", async () => {
    installBridge(null);
    renderAuthenticated();
    await settle();

    // A renderer whose preload predates this channel must not be held on Local
    // waiting for an answer that can never arrive.
    expect(modeText()).toBe(DesktopAppCoreMode.Cloud);
  });
});

/**
 * ISS-5714 (review thread): the cutover is a measurement, and a measurement
 * belongs to exactly one workspace.
 *
 * Token application can move this renderer from authenticated org A straight to
 * authenticated org B with no signed-out status in between, so a hook that keys
 * its latch and its readings on `status` alone hands B the answer A earned: the
 * latch is drained, polling stays torn down (the latch is what tears it down),
 * the gate never re-runs, and Branches reads B's cloud before B's backlog is
 * established — this ticket's own empty-workspace symptom, one org over.
 */
describe("useCloudReadCutover — scoped to the identity it measured", () => {
  it("re-arms the gate on a direct authenticated account switch", async () => {
    let snapshot = drainedReadiness();
    installBridge(() => Promise.resolve(snapshot));
    const view = render(
      <Harness
        isOnline={true}
        organizationId="org-1"
        status={DesktopAuthStatus.Authenticated}
        userId="user-1"
      />
    );
    await settle();
    // org-1 legitimately reached the cloud: the latch is drained and polling has
    // been torn down. This is the state org-2 must NOT inherit.
    expect(modeText()).toBe(DesktopAppCoreMode.Cloud);
    expect(screen.getByTestId("cloud-holds-history").textContent).toBe("true");

    // org-2's backlog has NOT drained. No signed-out status in between.
    snapshot = drainingReadiness(2200);
    view.rerender(
      <Harness
        isOnline={true}
        organizationId="org-2"
        status={DesktopAuthStatus.Authenticated}
        userId="user-2"
      />
    );

    // Synchronously, on the first render that observes org-2 — not one tick
    // later. A single render served off org-1's latch is a render of org-2's
    // cloud, which is exactly the read this gate exists to withhold.
    expect(modeText()).toBe(DesktopAppCoreMode.Local);
    expect(screen.getByTestId("cloud-holds-history").textContent).toBe("false");

    // And the gate is genuinely LIVE again rather than merely reset once:
    // polling resumes, sees org-2 still draining, and holds.
    readReadiness.mockClear();
    await settle();
    await nextPoll();
    expect(readReadiness).toHaveBeenCalled();
    expect(modeText()).toBe(DesktopAppCoreMode.Local);
    expect(screen.getByTestId("blocker").textContent).toBe(
      CloudReadCutoverBlocker.SyncDraining
    );

    // org-2 reaches the cloud on its OWN drain, so the re-arm is a gate and not
    // a permanent block.
    snapshot = drainedReadiness();
    await nextPoll();
    expect(modeText()).toBe(DesktopAppCoreMode.Cloud);
  });

  it("does not re-arm when the same identity merely re-renders", async () => {
    // The counterweight: keying on identity must not turn every render into a
    // fresh gate, which would drop the latch on any re-render and flap the mode.
    installBridge(() => Promise.resolve(drainedReadiness()));
    const view = render(
      <Harness
        isOnline={true}
        organizationId="org-1"
        status={DesktopAuthStatus.Authenticated}
        userId="user-1"
      />
    );
    await settle();
    expect(modeText()).toBe(DesktopAppCoreMode.Cloud);

    view.rerender(
      <Harness
        isOnline={true}
        organizationId="org-1"
        status={DesktopAuthStatus.Authenticated}
        userId="user-1"
      />
    );
    expect(modeText()).toBe(DesktopAppCoreMode.Cloud);
    expect(screen.getByTestId("cloud-holds-history").textContent).toBe("true");
  });
});

/**
 * ISS-6206 (wongk review on #5050). `getCloudReadReadiness` is typed
 * `Promise<CloudReadReadinessSnapshot>`, but that is a claim about the preload,
 * not a runtime check — the value crosses IPC. `resolveBacklogBlocker` only
 * iterates the lanes it is handed, so before this the payloads below cut the
 * renderer over to the CLOUD and took the user's local rows off the screen.
 */
describe("useCloudReadCutover — the direct readiness channel is validated", () => {
  async function renderWith(
    snapshot: unknown
  ): Promise<ReturnType<typeof renderAuthenticated>> {
    installBridge(() =>
      Promise.resolve(snapshot as CloudReadReadinessSnapshot)
    );
    const view = renderAuthenticated();
    await settle();
    return view;
  }

  it("refuses to cut over on a truncated payload carrying one drained lane", async () => {
    await renderWith(drainedReadiness({ lanes: [laneReadiness()] }));

    expect(modeText()).toBe(DesktopAppCoreMode.Local);
    expect(screen.getByTestId("blocker").textContent).toBe(
      CloudReadCutoverBlocker.ReadinessUnknown
    );
    // The point of the whole ticket: the local history is still on screen.
    expect(screen.getByTestId("rows").children).toHaveLength(LOCAL_ROWS.length);
  });

  it("refuses a payload that repeats a lane in place of a missing one", async () => {
    const lanes = fullLaneSet([laneReadiness()]);
    await renderWith(
      drainedReadiness({ lanes: [...lanes.slice(0, 4), lanes[3]] })
    );

    expect(modeText()).toBe(DesktopAppCoreMode.Local);
    expect(screen.getByTestId("blocker").textContent).toBe(
      CloudReadCutoverBlocker.ReadinessUnknown
    );
  });

  it("refuses a state/count pair the canonical classifier can never emit", async () => {
    // `draining` with nothing remaining. Every count validates on its own; only
    // the cross-field rule rejects it.
    await renderWith(
      drainedReadiness({
        lanes: fullLaneSet([
          laneReadiness({
            itemsRemaining: 0,
            state: SyncLaneDrainState.Draining,
          }),
        ]),
      })
    );

    expect(modeText()).toBe(DesktopAppCoreMode.Local);
    expect(screen.getByTestId("blocker").textContent).toBe(
      CloudReadCutoverBlocker.ReadinessUnknown
    );
  });

  it("still cuts over on the same payload once it is well-formed", async () => {
    // The counterfactual for all three: identical shape, valid contents. Without
    // it they would pass on a validator that rejects everything.
    await renderWith(drainedReadiness());

    expect(modeText()).toBe(DesktopAppCoreMode.Cloud);
  });

  it("treats the contract's own unsampled snapshot as an answer, not a failed read", async () => {
    // ISS-6206: `unknownCloudReadReadiness()` is what `getCloudReadReadiness`
    // legitimately answers for the first minute of EVERY launch, before the
    // burn-down's first sample lands. Rejecting it as malformed routed a normal
    // launch into the failure ladder (5s → 10s → 20s → 40s → 60s), so the app
    // stayed on Local long after the cloud had drained. The cadence is the
    // observable: the blocker reads `readiness_unknown` either way.
    let snapshot: CloudReadReadinessSnapshot = unknownCloudReadReadiness();
    installBridge(() => Promise.resolve(snapshot));
    renderAuthenticated();
    await settle();
    expect(readReadiness).toHaveBeenCalledTimes(1);

    // A backed-off ladder stops answering these ticks from the second one on.
    for (const expectedReads of [2, 3, 4]) {
      await nextPoll();
      expect(readReadiness).toHaveBeenCalledTimes(expectedReads);
    }
    expect(modeText()).toBe(DesktopAppCoreMode.Local);

    // And the drained sample that follows is acted on at the steady cadence.
    snapshot = drainedReadiness();
    await nextPoll();
    expect(modeText()).toBe(DesktopAppCoreMode.Cloud);
  });

  it("never reads an admitted empty lane list as drained", async () => {
    // Why admitting the empty list above is safe: a sample that measured no
    // lanes has established nothing, so it blocks the cutover on its own merits
    // rather than on being rejected as malformed.
    await renderWith(drainedReadiness({ lanes: [] }));

    expect(modeText()).toBe(DesktopAppCoreMode.Local);
    expect(screen.getByTestId("blocker").textContent).toBe(
      CloudReadCutoverBlocker.SyncNotEstablished
    );
  });

  it("keeps polling after a malformed payload, so a good one still lands", async () => {
    let snapshot: unknown = drainedReadiness({ lanes: [laneReadiness()] });
    installBridge(() =>
      Promise.resolve(snapshot as CloudReadReadinessSnapshot)
    );
    renderAuthenticated();
    await settle();
    expect(modeText()).toBe(DesktopAppCoreMode.Local);

    snapshot = drainedReadiness();
    await nextPoll();
    expect(modeText()).toBe(DesktopAppCoreMode.Cloud);
  });
});
