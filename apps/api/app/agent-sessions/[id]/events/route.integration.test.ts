/**
 * ISS-9857: the events page walked against real Postgres, through the REAL
 * route and service. What only a planner can prove: the `externalEventId`
 * tiebreak on a same-timestamp pair that straddles a page boundary, and that
 * the keyset never repeats or skips a row across the whole 10,001-row stream —
 * one past the detail prefix's ceiling, so the walk reaches the event the
 * detail read cannot. Self-skips without `DATABASE_URL`.
 */

import type { SyncedAgentSessionEvent } from "@repo/api/src/types/agent-session";
import { SESSION_DETAIL_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-detail-limits";
import { SESSION_EVENTS_PAGE_LIMIT_BOUNDS } from "@repo/api/src/types/agent-session-events-page";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));

import { GET } from "./route";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const TOTAL_EVENTS = SESSION_DETAIL_EVENT_MAX_ROWS + 1;
const PAGE_LIMIT = SESSION_EVENTS_PAGE_LIMIT_BOUNDS.defaultLimit;
/** The last row of page 1 and the first row of page 2 share a timestamp. */
const TIE_INDEX = PAGE_LIMIT - 1;
const T0 = Date.UTC(2026, 5, 10, 10, 0, 0);
const CREATE_MANY_CHUNK = 2500;
/**
 * Spent twice per test — as `maxWait` and again as `timeout` — so the pair has
 * to fit the tier's 30 s `testTimeout`, or Vitest reaps the test first and
 * leaves the transaction running detached (ISS-8553). The tier owns the test
 * budget itself, so no trailing timeout is declared here. Worst measured on
 * one box, three back-to-back runs: 7.24 s (seed + walk + foreign-org 404).
 */
const TX_MAX_WAIT_MS = 5000;
const TX_TIMEOUT_MS = 20_000;

type PageResponse = {
  success: boolean;
  data?: { events: SyncedAgentSessionEvent[]; nextCursor?: string };
};

function eventId(index: number): string {
  return `evt-${String(index).padStart(5, "0")}`;
}

/** 1 ms apart, except the pair at the page boundary, which shares an instant. */
function eventCreatedAt(index: number): Date {
  return new Date(index > TIE_INDEX ? T0 + index - 1 : T0 + index);
}

async function seedEvents(sessionId: string): Promise<void> {
  for (let start = 0; start < TOTAL_EVENTS; start += CREATE_MANY_CHUNK) {
    const end = Math.min(start + CREATE_MANY_CHUNK, TOTAL_EVENTS);
    const data = Array.from({ length: end - start }, (_, offset) => {
      const index = start + offset;
      return {
        agentSessionId: sessionId,
        externalEventId: eventId(index),
        agentExternalId: index % 3 === 0 ? null : "agent-main",
        eventType: "tool",
        toolName: "Read",
        eventCreatedAt: eventCreatedAt(index),
      };
    });
    await withDb((db) => db.agentSessionEvent.createMany({ data }));
  }
}

async function getPage(
  sessionId: string,
  organizationId: string,
  cursor?: string
): Promise<{ status: number; body: PageResponse }> {
  mockAuthContext = createTestAuthContext({
    user: { ...createTestAuthContext().user, organizationId },
  });
  const query = cursor === undefined ? "" : `?cursor=${cursor}`;
  const response = await GET(
    createMockRequest({
      url: `http://localhost:3002/agent-sessions/${sessionId}/events${query}`,
    }),
    createMockRouteContext({ id: sessionId })
  );
  return { status: response.status, body: await response.json() };
}

function isStrictlyAfter(
  next: SyncedAgentSessionEvent,
  previous: SyncedAgentSessionEvent
): boolean {
  if (next.createdAt !== previous.createdAt) {
    return next.createdAt > previous.createdAt;
  }
  return next.externalEventId > previous.externalEventId;
}

describeIfDb(
  "GET /agent-sessions/[id]/events against Postgres (ISS-9857)",
  () => {
    it("walks 10,001 events to exhaustion across a same-timestamp page boundary, and 404s the other org", async () => {
      await autoRollbackTransaction(
        async () => {
          const orgA = await createTestOrganization();
          const userA = await createTestUser(orgA);
          const sessionId = await createTestSessionDetail({
            organizationId: orgA,
            userId: userA.id,
            label: "events-page",
          });
          const orgB = await createTestOrganization();
          await seedEvents(sessionId);

          const pages: SyncedAgentSessionEvent[][] = [];
          let cursor: string | undefined;
          let lastPage: PageResponse["data"];
          do {
            const { status, body } = await getPage(sessionId, orgA, cursor);
            expect(status).toBe(200);
            lastPage = body.data;
            if (!lastPage) {
              throw new Error("page missing from the success envelope");
            }
            expect(lastPage.events.length).toBeLessThanOrEqual(PAGE_LIMIT);
            pages.push(lastPage.events);
            cursor = lastPage.nextCursor;
          } while (cursor !== undefined);
          expect(Object.hasOwn(lastPage, "nextCursor")).toBe(false);

          const [pageOne, pageTwo] = pages;
          const lastOfPageOne = pageOne?.at(-1);
          const firstOfPageTwo = pageTwo?.[0];
          if (!(lastOfPageOne && firstOfPageTwo)) {
            throw new Error("the walk produced fewer than two pages");
          }
          expect(lastOfPageOne.createdAt).toBe(firstOfPageTwo.createdAt);
          expect(lastOfPageOne.externalEventId).toBe(eventId(TIE_INDEX));
          expect(firstOfPageTwo.externalEventId).toBe(eventId(TIE_INDEX + 1));
          expect(isStrictlyAfter(firstOfPageTwo, lastOfPageOne)).toBe(true);

          const all = pages.flat();
          expect(all).toHaveLength(TOTAL_EVENTS);
          expect(new Set(all.map((event) => event.externalEventId)).size).toBe(
            TOTAL_EVENTS
          );
          for (let index = 1; index < all.length; index += 1) {
            const previous = all[index - 1];
            const current = all[index];
            if (!(previous && current && isStrictlyAfter(current, previous))) {
              throw new Error(`order broke at row ${index}`);
            }
          }
          expect(all.at(-1)?.externalEventId).toBe(eventId(TOTAL_EVENTS - 1));
          expect(pages).toHaveLength(Math.ceil(TOTAL_EVENTS / PAGE_LIMIT));

          const foreign = await getPage(sessionId, orgB);
          expect(foreign.status).toBe(404);
          expect(foreign.body.success).toBe(false);
          expect(foreign.body.data).toBeUndefined();
        },
        { maxWait: TX_MAX_WAIT_MS, timeout: TX_TIMEOUT_MS }
      );
    });
  }
);
