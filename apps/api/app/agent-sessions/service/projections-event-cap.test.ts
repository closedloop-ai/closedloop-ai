/**
 * ISS-5075: the session-detail `events` read shape, pinned as one object.
 *
 * The three parts only mean something together. The `take` is what bounds the
 * read; the deterministic `orderBy` is what makes the bounded set a stable
 * chronological PREFIX rather than an arbitrary sample; and the explicit
 * `select` is the five columns the projection maps, so the bounded read stops
 * carrying the parent id, row id, and per-row `createdAt` it discards. Reading
 * one row PAST the ceiling is what makes a read that HIT it detectable.
 *
 * Its own file because `projections.test.ts` is on the shrink-only grandfather
 * list — the sibling suite there keeps the looser ordering assertion it always
 * had, and this pins the whole shape.
 */

import { SESSION_DETAIL_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-detail-limits";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionDetailRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("session detail events read shape (ISS-5075)", () => {
  it("selects the served columns, orders deterministically, and reads one past the cap", async () => {
    const findFirst = vi.fn().mockResolvedValue(buildSessionDetailRecord());
    installDb({
      sessionDetail: { findFirst },
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          events: {
            select: {
              externalEventId: true,
              agentExternalId: true,
              eventType: true,
              toolName: true,
              eventCreatedAt: true,
            },
            orderBy: [
              { eventCreatedAt: "asc" },
              { externalEventId: "asc" },
              { id: "asc" },
            ],
            take: SESSION_DETAIL_EVENT_MAX_ROWS + 1,
          },
        }),
      })
    );
  });
});
