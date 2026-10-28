import { Priority } from "@repo/api/src/types/common";
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionDetailRecord,
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";
import { toSessionListItem } from "./projections";
import type { AgentSessionListRecord } from "./records";

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

function withPriority(
  build: (overrides: Record<string, unknown>) => Record<string, unknown>,
  priority: Priority | null
) {
  const base = build({});
  return build({
    artifact: { ...(base.artifact as Record<string, unknown>), priority },
  });
}

describe("ISS-10332: session priority on the read path", () => {
  it("serves the stored priority on the list item, and an explicit null for a session holding none", () => {
    const item = (priority: Priority | null) =>
      toSessionListItem(
        withPriority(buildSessionListRecord, priority) as AgentSessionListRecord
      );

    expect(item(Priority.Urgent).priority).toBe(Priority.Urgent);
    // `null`, not omitted: omission is reserved for a producer that does not
    // know, and this one does.
    expect(item(null)).toHaveProperty("priority", null);
  });

  it("serves it on the detail response through the same projection", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            withPriority(buildSessionDetailRecord, Priority.Low)
          ),
      },
    });

    const detail = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(detail?.priority).toBe(Priority.Low);
  });
});
