// ISS-4449: server-side per-session Linked-artifacts projection tests. Split out
// of projections.test.ts (grandfathered over the 1000-line ceiling) so the
// wire-shape coverage lives in its own sibling. The projection carries the FULL
// resolved link set on the wire (the display cap is applied client-side, so an
// older Desktop that ignores linkedArtifactsTotal cannot silently render a capped
// set as complete) alongside the true resolved total.

import { DocumentType } from "@repo/api/src/types/document";
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

describe("agentSessionsService linked-artifacts projection (ISS-4449)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The API carries the FULL resolved link set on the wire (no server-side slice)
  // so an older Desktop that ignores linkedArtifactsTotal still renders every pill
  // rather than silently treating a capped set as complete. The client applies the
  // display cap + "+N" overflow itself.
  it("carries the full resolved link set and the true total on the wire", async () => {
    const total = 27;
    const sourceLinks = Array.from({ length: total }, (_unused, index) => ({
      metadata: { role: "input", method: "mcp_tool_call", isPrimary: false },
      target: {
        id: `doc-artifact-${index}`,
        name: `Doc ${index}`,
        slug: `DOC-${index}`,
        type: "DOCUMENT",
        subtype: DocumentType.Doc,
        branch: null,
      },
    }));

    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            artifact: {
              name: "Many-links session",
              status: "completed",
              slug: "SES-MANY",
              project: null,
              sourceLinks,
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

    // The wire array is complete — never sliced server-side...
    expect(result.items[0]?.linkedArtifacts).toHaveLength(total);
    // ...and the resolved total agrees with it.
    expect(result.items[0]?.linkedArtifactsTotal).toBe(total);
  });

  // An under-budget session reports total === served, so the UI shows no
  // (misleading) overflow chip.
  it("reports linkedArtifactsTotal equal to the served count when under budget", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            artifact: {
              name: "Under-budget session",
              status: "completed",
              slug: "SES-UNDER",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    role: "input",
                    method: "mcp_tool_call",
                    isPrimary: false,
                  },
                  target: {
                    id: "doc-artifact-1",
                    name: "Runbook",
                    slug: "DOC-1",
                    type: "DOCUMENT",
                    subtype: DocumentType.Doc,
                    branch: null,
                  },
                },
              ],
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

    expect(result.items[0]?.linkedArtifacts).toHaveLength(1);
    expect(result.items[0]?.linkedArtifactsTotal).toBe(1);
  });
});
