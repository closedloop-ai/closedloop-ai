import type {
  ActivityBucket,
  AgentSessionDetail,
  SessionMarker,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import {
  TRACE_SCROLL_OUTCOME_MESSAGE,
  TraceScrollOutcome,
} from "@repo/app/agents/lib/trace-scroll-target";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { toast } from "@repo/design-system/components/ui/sonner";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// ISS-5479: the harness mounts no `<Toaster />`, so the reader-facing message is
// observed at the design-system boundary the view actually calls.
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { info: vi.fn() },
}));

import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import {
  makeDbPromptRow,
  makeTimelineBucket,
  stubScrollAwareRowRects,
} from "./session-timeline-scroll-harness";

/**
 * FEA-4252 regression: on the web the Session Timeline (cost bars/columns + event
 * dots) is keyed to the DB `session.turnItems` `_row` space, but the trace it
 * scrolls renders the parsed cloud transcript — a DIFFERENT `_row` space whose
 * turns rarely share a `transcriptIdentity` with the DB projection. Before the
 * fix, a click on either a column or a dot resolved to `null` and the jump was
 * silently skipped, so nothing scrolled ("neither the dots nor the columns
 * scroll to the proper place in the transcript"). The nearest-time fallback now
 * lands the flash on the correct rendered row for BOTH the column path and the
 * dot path, including a target well past the first hour (FEA-3586 territory).
 *
 * The `.st-flash` class is added to the row the scroll targeted, so it is the
 * behavioral witness that the click scrolled to the RIGHT transcript row.
 */

const SESSION_ID = "session-scroll-1";
const SIGNED_URL = "https://s3.invalid/session/scroll-main.jsonl";
const JUMP_TO_ACTIVITY_BUCKET_NAME = /jump to activity bucket/i;
const JUMP_TO_STEERING_DOT_NAME = /jump to human steering/i;

// A cloud transcript with a leading assistant preamble the DB projection dropped,
// plus an assistant reply between the two user prompts so neither prompt
// coalesces into a shared row. Every shared turn ends up in a DIFFERENT rendered
// `_row` than its DB counterpart (the divergence), and no turn shares a
// `transcriptIdentity` with the DB projection, so the timeline must fall back to
// nearest-time. The second prompt sits ~90 minutes in — past the first hour.
const CLOUD_BODY = [
  {
    type: "assistant",
    timestamp: "2026-06-10T11:59:30.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4",
      content: [{ type: "text", text: "cloud preamble" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
  {
    type: "user",
    timestamp: "2026-06-10T12:00:02.000Z",
    cwd: "workspace/project",
    message: { role: "user", content: "opening prompt" },
  },
  {
    type: "assistant",
    timestamp: "2026-06-10T12:00:20.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4",
      content: [{ type: "text", text: "on it" }],
      usage: { input_tokens: 2, output_tokens: 2 },
    },
  },
  {
    type: "user",
    timestamp: "2026-06-10T13:30:05.000Z",
    cwd: "workspace/project",
    message: { role: "user", content: "steer past the first hour" },
  },
]
  .map((entry) => JSON.stringify(entry))
  .join("\n")
  .concat("\n");

function stubBytes(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request) =>
      String(url) === SIGNED_URL
        ? Promise.resolve(new Response(CLOUD_BODY, { status: 200 }))
        : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
    )
  );
}

/** Two-bucket timeline: bucket 0 → the opening turn, bucket 1 → the 90m turn. */
function buckets(): ActivityBucket[] {
  return [
    makeBucket({ label: "0m", tl0: 0 }),
    makeBucket({ label: "90m", tl0: 1 }),
  ];
}

function makeBucket(
  overrides: Partial<ActivityBucket> & Pick<ActivityBucket, "label" | "tl0">
): ActivityBucket {
  return makeTimelineBucket(overrides);
}

/** A human-steering (blue) marker keyed to the 90m DB turn (source _row 1). */
function markers(): SessionMarker[] {
  return [
    {
      kind: "prompt",
      x: 100,
      t: "2026-06-10T13:30:00.000Z",
      label: "steer past the first hour",
      tl: 1,
    },
  ];
}

