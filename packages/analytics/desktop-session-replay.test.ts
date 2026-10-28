import { gunzipSync } from "node:zlib";
import { BRANCH_FILE_DIFF_CLASS } from "@repo/api/src/types/desktop-session-replay-pilot";
import posthog from "posthog-js/dist/module.full.no-external";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  discardDesktopSessionReplay,
  startDesktopSessionReplay,
  stopDesktopSessionReplay,
  waitForSentDesktopReplayBatches,
} from "./desktop-session-replay";
import { ANALYTICS_REDACTION_MARKER } from "./sensitive-query-params";

// posthog-js binds `fetch` when its module loads, so the stub must be in place
// before the import above runs. While `refusing`, a request fails the way one
// main cancels does, and posthog-js queues it for a retry. While `held`, a
// request stays on the network until that promise settles.
const sent = vi.hoisted(() => {
  const requests: { url: string; body: ArrayBuffer }[] = [];
  const refused: { url: string; body: ArrayBuffer }[] = [];
  const network: {
    refusing: boolean;
    held: Promise<void> | null;
    holding: number;
  } = { refusing: false, held: null, holding: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = {
      url: String(input),
      body: await new Response(init?.body).arrayBuffer(),
    };
    if (network.held) {
      network.holding += 1;
      await network.held;
    }
    if (network.refusing) {
      refused.push(request);
      throw new TypeError("Failed to fetch");
    }
    requests.push(request);
    return new Response('{"status":1}', { status: 200 });
  }) as typeof fetch;
  // posthog-js picks its transports when it loads, so the unload beacon must
  // exist before the import too.
  const beacons: Blob[] = [];
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (_url: string, body: Blob) => {
      beacons.push(body);
      return true;
    },
  });
  return { requests, refused, network, beacons, original };
});

const API_HOST = "https://api.stage.example/r";
const PROD_API_HOST = "https://api.closedloop.ai/r";
const DISTINCT_ID = "2f1c8f8e-3b7a-4c1d-9e2f-5a6b7c8d9e0f";
// The desktop route table's id-bearing patterns, written out: the analytics
// package does not own them.
const REPLAY_OPTIONS = {
  apiHost: API_HOST,
  distinctId: DISTINCT_ID,
  recordIdRoutes: ["/sessions/:id", "/agents/:id"],
};
// posthog-js 1.372.6 resets its UUIDv7 generator, so its next UUID sorts
// below the last, once the clock is this far behind the last UUID's time
// (`ROLLBACK_ALLOWANCE`, `lib/src/uuidv7.js:161`).
const UUIDV7_ROLLBACK_ALLOWANCE_MS = 10_000;
const SESSION_ID = "8c0d5e3a-41f2-4b9e-a7d6-0f3c2b1a9e84";
const AGENT_SLUG = "command::/cl-ci-babysit";
const PROSE = "the prompt says deploy on friday";
const CODE = "const secretKey = 42;";
const INLINE_CODE = "rotateSecret()";
const SOURCE_LINE = "export const apiToken = load();";
const TRANSCRIPT = "the agent read the private repo";
const TRACE = "tool call output with customer data";
const TYPED = "typed into the box";
const SESSION_NAME = "fix the stage deploy";
const SEARCH_TERM = "acme-outage-postmortem";
const DIFF_ADDED = "+ const branchToken = rotate();";
const DIFF_REMOVED = "- const branchToken = legacy();";
// react-diff-viewer-continued's markup: generated emotion classes, and each
// diff line in a div/ins/del inside a td. Only the gutters are pre elements.
const BRANCH_DIFF_FIXTURE = `<div class="${BRANCH_FILE_DIFF_CLASS}"><table class="css-1n5x3qj-diff-container"><tbody><tr><td><pre>12</pre></td><td><pre>-</pre></td><td><div><del>${DIFF_REMOVED}</del></div></td></tr><tr><td><pre>12</pre></td><td><pre>+</pre></td><td><div><ins>${DIFF_ADDED}</ins></div></td></tr></tbody></table></div>`;
const NON_WHITESPACE = /\S/g;
const metaDataSchema = z.object({ href: z.string() });
const MUTATED_SESSION_ID = "5b7e2c91-0d4a-4f3e-b8c6-1a2d3e4f5a6b";
const HREF_MUTATION_TARGET = "href-mutation-target";
const EXTERNAL_HREF = "https://docs.example.com/guide/sessions/1234";
// rrweb's incremental snapshot (type 3) from the mutation source (0).
const attributeMutationSchema = z.object({
  source: z.literal(0),
  attributes: z.array(
    z.object({ attributes: z.object({ href: z.string().optional() }) })
  ),
});

