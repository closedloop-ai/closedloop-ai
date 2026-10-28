import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  handleDesktopAgentSessionsEvent: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return { ...actual, withDb: mocks.withDb };
});
vi.mock("@/lib/desktop-agent-sessions-handler", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/desktop-agent-sessions-handler")
    >();
  return {
    ...actual,
    handleDesktopAgentSessionsEvent: mocks.handleDesktopAgentSessionsEvent,
  };
});

import { DesktopAgentSessionsAckReason } from "@repo/api/src/types/agent-session";
import {
  VIBE_SEED_MACHINE_NAME,
  VIBE_SEED_SIGNED_IN_LOGIN,
} from "@repo/api/src/vibe-seed-corpus";
import { desktopAgentSessionsPayloadObjectSchema } from "@/lib/desktop-agent-sessions-schema";
import { isRecord } from "@/lib/type-guards";
import {
  type CorpusShiftTally,
  computeCorpusShiftMs,
  readNewestCorpusActivity,
  shiftWireSession,
} from "../vibe-seed/core/corpus-shift";
import { ingestGoldenCorpus } from "../vibe-seed/core/golden-import";
import { mapSnapshot } from "./perf-import-snapshot-fixture";
import {
  BUILDER_CLOCK_ISO,
  NEWER_ACTIVITY_METRICS_ROW,
  NEWER_SESSION,
  OLDER_SESSION,
  withTwoSessionStore,
} from "./vibe-seed-store-fixture";

const NOW_ISO = "2026-10-05T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const GOLDEN_IMPORT_SUMMARY = /^golden import: \d+\/\d+ sessions persisted/;
const SHIFT_MS = NOW_MS - Date.parse(NEWER_SESSION.lastActivityAt);
const ORG_ID = "0192f0a0-0000-7000-8000-0000000000a1";
const USER_ID = "0192f0a0-0000-7000-8000-0000000000b1";
const TARGET_ID = "0192f0a0-0000-7000-8000-0000000000c1";
const MINUTE_MS = 60_000;
const TEAMMATE_USER_ID = "0192f0a0-0000-7000-8000-0000000000b2";
const SINGLE_OWNER = () =>
  Promise.resolve({ userId: USER_ID, machineName: VIBE_SEED_MACHINE_NAME });

function shifted(iso: string): string {
  return new Date(Date.parse(iso) + SHIFT_MS).toISOString();
}

function sessionById(
  sessions: readonly unknown[],
  id: string
): Record<string, unknown> {
  const found = sessions.find(
    (session) => isRecord(session) && session.externalSessionId === id
  );
  if (!isRecord(found)) {
    throw new Error(`session ${id} missing from the payload`);
  }
  return found;
}

function firstChild(
  session: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const rows = session[key];
  const first = Array.isArray(rows) ? rows[0] : undefined;
  if (!isRecord(first)) {
    throw new Error(`session has no ${key}`);
  }
  return first;
}

describe("computeCorpusShiftMs", () => {
  it("moves the newest corpus instant exactly onto now", () => {
    expect(computeCorpusShiftMs(NEWER_SESSION.lastActivityAt, NOW_ISO)).toBe(
      SHIFT_MS
    );
  });

  it("is zero for a store that was already shifted to the same now", () => {
    expect(computeCorpusShiftMs(NOW_ISO, NOW_ISO)).toBe(0);
  });

  it("refuses an instant it cannot parse", () => {
    expect(() => computeCorpusShiftMs("not a date", NOW_ISO)).toThrow(
      "cannot compute the corpus shift"
    );
  });
});

describe("readNewestCorpusActivity", () => {
  it("reads the newest last_activity_at across the store's sessions", async () => {
    const newest = await withTwoSessionStore((path) =>
      readNewestCorpusActivity(path)
    );
    expect(newest).toBe(NEWER_SESSION.lastActivityAt);
  });
});