/**
 * DB source turnItems: two prompts, at 12:00:00 and 13:30:00. They carry NO
 * `transcriptIdentity`, exactly like a real DB projection that minted different
 * ids than the cloud parser, so translation must rely on nearest-time.
 */
function sourceTurnItems(): TurnItem[] {
  return [
    dbPrompt(0, "2026-06-10T12:00:00.000Z", "opening prompt"),
    dbPrompt(1, "2026-06-10T13:30:00.000Z", "steer past the first hour"),
  ];
}

function dbPrompt(row: number, t: string, text: string): TurnItem {
  return makeDbPromptRow({
    row,
    sessionId: SESSION_ID,
    t,
    text,
    tMs: Date.parse(t),
  });
}

function divergentWebSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    startedAt: new Date("2026-06-10T12:00:00.000Z"),
    endedAt: new Date("2026-06-10T13:31:00.000Z"),
    updatedAt: new Date("2026-06-10T13:31:00.000Z"),
    lastActivityAt: new Date("2026-06-10T13:31:00.000Z"),
    transcripts: [
      {
        fileKey: "main",
        availability: TranscriptAvailability.Available,
        uploadedAt: "2026-06-10T13:35:00.000Z",
        permanentFailureReason: null,
      },
    ],
    turnItems: sourceTurnItems(),
    activityBuckets: buckets(),
    markers: markers(),
  });
}

function transcriptRoute(): FixtureRoute {
  return {
    method: "GET",
    path: `/agent-sessions/${SESSION_ID}/transcript`,
    respond: () => ({
      sessionId: SESSION_ID,
      files: [
        {
          fileKey: "main",
          availability: TranscriptAvailability.Available,
          url: SIGNED_URL,
          byteSize: CLOUD_BODY.length,
          rawSha256: "b".repeat(64),
          uploadedAt: "2026-06-10T13:35:00.000Z",
          lastObservedAt: "2026-06-10T13:35:00.000Z",
          permanentFailureReason: null,
        },
      ],
    }),
  };
}

/**
 * Give every rendered row a stable rect so `scrollToTraceRow`'s target math runs
 * (jsdom returns all-zero rects otherwise). Row 0 sits at the top; every later
 * row sits far below, so a real scroll offset is computed.
 */
function stubRowRects(): void {
  for (const row of document.querySelectorAll<HTMLElement>(".st [data-row]")) {
    const top = row.dataset.row === "0" ? 0 : 1000;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top,
        left: 0,
        width: 800,
        height: 24,
        bottom: top + 24,
        right: 800,
        x: 0,
        y: top,
        toJSON() {
          /* jsdom rect stub */
        },
      }),
    });
  }
}

async function renderDivergentDetail() {
  stubBytes();
  render(
    <AppCoreStoryProviders apiRoutes={[transcriptRoute()]}>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={divergentWebSession()}
      />
    </AppCoreStoryProviders>
  );
  // Wait for the parsed cloud trace to render; the DB fallback never shows.
  await screen.findByText("steer past the first hour");
  stubRowRects();
}

afterEach(() => vi.unstubAllGlobals());