type SnapshotItem = { type: number; data: unknown; cv?: string };
type CapturedEvent = {
  uuid: string;
  event: string;
  properties: {
    distinct_id: string;
    $session_id: string;
    $snapshot_data?: SnapshotItem[];
  };
};

afterAll(() => {
  // Disconnects rrweb's MutationObserver before jsdom tears the globals down.
  posthog.stopSessionRecording();
  globalThis.fetch = sent.original;
  Reflect.deleteProperty(navigator, "sendBeacon");
  window.history.replaceState(null, "", "/");
});

describe("startDesktopSessionReplay (ISS-11838)", () => {
  it("sends a masked $snapshot batch, with transcript, diff and source views blocked, to <apiHost>/s and nothing else", async () => {
    // The desktop renderer's hash route, carrying what the user searched for.
    window.history.replaceState(null, "", `/#/sessions?search=${SEARCH_TERM}`);
    document.body.innerHTML = `<main><p title="${SESSION_NAME}" aria-label="${SESSION_NAME}">${PROSE}</p><div class="sd3-trace">${TRANSCRIPT}</div><div class="st">${TRACE}</div><pre>${CODE}</pre><p><code>${INLINE_CODE}</code></p><table class="font-mono"><tbody><tr><td>${SOURCE_LINE}</td></tr></tbody></table>${BRANCH_DIFF_FIXTURE}<input value="${TYPED}" /></main>`;

    startDesktopSessionReplay(REPLAY_OPTIONS);
    posthog.capture("product_event_that_must_not_leave");
    // posthog-js holds the buffer until it has seen the user interact.
    document
      .querySelector("p")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(fullSnapshot()).toBeDefined(), {
      timeout: 20_000,
      interval: 100,
    });

    const urls = sent.requests.map(({ url }) => new URL(url));
    expect(urls.map((url) => `${url.origin}${url.pathname}`)).toEqual(
      urls.map(() => `${API_HOST}/s`)
    );
    expect(
      urls.every((url) => url.searchParams.get("compression") === "gzip-js")
    ).toBe(true);

    const events = sent.requests.flatMap(decodeBatch);
    expect(new Set(events.map(({ event }) => event))).toEqual(
      new Set(["$snapshot"])
    );
    expect(
      new Set(events.map(({ properties }) => properties.distinct_id))
    ).toEqual(new Set([DISTINCT_ID]));

    const snapshot = JSON.stringify(fullSnapshot());
    // Positive controls first: the text node and the blocked element are in
    // the recording, so the absences below are not vacuous.
    expect(snapshot).toContain(PROSE.replace(NON_WHITESPACE, "*"));
    expect(snapshot).toContain("*".repeat(TYPED.length));
    expect(snapshot).toContain("rr_width");
    const maskedName = SESSION_NAME.replace(NON_WHITESPACE, "*");
    expect(snapshot).toContain(`"title":"${maskedName}"`);
    expect(snapshot).toContain(`"aria-label":"${maskedName}"`);
    // Blocked, not just masked: each view is a placeholder with no child
    // nodes, so not even the masked stand-in for its text is recorded.
    for (const [tagName, className] of [
      ["div", "sd3-trace"],
      ["div", "st"],
      ["pre", null],
      ["code", null],
      ["table", "font-mono"],
      ["div", BRANCH_FILE_DIFF_CLASS],
    ] as const) {
      expect(snapshot).toContain(blockedPlaceholder(tagName, className));
    }
    for (const blockedText of [
      TRANSCRIPT,
      TRACE,
      CODE,
      INLINE_CODE,
      SOURCE_LINE,
      DIFF_ADDED,
      DIFF_REMOVED,
    ]) {
      expect(snapshot).not.toContain(blockedText);
    }
    expect(snapshot).not.toContain("diff-container");
    expect(snapshot).not.toContain(PROSE);
    expect(snapshot).not.toContain(TYPED);
    expect(snapshot).not.toContain(SESSION_NAME);

    // The page URL is recorded without its query or hash route.
    expect(new Set(metaHrefs())).toEqual(
      new Set([`${window.location.origin}${window.location.pathname}`])
    );
    expect(JSON.stringify(events)).not.toContain(SEARCH_TERM);
  }, 30_000);

  it("records in-app link hrefs with their record ids masked and the route kept (ISS-12259)", async () => {
    // What the desktop navigation Link renders for a session, an agent and the
    // session list.
    document.body.innerHTML = `<main><a href="#/sessions/${SESSION_ID}">session</a><a href="#/agents/${encodeURIComponent(AGENT_SLUG)}">agent</a><a href="#/sessions">sessions</a></main>`;

    startDesktopSessionReplay(REPLAY_OPTIONS);
    document
      .querySelector("main")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(sentEvents()).toContain("#/agents/"), {
      timeout: 20_000,
      interval: 100,
    });

    const events = sentEvents();
    // rrweb records an href resolved against the page URL.
    const page = window.location.href.split("#")[0];
    expect(events).toContain(
      `"href":"${page}#/sessions/${ANALYTICS_REDACTION_MARKER}"`
    );
    expect(events).toContain(
      `"href":"${page}#/agents/${ANALYTICS_REDACTION_MARKER}"`
    );
    expect(events).toContain(`"href":"${page}#/sessions"`);
    expect(events).not.toContain(SESSION_ID);
    expect(events).not.toContain(encodeURIComponent(AGENT_SLUG));
  }, 30_000);

  it("records a link href that is not a hash route unchanged (ISS-12259)", async () => {
    document.body.innerHTML = `<main><a href="${EXTERNAL_HREF}">docs</a></main>`;

    startDesktopSessionReplay(REPLAY_OPTIONS);
    document
      .querySelector("main")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(
      () => expect(sentEvents()).toContain(`"href":"${EXTERNAL_HREF}"`),
      { timeout: 20_000, interval: 100 }
    );
  }, 30_000);

  it("masks the record id when a recorded link's href changes (ISS-12259)", async () => {
    document.body.innerHTML = `<main><a class="${HREF_MUTATION_TARGET}" href="#/sessions">sessions</a></main>`;

    startDesktopSessionReplay(REPLAY_OPTIONS);
    const main = document.querySelector("main");
    main?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(
      () => expect(sentEvents()).toContain(HREF_MUTATION_TARGET),
      { timeout: 20_000, interval: 100 }
    );

    // rrweb sends a changed attribute as an attribute mutation, not a new node.
    document
      .querySelector(`.${HREF_MUTATION_TARGET}`)
      ?.setAttribute("href", `#/sessions/${MUTATED_SESSION_ID}`);
    main?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const page = window.location.href.split("#")[0];
    await vi.waitFor(
      () =>
        expect(mutatedHrefs()).toContain(
          `${page}#/sessions/${ANALYTICS_REDACTION_MARKER}`
        ),
      { timeout: 20_000, interval: 100 }
    );
    expect(sentEvents()).not.toContain(MUTATED_SESSION_ID);
  }, 30_000);

  it("stops recording on stop and resumes on the next start", async () => {
    startDesktopSessionReplay(REPLAY_OPTIONS);
    await vi.waitFor(() =>
      expect(posthog.sessionRecordingStarted()).toBe(true)
    );

    stopDesktopSessionReplay();
    expect(posthog.sessionRecordingStarted()).toBe(false);

    startDesktopSessionReplay(REPLAY_OPTIONS);
    await vi.waitFor(() =>
      expect(posthog.sessionRecordingStarted()).toBe(true)
    );
  });

  it("records a resume as a new $session_id under the same distinct id (ISS-12222)", async () => {
    startDesktopSessionReplay(REPLAY_OPTIONS);
    await vi.waitFor(() =>
      expect(posthog.sessionRecordingStarted()).toBe(true)
    );
    const stoppedSessionId = posthog.get_session_id();
    expect(stoppedSessionId).toEqual(expect.any(String));
    stopDesktopSessionReplay();

    startDesktopSessionReplay(REPLAY_OPTIONS);
    await vi.waitFor(() =>
      expect(posthog.sessionRecordingStarted()).toBe(true)
    );

    expect(posthog.get_session_id()).toEqual(expect.any(String));
    expect(posthog.get_session_id()).not.toBe(stoppedSessionId);
    expect(posthog.get_distinct_id()).toBe(DISTINCT_ID);
  });

  it("does not resume against another apiHost", async () => {
    startDesktopSessionReplay(REPLAY_OPTIONS);
    await vi.waitFor(() =>
      expect(posthog.sessionRecordingStarted()).toBe(true)
    );
    stopDesktopSessionReplay();

    startDesktopSessionReplay({ ...REPLAY_OPTIONS, apiHost: PROD_API_HOST });

    // startSessionRecording clears this synchronously; the recorder starts later.
    expect(posthog.config.disable_session_recording).toBe(true);
    expect(posthog.config.api_host).toBe(API_HOST);
  });
});

