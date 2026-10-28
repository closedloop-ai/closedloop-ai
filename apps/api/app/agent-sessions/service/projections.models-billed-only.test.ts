import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("ISS-7895: models = billed-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("detail — models derived from tokenUsageByModel", () => {
    it("returns [] when tokenUsageByModel is empty (declared model preserved in primaryModel)", async () => {
      installDb({
        sessionDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValue(
              buildSessionDetailRecord({ tokenUsageByModel: [] })
            ),
        },
      });
      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });
      expect(result).not.toBeNull();
      expect(result!.models).toEqual([]);
      expect(result!.primaryModel).toBe("claude-sonnet-4");
    });

    it("returns the distinct billed set (order-insensitive)", async () => {
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              tokenUsageByModel: [
                {
                  model: "gpt-5.5",
                  inputTokens: 100,
                  outputTokens: 50,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  estimatedCost: 0.5,
                },
                {
                  model: "claude-sonnet-4",
                  inputTokens: 200,
                  outputTokens: 100,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  estimatedCost: 1.0,
                },
                {
                  model: "gpt-5.5",
                  inputTokens: 50,
                  outputTokens: 25,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  estimatedCost: 0.25,
                },
              ],
            })
          ),
        },
      });
      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });
      expect(result).not.toBeNull();
      expect([...result!.models!].sort()).toEqual(
        ["claude-sonnet-4", "gpt-5.5"].sort()
      );
    });

    it("drops a zeroed row and keeps its billed sibling (whitlockk review: row presence is not billing)", async () => {
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              tokenUsageByModel: [
                {
                  model: "gpt-5.5",
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  estimatedCost: 0,
                },
                {
                  model: "claude-sonnet-4",
                  inputTokens: 120,
                  outputTokens: 40,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  estimatedCost: 0.75,
                },
              ],
            })
          ),
        },
      });
      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });
      expect(result).not.toBeNull();
      expect(result!.models).toEqual(["claude-sonnet-4"]);
    });

    it("counts a priced row whose token counters are all zero", async () => {
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              tokenUsageByModel: [
                {
                  model: "gpt-5.5",
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  estimatedCost: 0.03,
                },
              ],
            })
          ),
        },
      });
      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });
      expect(result).not.toBeNull();
      expect(result!.models).toEqual(["gpt-5.5"]);
    });
  });

  describe("list — models key omitted", () => {
    it("toSessionListItem does not include a models key", () => {
      const record = buildSessionListRecord();
      const item = toSessionListItem(record as AgentSessionListRecord);
      expect("models" in item).toBe(false);
    });

    it("retains the raw lifecycle evidence beside the display projection", () => {
      const record = buildSessionListRecord({
        artifact: {
          organizationId: "org-1",
          name: "Session One",
          status: "quantum-flux",
          slug: "SES-1",
          project: {
            id: "project-1",
            name: "Agent Platform",
            slug: "agent-platform",
          },
          sourceLinks: [],
        },
      });
      const item = toSessionListItem(record as AgentSessionListRecord);

      expect(item.rawStatus).toBe("quantum-flux");
    });
  });
});