describe("Session Timeline → transcript scroll on a divergent web session (FEA-4252)", () => {
  // Rendered cloud rows: 0=preamble(11:59:30), 1=opening prompt(12:00:02),
  // 2=reply(12:00:20), 3=steer(13:30:05). The DB source turns are at 12:00:00
  // (_row 0) and 13:30:00 (_row 1) with NO shared identity, so nearest-time maps
  // opening → rendered 1 and the 90m turn → rendered 3.

  it("scrolls the transcript to the correct rendered row when a COLUMN (cost bar) past the first hour is clicked", async () => {
    const user = userEvent.setup();
    await renderDivergentDetail();

    /*
     * ISS-5999: ISS-5819's clock window is unconditional now, so the producer's
     * two bins are projected onto the window's 24 columns and the LAST jumpable
     * column — not `bars[1]` — is the one owned by the 90-minute turn.
     */
    const bars = screen.getAllByRole("button", {
      name: JUMP_TO_ACTIVITY_BUCKET_NAME,
    });
    const lastBar = bars.at(-1);
    if (!lastBar) {
      throw new Error("Expected the timeline to render jumpable columns");
    }

    const scroller = document.querySelector<HTMLElement>(".sd3-scroll");
    if (!scroller) {
      throw new Error("Expected the transcript scroll container");
    }
    scroller.scrollTop = 0;

    // The late column → DB source _row 1 (the 90m turn) → nearest-time rendered
    // row 3. Before the fix this resolved to null and NOTHING flashed.
    await user.click(lastBar);
    const flashed = document.querySelector(".st-flash");
    expect(flashed).toHaveAttribute("data-row", "3");
    // Beyond proving the RIGHT row was selected, prove the scroller actually
    // MOVED toward it: row 3 is stubbed 1000px down, so a real jump lifts
    // `scrollTop` off 0. This guards the "flash added but scroll clamped / left
    // behind the sticky header" case the flash class alone cannot see.
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });

  it("scrolls the transcript to the correct rendered row when the opening COLUMN is clicked", async () => {
    const user = userEvent.setup();
    await renderDivergentDetail();

    const bars = screen.getAllByRole("button", {
      name: JUMP_TO_ACTIVITY_BUCKET_NAME,
    });
    // Bucket 0 → DB _row 0 (opening turn) → nearest-time rendered row 1 — a
    // DISTINCT target from the 90m bar's row 3, proving the columns resolve
    // per-turn rather than both collapsing to the top of the transcript.
    await user.click(bars[0]);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      "1"
    );
  });

  it("scrolls the transcript to the correct rendered row when a DOT (event marker) is clicked", async () => {
    const user = userEvent.setup();
    await renderDivergentDetail();

    const scroller = document.querySelector<HTMLElement>(".sd3-scroll");
    if (!scroller) {
      throw new Error("Expected the transcript scroll container");
    }
    scroller.scrollTop = 0;

    // The steering (blue) dot is keyed to DB _row 1 (the 90m turn). Clicking it
    // must scroll to the same nearest-time rendered row (3) as its column, not
    // skip the jump.
    const dot = screen.getByRole("button", { name: JUMP_TO_STEERING_DOT_NAME });
    await user.click(dot);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      "3"
    );
    // The scroller moved toward the far-down row 3 (see the column test) — the
    // dot path is not a no-op flash that left the target off-screen.
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });

  it("does not leave the transcript un-scrolled (no flash) after either a column or a dot click", async () => {
    const user = userEvent.setup();
    await renderDivergentDetail();

    const dot = screen.getByRole("button", { name: JUMP_TO_STEERING_DOT_NAME });
    await user.click(dot);
    // The bug's signature was NO flash at all — assert something was targeted.
    expect(document.querySelector(".st-flash")).not.toBeNull();
  });
});

/**
 * ISS-5479: three bars over the same 91-minute window. `alignBucketRowsToTranscript`
 * re-keys each bar's `tl0` to the first transcript row inside its own time slice
 * and forward-fills the empty ones, so bars 0 and 1 BOTH resolve to DB `_row` 0
 * — the collapse Mike reported ("only some of the columns actually scroll"). The
 * third bar covers the 90-minute turn.
 */
function collapsedBuckets(): ActivityBucket[] {
  return [
    makeBucket({ label: "0m", tl0: 0 }),
    makeBucket({ label: "30m", tl0: 1 }),
    makeBucket({ label: "60m", tl0: 2 }),
  ];
}

function collapsedTurnItems(): TurnItem[] {
  return [
    dbPrompt(0, "2026-06-10T12:00:00.000Z", "opening prompt"),
    dbPrompt(1, "2026-06-10T13:30:00.000Z", "steer past the first hour"),
    dbPrompt(2, "2026-06-10T13:30:30.000Z", "and once more"),
  ];
}

function collapsedSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    startedAt: new Date("2026-06-10T12:00:00.000Z"),
    endedAt: new Date("2026-06-10T13:31:00.000Z"),
    updatedAt: new Date("2026-06-10T13:31:00.000Z"),
    lastActivityAt: new Date("2026-06-10T13:31:00.000Z"),
    transcripts: [
      {
        fileKey: "main",
        availability: TranscriptAvailability.Available,
        uploadedAt: "2026-06-10T13:35:00.000Z",
        permanentFailureReason: null,
      },
    ],
    turnItems: collapsedTurnItems(),
    activityBuckets: collapsedBuckets(),
    markers: markers(),
  });
}

async function renderCollapsedDetail(): Promise<HTMLElement> {
  stubBytes();
  render(
    <AppCoreStoryProviders apiRoutes={[transcriptRoute()]}>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={collapsedSession()}
      />
    </AppCoreStoryProviders>
  );
  await screen.findByText("steer past the first hour");
  const scroller = document.querySelector<HTMLElement>(".sd3-scroll");
  if (!scroller) {
    throw new Error("Expected the transcript scroll container");
  }
  stubScrollAwareRowRects(scroller);
  scroller.scrollTop = 0;
  return scroller;
}

describe("Session Timeline bars that collapse onto one transcript anchor (ISS-5479)", () => {
  it("gives a perceptible response to BOTH of two adjacent bars that resolve to the same row", async () => {
    const user = userEvent.setup();
    const scroller = await renderCollapsedDetail();

    const bars = screen.getAllByRole("button", {
      name: JUMP_TO_ACTIVITY_BUCKET_NAME,
    });
    expect(bars.length).toBeGreaterThan(1);

    // First bar of the collapsed pair: resolves to rendered row 1 and moves.
    await user.click(bars[0]);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      "1"
    );
    const afterFirst = scroller.scrollTop;
    expect(afterFirst).toBeGreaterThan(0);

    // Clear the witness so the second click has to produce its OWN response.
    document.querySelector(".st-flash")?.classList.remove("st-flash");

    // Second bar of the pair: resolves to the SAME anchor, the scroller is
    // already parked there, so nothing moves and the arrival flash is the only
    // feedback left.
    //
    // Honest scope: this assertion does NOT fail on pre-ISS-5479 `main`. The
    // flash was already applied outside the movement guard, so the class lands
    // either way — what was broken in this case was that the flash was not
    // PERCEPTIBLE (it began decaying immediately), which is a CSS fix jsdom
    // cannot observe. What this locks in is the invariant that makes the CSS
    // fix reachable at all: the flash must never be moved inside the
    // `isTraceScrollMovement` branch, which would re-kill the collapsed case.
    // The counterfactual witnesses for this ticket are the no-jump-row and
    // unresolvable suites below.
    await user.click(bars[1]);
    expect(scroller.scrollTop).toBe(afterFirst);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      "1"
    );
  });

  it("keeps the dot and the column for the same bucket on the same anchor when they collapse", async () => {
    const user = userEvent.setup();
    const scroller = await renderCollapsedDetail();

    // ISS-5999: the LAST jumpable column, which the 90-minute turn owns once the
    // producer's bins are projected onto the window's 24 columns.
    const bars = screen.getAllByRole("button", {
      name: JUMP_TO_ACTIVITY_BUCKET_NAME,
    });
    const lastBar = bars.at(-1);
    if (!lastBar) {
      throw new Error("Expected the timeline to render jumpable columns");
    }
    await user.click(lastBar);
    const columnRow = document
      .querySelector(".st-flash")
      ?.getAttribute("data-row");
    expect(columnRow).toBe("3");
    document.querySelector(".st-flash")?.classList.remove("st-flash");

    // The steering dot is keyed to the same 90-minute turn. It must land on the
    // same rendered row AND still flash even though the scroller is already
    // parked there from the column click.
    const parked = scroller.scrollTop;
    const dot = screen.getByRole("button", { name: JUMP_TO_STEERING_DOT_NAME });
    await user.click(dot);
    expect(scroller.scrollTop).toBe(parked);
    expect(document.querySelector(".st-flash")).toHaveAttribute(
      "data-row",
      columnRow ?? ""
    );
  });
});