describe("discardDesktopSessionReplay (ISS-12257)", () => {
  it("drops the session's unsent tail instead of flushing it, and the next session's batches still leave", async () => {
    const sessionId = await recordUntilABatchLeaves();

    const tail = snapshotUuids(
      captureWhile(() => {
        interact("before the sign-in flip");
        discardDesktopSessionReplay();
      }),
      sessionId
    );

    // Positive control: the discard had a tail to drop.
    expect(tail).not.toEqual([]);
    expect(posthog.sessionRecordingStarted()).toBe(false);
    const nextSessionId = await recordUntilABatchLeaves();
    expect(nextSessionId).not.toBe(sessionId);
    // posthog-js sends its queue in order, so a flushed tail would have left
    // no later than the next session's first batch.
    expect(tail.filter((uuid) => deliveredUuids().has(uuid))).toEqual([]);
  }, 60_000);

  it("drops a batch refused before the discard when posthog-js retries it", async () => {
    const sessionId = await recordUntilABatchLeaves();
    sent.network.refusing = true;
    try {
      interact("refused while main's sign-in state differs");
      await vi.waitFor(() => expect(refusedUuids(sessionId)).not.toEqual([]), {
        timeout: 15_000,
        interval: 100,
      });
      await vi.waitFor(() =>
        expect(posthog._retryQueue?.length).toBeGreaterThan(0)
      );
    } finally {
      sent.network.refusing = false;
    }
    const refused = refusedUuids(sessionId);

    discardDesktopSessionReplay();

    await vi.waitFor(() => expect(posthog._retryQueue?.length).toBe(0), {
      timeout: 20_000,
      interval: 100,
    });
    await recordUntilABatchLeaves();
    expect(refused.filter((uuid) => deliveredUuids().has(uuid))).toEqual([]);
  }, 60_000);

  it("drops a snapshot captured before a clock rollback that precedes the discard", async () => {
    const sessionId = await recordUntilABatchLeaves();
    sent.network.refusing = true;
    try {
      interact("refused before the clock goes back");
      await vi.waitFor(() => expect(refusedUuids(sessionId)).not.toEqual([]), {
        timeout: 15_000,
        interval: 100,
      });
      await vi.waitFor(() =>
        expect(posthog._retryQueue?.length).toBeGreaterThan(0)
      );
    } finally {
      sent.network.refusing = false;
    }
    const refused = refusedUuids(sessionId);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(
        Math.max(...refused.map(uuidV7Milliseconds)) -
          UUIDV7_ROLLBACK_ALLOWANCE_MS
      );
    let tail: string[];
    try {
      tail = snapshotUuids(
        captureWhile(() => {
          interact("after the clock goes back");
          discardDesktopSessionReplay();
        }),
        sessionId
      );
    } finally {
      clock.mockRestore();
    }

    // Positive control: the rollback stamped the discard's own flush below
    // the refused batch, so the newest captured UUID is not the largest.
    expect(tail).not.toEqual([]);
    const newest = tail.at(-1) ?? "";
    expect(refused.filter((uuid) => uuid > newest)).not.toEqual([]);
    await vi.waitFor(() => expect(posthog._retryQueue?.length).toBe(0), {
      timeout: 20_000,
      interval: 100,
    });
    await recordUntilABatchLeaves();
    expect(
      [...refused, ...tail].filter((uuid) => deliveredUuids().has(uuid))
    ).toEqual([]);
  }, 60_000);
});