describe("shiftWireSession", () => {
  it("shifts every corpus timestamp of both sessions by one shift, keeping their gap", async () => {
    const { sessions } = await withTwoSessionStore((path) => mapSnapshot(path));
    const tally: CorpusShiftTally = { clampedToNow: 0 };
    const shift = { shiftMs: SHIFT_MS, nowMs: NOW_MS };
    const newer = shiftWireSession(
      sessionById(sessions, NEWER_SESSION.id),
      shift,
      tally
    );
    const older = shiftWireSession(
      sessionById(sessions, OLDER_SESSION.id),
      shift,
      tally
    );

    expect(newer.endedAt).toBe(NOW_ISO);
    expect(newer.startedAt).toBe(shifted("2026-08-01T10:00:00.000Z"));
    expect(older.startedAt).toBe(shifted(OLDER_SESSION.startedAt));
    expect(
      Date.parse(String(newer.startedAt)) - Date.parse(String(older.startedAt))
    ).toBe(
      Date.parse("2026-08-01T10:00:00.000Z") -
        Date.parse(OLDER_SESSION.startedAt)
    );
    expect(firstChild(newer, "events").createdAt).toBe(
      shifted("2026-08-01T10:05:00.000Z")
    );
    expect(firstChild(newer, "tokenEvents").createdAt).toBe(
      shifted("2026-08-01T10:06:00.000Z")
    );
    expect(firstChild(newer, "agents").startedAt).toBe(
      shifted("2026-08-01T10:00:00.000Z")
    );
    expect(firstChild(newer, "components").lastInvokedAt).toBe(
      shifted("2026-08-01T10:20:00.000Z")
    );
    expect(firstChild(newer, "activitySegmentRows").startMs).toBe(
      1_786_151_948_897 + SHIFT_MS
    );
    expect(newer.sessionAnalytics).toMatchObject({
      startedAt: shifted("2026-08-01T10:00:00.000Z"),
      startedDay: shifted("2026-08-01T10:00:00.000Z").slice(0, 10),
    });
  });

  it("clamps a timestamp the store builder stamped with its own clock to now, and tallies it", async () => {
    const { sessions } = await withTwoSessionStore((path) => mapSnapshot(path));
    const tally: CorpusShiftTally = { clampedToNow: 0 };
    const older = shiftWireSession(
      sessionById(sessions, OLDER_SESSION.id),
      { shiftMs: SHIFT_MS, nowMs: NOW_MS },
      tally
    );

    expect(Date.parse(BUILDER_CLOCK_ISO) + SHIFT_MS).toBeGreaterThan(NOW_MS);
    expect(older.updatedAt).toBe(NOW_ISO);
    expect(tally.clampedToNow).toBeGreaterThan(0);
  });

  it("leaves the input session untouched", async () => {
    const { sessions } = await withTwoSessionStore((path) => mapSnapshot(path));
    const original = sessionById(sessions, NEWER_SESSION.id);
    const before = JSON.stringify(original);
    shiftWireSession(
      original,
      { shiftMs: SHIFT_MS, nowMs: NOW_MS },
      {
        clampedToNow: 0,
      }
    );
    expect(JSON.stringify(original)).toBe(before);
  });
});

function makeFakeDb() {
  return {
    computeTarget: { upsert: vi.fn() },
  };
}