/**
 * ISS-5479: an "idle" bucket — its time slice caught no transcript turn, so the
 * producer left `tl0` null and `alignBucketRowsToTranscript` deliberately leaves
 * it null (ISS-4821: "idle bars stay non-clickable exactly as before"). The bar
 * and the dot rail still render live controls for it, so the click was dropped
 * by a `tl0 != null` guard at the call site and absorbed in total silence — no
 * scroll, no flash, no message. On a real session most bars are idle, which is
 * the single biggest reason "only some of the columns actually scroll".
 */
function idleMiddleBuckets(): ActivityBucket[] {
  return [
    makeBucket({ label: "0m", tl0: 0 }),
    makeBucket({ cIn: 0, cOut: 0, cCache: 0, label: "45m", tl0: null }),
    makeBucket({ label: "90m", tl0: 1 }),
  ];
}

function idleBucketSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    startedAt: new Date("2026-06-10T12:00:00.000Z"),
    endedAt: new Date("2026-06-10T13:31:00.000Z"),
    updatedAt: new Date("2026-06-10T13:31:00.000Z"),
    lastActivityAt: new Date("2026-06-10T13:31:00.000Z"),
    transcripts: [
      {
        fileKey: "main",
        availability: TranscriptAvailability.Available,
        uploadedAt: "2026-06-10T13:35:00.000Z",
        permanentFailureReason: null,
      },
    ],
    turnItems: sourceTurnItems(),
    activityBuckets: idleMiddleBuckets(),
    markers: markers(),
  });
}

async function renderIdleBucketDetail() {
  stubBytes();
  render(
    <AppCoreStoryProviders apiRoutes={[transcriptRoute()]}>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={idleBucketSession()}
      />
    </AppCoreStoryProviders>
  );
  await screen.findByText("steer past the first hour");
}

/** The in-place answers on the bucket tooltip's meta row (`getBucketJumpHint`). */
const NOTHING_TO_OPEN_HINT = /nothing to open here/;
const NOT_IN_TRANSCRIPT_HINT = /not in the transcript on screen/;
/** The withdrawn form of the bar's accessible name (no "Jump to"). */
const ACTIVITY_BUCKET_NAME = /^Activity bucket /;
const CLICK_TO_OPEN_HINT = /click to open in trace/;