describe("waitForSentDesktopReplayBatches (ISS-12257)", () => {
  it("resolves only once the batches already on the network are answered", async () => {
    await recordUntilABatchLeaves();
    let release: () => void = () => undefined;
    sent.network.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      interact("on the network across the flip");
      await vi.waitUntil(() => sent.network.holding > 0, {
        timeout: 15_000,
        interval: 100,
      });
      const order: string[] = [];
      const answered = waitForSentDesktopReplayBatches().then(() => {
        order.push("answered");
      });
      // A macrotask, so a wait that did not wait has already resolved.
      await new Promise((resolve) => setTimeout(resolve, 0));
      order.push("released");
      release();
      await answered;

      expect(order).toEqual(["released", "answered"]);
    } finally {
      sent.network.held = null;
      release();
    }
  }, 60_000);
});

describe("replay outside a sign-in flip (ISS-12257 AC3)", () => {
  it("flushes a stopped session's unsent tail", async () => {
    const sessionId = await recordUntilABatchLeaves();

    const tail = snapshotUuids(
      captureWhile(() => {
        interact("before the gate closes");
        stopDesktopSessionReplay();
      }),
      sessionId
    );

    expect(tail).not.toEqual([]);
    await vi.waitFor(
      () =>
        expect(tail.filter((uuid) => !deliveredUuids().has(uuid))).toEqual([]),
      { timeout: 15_000, interval: 100 }
    );
  }, 60_000);

  // Last in the file: the unload stops posthog-js's queues listening.
  it("flushes the unsent tail in the unload beacon when the app quits", async () => {
    const sessionId = await recordUntilABatchLeaves();

    const tail = snapshotUuids(
      captureWhile(() => {
        interact("before quit");
        window.dispatchEvent(new Event("beforeunload"));
        window.dispatchEvent(new Event("pagehide"));
        window.dispatchEvent(new Event("unload"));
      }),
      sessionId
    );

    expect(tail).not.toEqual([]);
    const beaconed = new Set(
      (await Promise.all(sent.beacons.map(decodeBeacon)))
        .flat()
        .map(({ uuid }) => uuid)
    );
    expect(tail.filter((uuid) => !beaconed.has(uuid))).toEqual([]);
  }, 60_000);
});

