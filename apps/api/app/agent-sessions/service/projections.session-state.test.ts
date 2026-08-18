/**
 * ISS-5592: the status→state projection's EXHAUSTIVE lifecycle mapping.
 *
 * Split out of `projections.test.ts` rather than appended to it: that file is
 * grandfathered well past the 1,000-line ceiling, and the repo asks that a
 * substantive change leave such a file smaller rather than larger. This suite is
 * one cohesive responsibility (`toAgentSessionState`'s status arm), so it is the
 * natural seam.
 */
import { AgentSessionState } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
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

/*
 * ISS-5592: the status→state projection is an exhaustive
 * `Record<SessionStatus, …>` (`TERMINAL_AGENT_SESSION_STATE`), so adding a
 * fourth lifecycle status fails `tsc` until it is intentionally mapped. That
 * compile-time guard is the actual fix; these pin the RUNTIME half of the same
 * contract, which `tsc` cannot see:
 *   • every lifecycle status resolves to a state (no member falls through the
 *     table to `undefined` and silently takes the non-terminal path), and
 *   • each one resolves to the state this projection has always reported.
 * Without the second, a mapping could be swapped for another valid member and
 * both the type and a mere "is defined" assertion would stay green.
 */
describe("toAgentSessionState — exhaustive lifecycle mapping (ISS-5592)", () => {
  async function stateForStatus(status: string) {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            state: null,
            artifact: {
              name: `Session ${status}`,
              status,
              slug: "SES-EXHAUSTIVE",
              project: null,
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });
    return result.items[0]?.state;
  }

  it.each([
    [SESSION_STATUS.INACTIVE, AgentSessionState.Completed],
    [SESSION_STATUS.ERROR, AgentSessionState.Error],
  ])("maps the terminal status %s to %s", async (status, expected) => {
    expect(await stateForStatus(status)).toBe(expected);
  });

  it("leaves ACTIVE to the non-terminal derivations rather than the table", async () => {
    // The `null` entry is a deliberate mapping, not an omission — it is what
    // routes a live run PAST the table to the awaiting-input branch. Proving
    // that needs a record only that branch can answer: awaiting input, not
    // ended. A table that wrongly returned a terminal state for ACTIVE would
    // short-circuit before it and still typecheck.
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            state: null,
            awaitingInputSince: new Date("2026-05-20T17:03:00.000Z"),
            sessionEndedAt: null,
            artifact: {
              name: "Live awaiting session",
              status: SESSION_STATUS.ACTIVE,
              slug: "SES-EXHAUSTIVE-ACTIVE",
              project: null,
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.state).toBe(AgentSessionState.PendingApproval);
  });

  it("resolves a state for EVERY lifecycle status, with none falling through", async () => {
    // Derived from the const, so a member added to SESSION_STATUS is covered
    // here the moment it exists rather than needing this list updated.
    for (const status of Object.values(SESSION_STATUS)) {
      expect(await stateForStatus(status)).toBeDefined();
    }
  });
});