describe("Session Timeline bar with no jump row at all (ISS-5479)", () => {
  it("answers at the bar itself rather than from a toast in the corner", async () => {
    const user = userEvent.setup();
    await renderIdleBucketDetail();
    const scroller = document.querySelector<HTMLElement>(".sd3-scroll");
    if (!scroller) {
      throw new Error("Expected the transcript scroll container");
    }
    stubScrollAwareRowRects(scroller);
    scroller.scrollTop = 0;
    vi.mocked(toast.info).mockClear();

    // The idle bar is NOT named "Jump to …" — the label already refuses to
    // promise navigation. What it did do is present as a live control.
    const idleBar = firstIdleBar();
    // Hovering is what a pointer user has necessarily done by the time they
    // click, and it is what puts the answer next to the bar.
    await user.hover(idleBar);
    expect(await screen.findByText(NOTHING_TO_OPEN_HINT)).toBeInTheDocument();
    await user.click(idleBar);

    expect(scroller.scrollTop).toBe(0);
    expect(document.querySelector(".st-flash")).toBeNull();
    // ISS-5479 review: the corner toast repeated what the bar had already said,
    // at the edge of the screen while the reader was looking at the bar.
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("keeps the jumpable bar's tooltip promising the jump", async () => {
    const user = userEvent.setup();
    await renderIdleBucketDetail();

    const jumpable = screen.getAllByRole("button", {
      name: JUMP_TO_ACTIVITY_BUCKET_NAME,
    })[0];
    await user.hover(jumpable);

    expect(await screen.findByText(CLICK_TO_OPEN_HINT)).toBeInTheDocument();
  });

  it("marks the idle bar unavailable to assistive tech while its neighbours stay actionable", async () => {
    await renderIdleBucketDetail();

    const idleBar = firstIdleBar();
    expect(idleBar).toHaveAttribute("aria-disabled", "true");
    // …and it stops *looking* like a control, so the announced state, the
    // pointer affordance, and what the click does finally agree.
    expect(idleBar.className).toContain("no-jump");
    // The bars that CAN jump must not pick up either treatment.
    for (const bar of screen.getAllByRole("button", {
      name: JUMP_TO_ACTIVITY_BUCKET_NAME,
    })) {
      expect(bar).toHaveAttribute("aria-disabled", "false");
      expect(bar.className).not.toContain("no-jump");
    }
  });
});

/**
 * ISS-5479: a bar whose turn EXISTS but has no counterpart in the rendered
 * transcript. The DB turns carry no shared identity, and their instants sit a
 * day away from every rendered row — past `NEAREST_TIME_MAX_DISTANCE_MS` — so
 * every translation pass (strong id, nearest-time, group tag) misses and
 * `toRendered` returns `null`. Before ISS-5479 the view returned here in
 * silence and the bar read as dead.
 *
 * ISS-5124: these rows used to be made untranslatable by blanking their
 * timestamps (`t: ""`, `tMs: NaN`). That reproduced the symptom but not the
 * shape: with no TIMED row on the session, `alignBucketRowsToTranscript` bails
 * before repairing anything, so the fixture was simultaneously an ISS-5479
 * unresolvable-turn case and an ISS-5124 unrepaired-bucket case, and the suite
 * could not tell which one it was pinning. Keeping the rows timed but distant
 * separates them: the buckets ARE repaired to real transcript rows here (so
 * ISS-5124's demotion correctly leaves them alone), and they are still
 * unresolvable against the rendered trace, which is the only thing this suite
 * is about.
 */
function untranslatableTurnItems(): TurnItem[] {
  return [
    dbPrompt(0, "2026-06-11T12:00:00.000Z", "opening prompt"),
    dbPrompt(1, "2026-06-11T13:30:00.000Z", "steer past the first hour"),
  ];
}

function untranslatableSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    startedAt: new Date("2026-06-10T12:00:00.000Z"),
    endedAt: new Date("2026-06-10T13:31:00.000Z"),
    updatedAt: new Date("2026-06-10T13:31:00.000Z"),
    lastActivityAt: new Date("2026-06-10T13:31:00.000Z"),
    transcripts: [
      {
        fileKey: "main",
        availability: TranscriptAvailability.Available,
        uploadedAt: "2026-06-10T13:35:00.000Z",
        permanentFailureReason: null,
      },
    ],
    turnItems: untranslatableTurnItems(),
    activityBuckets: buckets(),
    markers: markers(),
  });
}

describe("Session Timeline jump that cannot land (ISS-5479)", () => {
  it("tells the reader the moment is not in the transcript instead of doing nothing", async () => {
    const user = userEvent.setup();
    stubBytes();
    render(
      <AppCoreStoryProviders apiRoutes={[transcriptRoute()]}>
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={untranslatableSession()}
        />
      </AppCoreStoryProviders>
    );
    await screen.findByText("steer past the first hour");
    const scroller = document.querySelector<HTMLElement>(".sd3-scroll");
    if (!scroller) {
      throw new Error("Expected the transcript scroll container");
    }
    stubScrollAwareRowRects(scroller);
    scroller.scrollTop = 0;
    vi.mocked(toast.info).mockClear();

    // ISS-5479 review: the affordance follows RESOLVABILITY, not `tl0` alone, so
    // these bars no longer advertise a jump at all — none of them is named
    // "Jump to …" even though every one of them carries a `tl0`.
    expect(
      screen.queryAllByRole("button", { name: JUMP_TO_ACTIVITY_BUCKET_NAME })
    ).toHaveLength(0);
    const bars = screen.getAllByRole("button", {
      name: ACTIVITY_BUCKET_NAME,
    });
    expect(bars[1]).toHaveAttribute("aria-disabled", "true");
    expect(bars[1].className).toContain("no-jump");

    await user.hover(bars[1]);
    // The sidechain/divergent case gets its own sentence rather than borrowing
    // the partial-upload one.
    expect(await screen.findByText(NOT_IN_TRANSCRIPT_HINT)).toBeInTheDocument();
    await user.click(bars[1]);

    // Nothing scrolled and nothing flashed — which is exactly why the reader
    // has to be told, rather than left looking at an apparently dead control.
    expect(scroller.scrollTop).toBe(0);
    expect(document.querySelector(".st-flash")).toBeNull();
    expect(toast.info).toHaveBeenCalledWith(
      TRACE_SCROLL_OUTCOME_MESSAGE[TraceScrollOutcome.Unresolvable],
      { id: `trace-jump-${TraceScrollOutcome.Unresolvable}` }
    );
  });
});