function decodeBatch({ body }: { body: ArrayBuffer }): CapturedEvent[] {
  return JSON.parse(
    gunzipSync(Buffer.from(body)).toString("utf8")
  ) as CapturedEvent[];
}

/** The rrweb full snapshot (type 2), with posthog's per-event compression undone. */
function fullSnapshot(): unknown {
  for (const event of sent.requests.flatMap(decodeBatch)) {
    for (const item of event.properties.$snapshot_data ?? []) {
      if (item.type === 2) {
        return typeof item.data === "string"
          ? JSON.parse(
              gunzipSync(Buffer.from(item.data, "latin1")).toString("utf8")
            )
          : item.data;
      }
    }
  }
  return undefined;
}

/** The page URL of every rrweb Meta event (type 4) sent. */
function metaHrefs(): string[] {
  return sent.requests
    .flatMap(decodeBatch)
    .flatMap(({ properties }) => properties.$snapshot_data ?? [])
    .filter((item) => item.type === 4)
    .map((item) => metaDataSchema.parse(item.data).href);
}

/** How rrweb serializes an element it blocked: sized, with no children. */
function blockedPlaceholder(tagName: string, className: string | null) {
  const classAttribute = className === null ? "" : `"class":"${className}",`;
  return `"tagName":"${tagName}","attributes":{${classAttribute}"rr_width":"0px","rr_height":"0px"},"childNodes":[]`;
}

