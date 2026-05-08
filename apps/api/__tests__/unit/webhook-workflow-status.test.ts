/**
 * Unit tests for webhook workflow status handler.
 *
 * Tests the following function:
 * - handleWorkflowStatusUpdate: handles workflow status updates (requested, in_progress)
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// Mock modules before importing the handler
vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  parseCorrelationId: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { withDb } from "@repo/database";
// Import after mocking
import { parseCorrelationId } from "@repo/github";
import { log } from "@repo/observability/log";
import { handleWorkflowStatusUpdate } from "@/app/webhooks/github/handlers/workflow-status-handler";

// Type aliases for mocked functions
const mockWithDb = withDb as unknown as Mock;
const mockParseCorrelationId = parseCorrelationId as Mock;

describe("handleWorkflowStatusUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("correlation ID validation", () => {
    it("returns success with warning when correlation ID format is invalid", async () => {
      const invalidCorrelationId = "invalid-format";

      mockParseCorrelationId.mockReturnValue(null);

      const response = await handleWorkflowStatusUpdate(
        invalidCorrelationId,
        "requested",
        "123456",
        "https://github.com/owner/repo/actions/runs/123456"
      );

      expect(mockParseCorrelationId).toHaveBeenCalledWith(invalidCorrelationId);
      expect(log.warn).toHaveBeenCalledWith(
        "[webhook/github] Invalid correlation ID format",
        {
          correlationId: invalidCorrelationId,
          action: "requested",
        }
      );

      const json = await response.json();
      expect(json).toEqual({
        message: "Invalid correlation ID format",
        ok: true,
      });
      expect(mockWithDb).not.toHaveBeenCalled();
    });

    it("handles correlation IDs with missing env prefix", async () => {
      const correlationId = "no-dash-separator";

      mockParseCorrelationId.mockReturnValue(null);

      const response = await handleWorkflowStatusUpdate(
        correlationId,
        "in_progress",
        "789012",
        "https://github.com/owner/repo/actions/runs/789012"
      );

      expect(mockParseCorrelationId).toHaveBeenCalledWith(correlationId);
      expect(log.warn).toHaveBeenCalled();

      const json = await response.json();
      expect(json.ok).toBe(true);
      expect(json.message).toBe("Invalid correlation ID format");
    });
  });

  describe("action run lookup", () => {
    beforeEach(() => {
      mockParseCorrelationId.mockReturnValue({
        env: "local",
        id: "test-id-123",
      });
    });

    it("returns success when no matching action run is found", async () => {
      const correlationId = "local-test-id-123";
      const runId = "123456";

      // Mock findActionRunByCorrelationId returning undefined
      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          gitHubActionRun: {
            findMany: vi.fn().mockResolvedValue([]),
          },
        };
        return callback(mockDb);
      });

      const response = await handleWorkflowStatusUpdate(
        correlationId,
        "requested",
        runId,
        "https://github.com/owner/repo/actions/runs/123456"
      );

      expect(log.info).toHaveBeenCalledWith(
        "[webhook/github] No GitHubActionRun found for status update",
        {
          correlationId,
          action: "requested",
          runId,
        }
      );

      const json = await response.json();
      expect(json).toEqual({
        message: `No matching action run found for correlation ${correlationId}`,
        ok: true,
      });
    });

    it("finds action run when correlation ID matches in triggerData", async () => {
      const correlationId = "stage-workflow-abc";
      const runId = "789012";
      const htmlUrl = "https://github.com/owner/repo/actions/runs/789012";

      const mockActionRun = {
        id: "run-123",
        workstreamId: "ws-123",
        repositoryId: "repo-123",
        runId: "0",
        workflowName: "symphony-dispatch",
        status: "PENDING",
        htmlUrl: null,
        triggerEvent: "workflow_dispatch",
        triggerData: { correlationId },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let updateCalled = false;
      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          gitHubActionRun: {
            findMany: vi.fn().mockResolvedValue([mockActionRun]),
            update: vi.fn((args: any) => {
              updateCalled = true;
              return Promise.resolve({
                ...mockActionRun,
                ...args.data,
              });
            }),
          },
        };
        return callback(mockDb);
      });

      mockParseCorrelationId.mockReturnValue({
        env: "stage",
        id: "workflow-abc",
      });

      const response = await handleWorkflowStatusUpdate(
        correlationId,
        "requested",
        runId,
        htmlUrl
      );

      expect(updateCalled).toBe(true);

      const json = await response.json();
      expect(json).toEqual({
        result: "status_updated",
        ok: true,
      });

      expect(log.info).toHaveBeenCalledWith(
        "[webhook/github] Updated GitHubActionRun status",
        {
          actionRunId: mockActionRun.id,
          correlationId,
          newStatus: "QUEUED",
          runId,
        }
      );
    });
  });

  describe("status update for 'requested' action", () => {
    const correlationId = "prod-artifact-xyz";
    const runId = "555555";
    const htmlUrl = "https://github.com/owner/repo/actions/runs/555555";

    beforeEach(() => {
      mockParseCorrelationId.mockReturnValue({
        env: "prod",
        id: "artifact-xyz",
      });
    });

    it("updates status to QUEUED and sets runId and htmlUrl", async () => {
      const mockActionRun = {
        id: "run-abc",
        workstreamId: "ws-abc",
        repositoryId: "repo-abc",
        runId: "0",
        workflowName: "symphony-dispatch",
        status: "PENDING",
        htmlUrl: null,
        triggerEvent: "workflow_dispatch",
        triggerData: { correlationId },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let capturedUpdateData: any;
      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          gitHubActionRun: {
            findMany: vi.fn().mockResolvedValue([mockActionRun]),
            update: vi.fn((args: any) => {
              capturedUpdateData = args.data;
              return Promise.resolve({
                ...mockActionRun,
                ...args.data,
              });
            }),
          },
        };
        return callback(mockDb);
      });

      const response = await handleWorkflowStatusUpdate(
        correlationId,
        "requested",
        runId,
        htmlUrl
      );

      expect(capturedUpdateData).toEqual({
        runId,
        status: "QUEUED",
        htmlUrl,
      });

      const json = await response.json();
      expect(json.result).toBe("status_updated");
      expect(json.ok).toBe(true);
    });

    it("does not set startedAt for 'requested' action", async () => {
      const mockActionRun = {
        id: "run-def",
        workstreamId: "ws-def",
        repositoryId: "repo-def",
        runId: "0",
        workflowName: "symphony-dispatch",
        status: "PENDING",
        htmlUrl: null,
        triggerEvent: "workflow_dispatch",
        triggerData: { correlationId },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let capturedUpdateData: any;
      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          gitHubActionRun: {
            findMany: vi.fn().mockResolvedValue([mockActionRun]),
            update: vi.fn((args: any) => {
              capturedUpdateData = args.data;
              return Promise.resolve({
                ...mockActionRun,
                ...args.data,
              });
            }),
          },
        };
        return callback(mockDb);
      });

      await handleWorkflowStatusUpdate(
        correlationId,
        "requested",
        runId,
        htmlUrl
      );

      expect(capturedUpdateData).not.toHaveProperty("startedAt");
      expect(capturedUpdateData.status).toBe("QUEUED");
    });
  });

  describe("status update for 'in_progress' action", () => {
    const correlationId = "local-feature-123";
    const runId = "999999";
    const htmlUrl = "https://github.com/owner/repo/actions/runs/999999";

    beforeEach(() => {
      mockParseCorrelationId.mockReturnValue({
        env: "local",
        id: "feature-123",
      });
    });

    it("updates status to RUNNING and sets runId, htmlUrl, and startedAt", async () => {
      const mockActionRun = {
        id: "run-xyz",
        workstreamId: "ws-xyz",
        repositoryId: "repo-xyz",
        runId: "0",
        workflowName: "symphony-dispatch",
        status: "QUEUED",
        htmlUrl: null,
        triggerEvent: "workflow_dispatch",
        triggerData: { correlationId },
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
      };

      let capturedUpdateData: any;
      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          gitHubActionRun: {
            findMany: vi.fn().mockResolvedValue([mockActionRun]),
            update: vi.fn((args: any) => {
              capturedUpdateData = args.data;
              return Promise.resolve({
                ...mockActionRun,
                ...args.data,
              });
            }),
          },
        };
        return callback(mockDb);
      });

      const response = await handleWorkflowStatusUpdate(
        correlationId,
        "in_progress",
        runId,
        htmlUrl
      );

      expect(capturedUpdateData).toHaveProperty("startedAt");
      expect(capturedUpdateData.startedAt).toBeInstanceOf(Date);
      expect(capturedUpdateData.status).toBe("RUNNING");
      expect(capturedUpdateData.runId).toEqual(runId);
      expect(capturedUpdateData.htmlUrl).toBe(htmlUrl);

      const json = await response.json();
      expect(json.result).toBe("status_updated");
      expect(json.ok).toBe(true);
    });

    it("sets startedAt to current timestamp", async () => {
      const beforeUpdate = new Date();

      const mockActionRun = {
        id: "run-timestamp",
        workstreamId: "ws-timestamp",
        repositoryId: "repo-timestamp",
        runId: "0",
        workflowName: "symphony-dispatch",
        status: "QUEUED",
        htmlUrl: null,
        triggerEvent: "workflow_dispatch",
        triggerData: { correlationId },
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
      };

      let capturedUpdateData: any;
      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          gitHubActionRun: {
            findMany: vi.fn().mockResolvedValue([mockActionRun]),
            update: vi.fn((args: any) => {
              capturedUpdateData = args.data;
              return Promise.resolve({
                ...mockActionRun,
                ...args.data,
              });
            }),
          },
        };
        return callback(mockDb);
      });

      await handleWorkflowStatusUpdate(
        correlationId,
        "in_progress",
        runId,
        htmlUrl
      );

      const afterUpdate = new Date();

      expect(capturedUpdateData.startedAt).toBeInstanceOf(Date);
      expect(capturedUpdateData.startedAt.getTime()).toBeGreaterThanOrEqual(
        beforeUpdate.getTime()
      );
      expect(capturedUpdateData.startedAt.getTime()).toBeLessThanOrEqual(
        afterUpdate.getTime()
      );
    });
  });

  describe("edge cases", () => {
    beforeEach(() => {
      mockParseCorrelationId.mockReturnValue({
        env: "stage",
        id: "test-123",
      });
    });

    it("handles action runs with null triggerData", async () => {
      const correlationId = "stage-test-123";
      const mockActionRun = {
        id: "run-null",
        workstreamId: "ws-null",
        repositoryId: "repo-null",
        runId: "123",
        workflowName: "symphony-dispatch",
        status: "PENDING",
        htmlUrl: null,
        triggerEvent: "workflow_dispatch",
        triggerData: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          gitHubActionRun: {
            findMany: vi.fn().mockResolvedValue([mockActionRun]),
          },
        };
        return callback(mockDb);
      });

      const response = await handleWorkflowStatusUpdate(
        correlationId,
        "requested",
        "123456",
        "https://github.com/owner/repo/actions/runs/123456"
      );

      const json = await response.json();
      expect(json.message).toContain("No matching action run found");
      expect(json.ok).toBe(true);
    });

    it("handles action runs with triggerData missing correlationId field", async () => {
      const correlationId = "stage-test-123";
      const mockActionRun = {
        id: "run-no-correlation",
        workstreamId: "ws-no-correlation",
        repositoryId: "repo-no-correlation",
        runId: "123",
        workflowName: "symphony-dispatch",
        status: "PENDING",
        htmlUrl: null,
        triggerEvent: "workflow_dispatch",
        triggerData: { otherField: "value" },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          gitHubActionRun: {
            findMany: vi.fn().mockResolvedValue([mockActionRun]),
          },
        };
        return callback(mockDb);
      });

      const response = await handleWorkflowStatusUpdate(
        correlationId,
        "requested",
        "123456",
        "https://github.com/owner/repo/actions/runs/123456"
      );

      const json = await response.json();
      expect(json.message).toContain("No matching action run found");
      expect(json.ok).toBe(true);
    });

    it("finds correct action run among multiple candidates", async () => {
      const correlationId = "stage-target-run";
      const runId = "888888";
      const htmlUrl = "https://github.com/owner/repo/actions/runs/888888";

      const mockActionRuns = [
        {
          id: "run-1",
          workstreamId: "ws-1",
          repositoryId: "repo-1",
          runId: "1",
          workflowName: "symphony-dispatch",
          status: "RUNNING",
          htmlUrl: "https://github.com/owner/repo/actions/runs/1",
          triggerEvent: "workflow_dispatch",
          triggerData: { correlationId: "stage-other-run-1" },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "run-2",
          workstreamId: "ws-2",
          repositoryId: "repo-2",
          runId: "2",
          workflowName: "symphony-dispatch",
          status: "QUEUED",
          htmlUrl: "https://github.com/owner/repo/actions/runs/2",
          triggerEvent: "workflow_dispatch",
          triggerData: { correlationId },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "run-3",
          workstreamId: "ws-3",
          repositoryId: "repo-3",
          runId: "3",
          workflowName: "symphony-dispatch",
          status: "RUNNING",
          htmlUrl: "https://github.com/owner/repo/actions/runs/3",
          triggerEvent: "workflow_dispatch",
          triggerData: { correlationId: "stage-other-run-3" },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      let updatedRunId: string | null = null;
      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          gitHubActionRun: {
            findMany: vi.fn().mockResolvedValue(mockActionRuns),
            update: vi.fn((args: any) => {
              updatedRunId = args.where.id;
              const run = mockActionRuns.find((r) => r.id === args.where.id);
              return Promise.resolve({
                ...run,
                ...args.data,
              });
            }),
          },
        };
        return callback(mockDb);
      });

      mockParseCorrelationId.mockReturnValue({
        env: "stage",
        id: "target-run",
      });

      const response = await handleWorkflowStatusUpdate(
        correlationId,
        "in_progress",
        runId,
        htmlUrl
      );

      expect(updatedRunId).toBe("run-2");

      const json = await response.json();
      expect(json.result).toBe("status_updated");
      expect(json.ok).toBe(true);
    });

    it("handles very large runId values", async () => {
      const correlationId = "local-big-run";
      const runId = String(Number.MAX_SAFE_INTEGER);
      const htmlUrl =
        "https://github.com/owner/repo/actions/runs/9007199254740991";

      const mockActionRun = {
        id: "run-big",
        workstreamId: "ws-big",
        repositoryId: "repo-big",
        runId: "0",
        workflowName: "symphony-dispatch",
        status: "PENDING",
        htmlUrl: null,
        triggerEvent: "workflow_dispatch",
        triggerData: { correlationId },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let capturedUpdateData: any;
      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          gitHubActionRun: {
            findMany: vi.fn().mockResolvedValue([mockActionRun]),
            update: vi.fn((args: any) => {
              capturedUpdateData = args.data;
              return Promise.resolve({
                ...mockActionRun,
                ...args.data,
              });
            }),
          },
        };
        return callback(mockDb);
      });

      mockParseCorrelationId.mockReturnValue({
        env: "local",
        id: "big-run",
      });

      await handleWorkflowStatusUpdate(
        correlationId,
        "requested",
        runId,
        htmlUrl
      );

      expect(capturedUpdateData.runId).toEqual(runId);
    });
  });

  describe("logging", () => {
    beforeEach(() => {
      mockParseCorrelationId.mockReturnValue({
        env: "prod",
        id: "logging-test",
      });
    });

    it("logs info message on successful update", async () => {
      const correlationId = "prod-logging-test";
      const runId = "111111";
      const htmlUrl = "https://github.com/owner/repo/actions/runs/111111";

      const mockActionRun = {
        id: "run-log",
        workstreamId: "ws-log",
        repositoryId: "repo-log",
        runId: "0",
        workflowName: "symphony-dispatch",
        status: "PENDING",
        htmlUrl: null,
        triggerEvent: "workflow_dispatch",
        triggerData: { correlationId },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          gitHubActionRun: {
            findMany: vi.fn().mockResolvedValue([mockActionRun]),
            update: vi.fn().mockResolvedValue({
              ...mockActionRun,
              status: "QUEUED",
              runId,
              htmlUrl,
            }),
          },
        };
        return callback(mockDb);
      });

      await handleWorkflowStatusUpdate(
        correlationId,
        "requested",
        runId,
        htmlUrl
      );

      expect(log.info).toHaveBeenCalledWith(
        "[webhook/github] Updated GitHubActionRun status",
        {
          actionRunId: mockActionRun.id,
          correlationId,
          newStatus: "QUEUED",
          runId,
        }
      );
    });

    it("includes correct newStatus in logs for in_progress action", async () => {
      const correlationId = "prod-logging-test";
      const runId = "222222";
      const htmlUrl = "https://github.com/owner/repo/actions/runs/222222";

      const mockActionRun = {
        id: "run-log-2",
        workstreamId: "ws-log-2",
        repositoryId: "repo-log-2",
        runId: "0",
        workflowName: "symphony-dispatch",
        status: "QUEUED",
        htmlUrl: null,
        triggerEvent: "workflow_dispatch",
        triggerData: { correlationId },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          gitHubActionRun: {
            findMany: vi.fn().mockResolvedValue([mockActionRun]),
            update: vi.fn().mockResolvedValue({
              ...mockActionRun,
              status: "RUNNING",
              runId,
              htmlUrl,
              startedAt: new Date(),
            }),
          },
        };
        return callback(mockDb);
      });

      await handleWorkflowStatusUpdate(
        correlationId,
        "in_progress",
        runId,
        htmlUrl
      );

      expect(log.info).toHaveBeenCalledWith(
        "[webhook/github] Updated GitHubActionRun status",
        expect.objectContaining({
          newStatus: "RUNNING",
        })
      );
    });
  });
});
