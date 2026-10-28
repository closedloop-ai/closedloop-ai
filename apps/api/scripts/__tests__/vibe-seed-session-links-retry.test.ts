/**
 * ISS-12054: the GitHub session-link stage re-delivers through the retrying
 * fold, so a partial acknowledgement is re-sent instead of failing link
 * verification. The import core is replaced with one that hands the stage's
 * own `handle` a single batch, and the fold persists one session per call, so
 * the case can read which sessions each delivery carried.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fold: vi.fn(),
  ingestGoldenCorpus: vi.fn(),
}));

vi.mock("@/lib/desktop-agent-sessions-handler", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/desktop-agent-sessions-handler")
  >()),
  handleDesktopAgentSessionsEvent: mocks.fold,
}));
vi.mock("../vibe-seed/core/golden-import", () => ({
  ingestGoldenCorpus: mocks.ingestGoldenCorpus,
}));
vi.mock("../vibe-seed/github/repositories", () => ({
  ensureSeededRepositories: () => Promise.resolve(),
}));
vi.mock("../vibe-seed/github/corpus", () => ({
  pullRequestFactsLookup: () => () => undefined,
  readGoldenGitHubCorpus: () => ({ links: [], storePath: "store.sqlite" }),
}));
vi.mock("../vibe-seed/github/store-refs", () => ({
  buildGoldenSessionRefs: () =>
    new Map(
      LINKED_SESSION_IDS.map((id) => [id, { artifactRefs: [], prRefs: [] }])
    ),
}));

import type { PrismaClient } from "@repo/database";
import { isRecord } from "@/lib/type-guards";
import { linkGoldenSessionsToBranches } from "../vibe-seed/github/session-links";
import type { VibeSeedContext } from "../vibe-seed/stage";

const LINKED_SESSION_IDS = ["linked-1", "linked-2", "linked-3"];
const HANDLER_CONTEXT = {
  organizationId: "org-1",
  userId: "user-1",
  targetId: "target-1",
};

describe("linkGoldenSessionsToBranches", () => {
  beforeEach(() => {
    mocks.fold.mockImplementation((payload: unknown) => {
      const ids = sessionIds(payload);
      return Promise.resolve({
        accepted: true,
        acceptedSessionIds: ids.slice(0, 1),
      });
    });
    mocks.ingestGoldenCorpus.mockImplementation(
      async (_input, deps: { handle: (...args: unknown[]) => unknown }) => {
        const ack = await deps.handle(
          {
            batchId: crypto.randomUUID(),
            sessionCount: 4,
            sessions: [...LINKED_SESSION_IDS, "unlinked"].map(
              (externalSessionId) => ({ externalSessionId })
            ),
            wantsAcceptedSessionIds: true,
          },
          HANDLER_CONTEXT,
          {}
        );
        const persisted =
          isRecord(ack) && Array.isArray(ack.acceptedSessionIds)
            ? ack.acceptedSessionIds.length
            : 0;
        return { sessionsRead: 4, sessionsPersisted: persisted, rejected: 0 };
      }
    );
  });

  it("re-sends only the linked sessions the fold left unacknowledged", async () => {
    await linkGoldenSessionsToBranches(seedContext());

    expect(
      mocks.fold.mock.calls.map(([payload]) => sessionIds(payload))
    ).toEqual([LINKED_SESSION_IDS, ["linked-2", "linked-3"], ["linked-3"]]);
  });

  it("reports the linked sessions it re-sent and the store sessions it leaves alone (ISS-12135)", async () => {
    mocks.fold.mockImplementation((payload: unknown) =>
      Promise.resolve({
        accepted: true,
        acceptedSessionIds: sessionIds(payload),
      })
    );
    mocks.ingestGoldenCorpus.mockImplementation(
      async (_input, deps: { handle: (...args: unknown[]) => unknown }) => {
        await deps.handle(
          {
            batchId: crypto.randomUUID(),
            sessionCount: 4,
            sessions: [...LINKED_SESSION_IDS, "unlinked"].map(
              (externalSessionId) => ({ externalSessionId })
            ),
            wantsAcceptedSessionIds: true,
          },
          HANDLER_CONTEXT,
          {}
        );
        return {
          sessionsRead: 4,
          sessionsPersisted: LINKED_SESSION_IDS.length,
          rejected: 0,
        };
      }
    );
    const lines: string[] = [];

    await linkGoldenSessionsToBranches({
      ...seedContext(),
      log: (line) => lines.push(line),
    });

    expect(lines).toContain(
      "re-delivered 3 golden session(s) with branch, pull request, and commit refs; 1 store session(s) carry none and are not re-sent"
    );
  });

  it("fails naming the linked sessions a re-send could not get acknowledged", async () => {
    mocks.fold.mockImplementation(() =>
      Promise.resolve({ accepted: true, acceptedSessionIds: ["linked-1"] })
    );

    await expect(linkGoldenSessionsToBranches(seedContext())).rejects.toThrow(
      "on delivery 2: linked-2, linked-3"
    );
  });
});

function sessionIds(payload: unknown): string[] {
  if (!(isRecord(payload) && Array.isArray(payload.sessions))) {
    return [];
  }
  return payload.sessions.map((session) =>
    isRecord(session) ? String(session.externalSessionId) : ""
  );
}

function seedContext(): VibeSeedContext {
  return {
    prisma: {} as PrismaClient,
    organizationId: HANDLER_CONTEXT.organizationId,
    userId: HANDLER_CONTEXT.userId,
    desktopStorePath: null,
    corpusShiftMs: 0,
    desktopAuth: null,
    now: new Date("2026-10-05T00:00:00.000Z"),
    log: () => undefined,
  };
}