const capturedSnapshotSchema = z.object({
  uuid: z.string(),
  event: z.literal("$snapshot"),
  properties: z.object({ $session_id: z.string() }),
});

/** Starts (or resumes) recording and waits until one of its batches has left. */
async function recordUntilABatchLeaves(): Promise<string> {
  startDesktopSessionReplay(REPLAY_OPTIONS);
  await vi.waitUntil(() => posthog.sessionRecordingStarted());
  const sessionId = posthog.get_session_id();
  interact("recording");
  await vi.waitUntil(
    () =>
      sent.requests
        .flatMap(decodeBatch)
        .some(({ properties }) => properties.$session_id === sessionId),
    { timeout: 15_000, interval: 100 }
  );
  return sessionId;
}

/** A DOM change and a click, so the recording has something new to buffer. */
function interact(label: string): void {
  const node = document.createElement("p");
  node.textContent = label;
  document.body.append(node);
  node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** The events posthog-js captured while `act` ran. */
function captureWhile(act: () => void): unknown[] {
  const captured: unknown[] = [];
  const unsubscribe = posthog.on("eventCaptured", (event: unknown) => {
    captured.push(event);
  });
  try {
    act();
  } finally {
    unsubscribe();
  }
  return captured;
}

function snapshotUuids(events: unknown[], sessionId: string): string[] {
  return events.flatMap((event) => {
    const snapshot = capturedSnapshotSchema.safeParse(event);
    return snapshot.success &&
      snapshot.data.properties.$session_id === sessionId
      ? [snapshot.data.uuid]
      : [];
  });
}

function deliveredUuids(): Set<string> {
  return new Set(sent.requests.flatMap(decodeBatch).map(({ uuid }) => uuid));
}

function refusedUuids(sessionId: string): string[] {
  return sent.refused
    .flatMap(decodeBatch)
    .filter(({ properties }) => properties.$session_id === sessionId)
    .map(({ uuid }) => uuid);
}

async function decodeBeacon(body: Blob): Promise<CapturedEvent[]> {
  return decodeBatch({ body: await body.arrayBuffer() });
}

/** Every event sent so far, as one JSON string. */
function sentEvents(): string {
  return JSON.stringify(sent.requests.flatMap(decodeBatch));
}

/** The `href` of every rrweb attribute mutation sent so far. */
function mutatedHrefs(): string[] {
  return sent.requests
    .flatMap(decodeBatch)
    .flatMap(({ properties }) => properties.$snapshot_data ?? [])
    .filter((item) => item.type === 3)
    .flatMap((item) => {
      const mutation = attributeMutationSchema.safeParse(item.data);
      return mutation.success ? mutation.data.attributes : [];
    })
    .flatMap(({ attributes }) => attributes.href ?? []);
}

/** A UUIDv7's `unix_ts_ms`: its first 48 bits (RFC 9562 §5.7). */
function uuidV7Milliseconds(uuid: string): number {
  return Number.parseInt(`${uuid.slice(0, 8)}${uuid.slice(9, 13)}`, 16);
}