describe("ingestGoldenCorpus", () => {
  let db: ReturnType<typeof makeFakeDb>;

  beforeEach(() => {
    db = makeFakeDb();
    db.computeTarget.upsert.mockResolvedValue({ id: TARGET_ID });
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );
    mocks.handleDesktopAgentSessionsEvent.mockResolvedValue({
      accepted: true,
      acceptedSessionIds: [OLDER_SESSION.id, NEWER_SESSION.id],
    });
  });

  it("hands the fold shifted sessions, with the store's activity metrics, through the vibe compute target", async () => {
    const summary = await withTwoSessionStore((path) =>
      ingestGoldenCorpus({
        storePath: path,
        organizationId: ORG_ID,
        resolveOwner: SINGLE_OWNER,
        shift: { shiftMs: SHIFT_MS, nowMs: NOW_MS },
        log: () => undefined,
      })
    );

    expect(summary.sessionsPersisted).toBe(2);
    expect(mocks.handleDesktopAgentSessionsEvent).toHaveBeenCalledTimes(1);
    const [payload, principal] =
      mocks.handleDesktopAgentSessionsEvent.mock.calls[0] ?? [];
    expect(principal).toStrictEqual({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetId: TARGET_ID,
    });
    expect(
      desktopAgentSessionsPayloadObjectSchema.safeParse(payload).success
    ).toBe(true);
    const sessions = isRecord(payload) ? payload.sessions : undefined;
    if (!Array.isArray(sessions)) {
      throw new Error("payload carries no sessions");
    }
    const newer = sessionById(sessions, NEWER_SESSION.id);
    expect(newer.endedAt).toBe(NOW_ISO);
    expect(
      NOW_MS - Date.parse(String(firstChild(newer, "events").createdAt))
    ).toBe(85 * MINUTE_MS);
    expect(newer.activityMetrics).toStrictEqual({
      autonomyBand: NEWER_ACTIVITY_METRICS_ROW.autonomyBand,
      coverage: NEWER_ACTIVITY_METRICS_ROW.coverage,
      spendLowConfUsd: NEWER_ACTIVITY_METRICS_ROW.spendLow,
      spendMediumConfUsd: NEWER_ACTIVITY_METRICS_ROW.spendMedium,
      spendHighConfUsd: NEWER_ACTIVITY_METRICS_ROW.spendHigh,
      segmentCount: NEWER_ACTIVITY_METRICS_ROW.segmentCount,
      coveredSegmentCount: NEWER_ACTIVITY_METRICS_ROW.coveredSegmentCount,
      classifierVersion: NEWER_ACTIVITY_METRICS_ROW.version,
      metricVersion: NEWER_ACTIVITY_METRICS_ROW.metricVersion,
    });
    expect("activityMetrics" in sessionById(sessions, OLDER_SESSION.id)).toBe(
      false
    );
  });

  it("imports through the vibe compute target", async () => {
    await withTwoSessionStore((path) =>
      ingestGoldenCorpus({
        storePath: path,
        organizationId: ORG_ID,
        resolveOwner: SINGLE_OWNER,
        shift: { shiftMs: SHIFT_MS, nowMs: NOW_MS },
        log: () => undefined,
      })
    );
    expect(db.computeTarget.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_machineName: {
            userId: USER_ID,
            machineName: VIBE_SEED_MACHINE_NAME,
          },
        },
      })
    );
  });

  it("leaves the persisted-of-read count to a caller that picks which sessions it delivers (ISS-12135)", async () => {
    const own: string[] = [];
    const delivering: string[] = [];
    await withTwoSessionStore(async (path) => {
      const input = {
        storePath: path,
        organizationId: ORG_ID,
        resolveOwner: SINGLE_OWNER,
        shift: { shiftMs: SHIFT_MS, nowMs: NOW_MS },
      };
      await ingestGoldenCorpus({ ...input, log: (line) => own.push(line) });
      await ingestGoldenCorpus(
        { ...input, log: (line) => delivering.push(line) },
        {
          handle: () =>
            Promise.resolve({ accepted: true, acceptedSessionIds: [] }),
        }
      );
    });

    expect(own).toContainEqual(expect.stringMatching(GOLDEN_IMPORT_SUMMARY));
    expect(delivering).not.toContainEqual(
      expect.stringMatching(GOLDEN_IMPORT_SUMMARY)
    );
  });

  it("imports each person's sessions under that person's user and machine (ISS-12135)", async () => {
    await withTwoSessionStore(async (path) => {
      const db = new DatabaseSync(path);
      try {
        const setCwd = db.prepare("UPDATE sessions SET cwd = ? WHERE id = ?");
        setCwd.run(
          `/Users/${VIBE_SEED_SIGNED_IN_LOGIN}/acme-web`,
          NEWER_SESSION.id
        );
        setCwd.run("/Users/dreyes/acme-web", OLDER_SESSION.id);
      } finally {
        db.close();
      }
      await ingestGoldenCorpus({
        storePath: path,
        organizationId: ORG_ID,
        resolveOwner: (login) =>
          Promise.resolve(
            login === VIBE_SEED_SIGNED_IN_LOGIN
              ? { userId: USER_ID, machineName: VIBE_SEED_MACHINE_NAME }
              : { userId: TEAMMATE_USER_ID, machineName: "daniels-macbook-pro" }
          ),
        shift: { shiftMs: SHIFT_MS, nowMs: NOW_MS },
        log: () => undefined,
      });
    });
    const imported = mocks.handleDesktopAgentSessionsEvent.mock.calls.map(
      ([payload, principal]) => ({
        userId: isRecord(principal) ? principal.userId : undefined,
        sessions:
          isRecord(payload) && Array.isArray(payload.sessions)
            ? payload.sessions.map((session: unknown) =>
                isRecord(session) ? session.externalSessionId : undefined
              )
            : [],
      })
    );
    expect(imported).toEqual(
      expect.arrayContaining([
        { userId: USER_ID, sessions: [NEWER_SESSION.id] },
        { userId: TEAMMATE_USER_ID, sessions: [OLDER_SESSION.id] },
      ])
    );
    expect(imported).toHaveLength(2);
  });

  it("re-sends only the sessions the fold left unacknowledged (ISS-12054)", async () => {
    mocks.handleDesktopAgentSessionsEvent
      .mockResolvedValueOnce({
        accepted: true,
        acceptedSessionIds: [OLDER_SESSION.id],
      })
      .mockResolvedValueOnce({
        accepted: true,
        acceptedSessionIds: [NEWER_SESSION.id],
      });

    const summary = await withTwoSessionStore((path) =>
      ingestGoldenCorpus({
        storePath: path,
        organizationId: ORG_ID,
        resolveOwner: SINGLE_OWNER,
        shift: { shiftMs: SHIFT_MS, nowMs: NOW_MS },
        log: () => undefined,
      })
    );

    expect(summary.sessionsPersisted).toBe(2);
    expect(mocks.handleDesktopAgentSessionsEvent).toHaveBeenCalledTimes(2);
    const [retried] = mocks.handleDesktopAgentSessionsEvent.mock.calls[1] ?? [];
    expect(
      desktopAgentSessionsPayloadObjectSchema.safeParse(retried).success
    ).toBe(true);
    const sessions = isRecord(retried) ? retried.sessions : undefined;
    if (!Array.isArray(sessions)) {
      throw new Error("the re-send carries no sessions");
    }
    expect(
      sessions.map((session) =>
        isRecord(session) ? session.externalSessionId : undefined
      )
    ).toEqual([NEWER_SESSION.id]);
  });

  it("stops re-sending once a round makes no progress, keeping the short count (ISS-12054)", async () => {
    mocks.handleDesktopAgentSessionsEvent
      .mockResolvedValueOnce({
        accepted: true,
        acceptedSessionIds: [OLDER_SESSION.id],
      })
      .mockResolvedValueOnce({ accepted: true, acceptedSessionIds: [] });
    const logged: string[] = [];

    const summary = await withTwoSessionStore((path) =>
      ingestGoldenCorpus({
        storePath: path,
        organizationId: ORG_ID,
        resolveOwner: SINGLE_OWNER,
        shift: { shiftMs: SHIFT_MS, nowMs: NOW_MS },
        log: (message) => logged.push(message),
      })
    );

    expect(summary.sessionsPersisted).toBe(1);
    expect(mocks.handleDesktopAgentSessionsEvent).toHaveBeenCalledTimes(2);
    expect(logged.some((line) => line.includes(NEWER_SESSION.id))).toBe(true);
  });

  it("fails loudly when the fold rejects a batch", async () => {
    mocks.handleDesktopAgentSessionsEvent.mockResolvedValue({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
      detail: "sessions.0.status: required",
    });
    await expect(
      withTwoSessionStore((path) =>
        ingestGoldenCorpus({
          storePath: path,
          organizationId: ORG_ID,
          resolveOwner: SINGLE_OWNER,
          shift: { shiftMs: SHIFT_MS, nowMs: NOW_MS },
          log: () => undefined,
        })
      )
    ).rejects.toThrow("golden import rejected 1 batch(es)");
  });
});