/**
 * A dot renders only when its lane holds events, so a dot on screen is itself a
 * claim that something happened in that slice. `SessionMarker.tl` is typed
 * `number`, but a synced marker can deserialize without it — the cast is how the
 * fixture reproduces that wire shape without weakening the canonical type.
 */
function markerWithoutJumpRow(): SessionMarker[] {
  return [
    {
      kind: "prompt",
      x: 100,
      t: "2026-06-10T13:30:00.000Z",
      label: "steer past the first hour",
    } as unknown as SessionMarker,
  ];
}

async function renderRowlessDotDetail() {
  stubBytes();
  render(
    <AppCoreStoryProviders apiRoutes={[transcriptRoute()]}>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={{
          ...idleBucketSession(),
          markers: markerWithoutJumpRow(),
        }}
      />
    </AppCoreStoryProviders>
  );
  await screen.findByText("steer past the first hour");
}

describe("Session Timeline dot whose marker carries no jump row (ISS-5479)", () => {
  it("does not deny the activity the dot is on screen to report", async () => {
    const user = userEvent.setup();
    await renderRowlessDotDetail();
    const scroller = document.querySelector<HTMLElement>(".sd3-scroll");
    if (!scroller) {
      throw new Error("Expected the transcript scroll container");
    }
    stubScrollAwareRowRects(scroller);
    scroller.scrollTop = 0;
    vi.mocked(toast.info).mockClear();

    const dot = screen.getByRole("button", { name: "Human steering" });
    await user.click(dot);

    // The bar's `NoJumpTarget` ("nothing recorded here") would contradict both
    // this dot and the tooltip enumerating its events. The honest answer is that
    // the EVENT is real and its turn is not in the transcript being read.
    expect(toast.info).toHaveBeenCalledWith(
      TRACE_SCROLL_OUTCOME_MESSAGE[TraceScrollOutcome.Unresolvable],
      { id: `trace-jump-${TraceScrollOutcome.Unresolvable}` }
    );
    expect(toast.info).not.toHaveBeenCalledWith(
      TRACE_SCROLL_OUTCOME_MESSAGE[TraceScrollOutcome.NoJumpTarget],
      expect.anything()
    );
  });

  it("gives the dot the same withdrawn affordance the bar already gets", async () => {
    await renderRowlessDotDetail();

    // The accessible name must agree with what the click can do: no "Jump to".
    const dot = screen.getByRole("button", { name: "Human steering" });
    expect(dot).toHaveAttribute("aria-disabled", "true");
    expect(dot.className).toContain("no-jump");
    expect(
      screen.queryByRole("button", { name: "Jump to Human steering" })
    ).toBeNull();
  });
});

/** An inert bar's name: the ACTION clause, without the "Jump to" promise. */
const IDLE_BUCKET_NAME = /^Activity bucket /;

/**
 * The first column the IDLE source bin owns.
 *
 * ISS-5999: the bin's own label ("45m") no longer names a bar — ISS-5819's clock
 * window, unconditional now, labels its columns by clock time and one idle bin
 * spans several of them. The accessible name still opens with the ACTION, so a
 * bar with nowhere to send a click reads "Activity bucket …" while a jumpable
 * one reads "Jump to activity bucket …", which is the distinction this suite is
 * about.
 */
function firstIdleBar(): HTMLElement {
  const [bar] = screen.getAllByRole("button", { name: IDLE_BUCKET_NAME });
  if (!bar) {
    throw new Error("Expected the timeline to render an idle column");
  }
  return bar;
}
