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

function person(id: string, firstName: string) {
  return {
    id,
    email: `${id}@example.com`,
    firstName,
    lastName: "Person",
    avatarUrl: null,
  };
}

/**
 * ISS-12251 D-4 (PLN-2176 T-3.3): the detail timeline's human turns are
 * credited to the session's creator — not to the user who recorded it
 * (`session_detail.user_id`) nor to its Owner (the assignee).
 */
describe("session detail timeline human actor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the session's creator on its prompt turns", async () => {
    const base = buildSessionDetailRecord();
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(
          buildSessionDetailRecord({
            user: person("recorder", "Rae"),
            artifact: {
              ...(base.artifact as Record<string, unknown>),
              createdAt: new Date("2026-05-20T17:00:00.000Z"),
              createdBy: person("creator", "Cy"),
              assignee: person("owner", "Oz"),
              dueDate: null,
            },
            events: [
              {
                externalEventId: "prompt-1",
                agentExternalId: null,
                eventType: "user_prompt",
                toolName: null,
                eventCreatedAt: new Date("2026-05-20T17:01:00.000Z"),
              },
            ],
          })
        ),
      },
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    const prompt = result?.turnItems?.find((item) => item.type === "prompt");
    expect(prompt?.actor.name).toBe("Cy Person");
  });
});
