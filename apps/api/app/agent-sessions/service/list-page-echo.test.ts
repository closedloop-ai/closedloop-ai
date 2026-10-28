import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  buildSessionListRecord,
  DEFAULT_LIST_PAGE_ECHO,
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

/**
 * ISS-9555 slice 2: the Sessions list response says which page it served.
 *
 * Before this, the only server input to the displayed page position was `total`,
 * so every host re-derived the position from its own request and nothing could
 * contradict a footer naming a page the rows were not from. The read now states
 * the position it answered at, and states ONLY that: an offset past the
 * population still comes back empty at that offset rather than being moved onto
 * another page.
 */

const ORG_ID = "019f0fcb-8336-7c4d-9f64-528fb9520c32";

describe("agentSessionsService.findSessions page echo (ISS-9555)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function installPage(input: { rows: unknown[]; total: number }) {
    const sessionDetail = buildAgentSessionDbMock({
      findMany: vi.fn().mockResolvedValue(input.rows),
      count: vi.fn().mockResolvedValue(input.total),
    });
    installDb({ sessionDetail });
    return sessionDetail;
  }

  async function findSessionsAt(input: { offset: number; limit: number }) {
    return await agentSessionsService.findSessions({
      organizationId: ORG_ID,
      filters: { limit: input.limit, offset: input.offset } as never,
    } as never);
  }

  it("echoes the honoured limit and the offset the rows came from", async () => {
    installPage({ rows: [buildSessionListRecord()], total: 55 });

    const response = await findSessionsAt({ offset: 20, limit: 10 });

    expect(response.pageInfo).toEqual({
      ...DEFAULT_LIST_PAGE_ECHO,
      limit: 10,
      offset: 20,
    });
  });

  it("answers an out-of-range offset empty AT that offset, in one read", async () => {
    const sessionDetail = installPage({ rows: [], total: 25 });

    const response = await findSessionsAt({ offset: 120, limit: 10 });

    // The published behaviour is unchanged: an overshoot is REPORTED, never
    // relocated. Serving the last page here would answer a question the caller
    // did not ask, and would cost a second full read of the same population
    // — on the cost-sorted and display-sorted paths, a second whole-population
    // keyset walk — to do it.
    expect(response.items).toEqual([]);
    expect(response.total).toBe(25);
    expect(response.pageInfo?.offset).toBe(120);
    expect(sessionDetail.findMany.mock.calls.length).toBe(1);
    const [args] = sessionDetail.findMany.mock.calls[0] ?? [];
    expect((args as { skip: number }).skip).toBe(120);
  });
});
