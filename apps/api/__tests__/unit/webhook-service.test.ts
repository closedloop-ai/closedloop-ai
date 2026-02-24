/**
 * Unit tests for webhook service functions.
 *
 * Tests the following functions:
 * - findActionRunByCorrelationId: queries database for action run by correlation ID
 * - validateRequest: validates webhook request by parsing body and headers
 * - isGitHubConfigured: checks if GitHub-related env vars are set
 * - isS3Configured: checks if S3-related env vars are set
 */
import { type Mock, vi } from "vitest";

// Mock modules before importing the service
vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import { withDb } from "@repo/database";
// Import after mocking
import { headers } from "next/headers";
import {
  findActionRunByCorrelationId,
  isGitHubConfigured,
  isS3Configured,
  validateRequest,
} from "@/app/webhooks/github/webhook-service";

// Type aliases for mocked functions
const mockWithDb = withDb as unknown as Mock;
const mockHeaders = headers as Mock;

describe("isGitHubConfigured", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns true when all required GitHub env vars are set", () => {
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
    process.env.GITHUB_APP_WEBHOOK_SECRET = "secret123";
    process.env.GITHUB_APP_DISPATCH_REPO = "owner/repo";

    const result = isGitHubConfigured();

    expect(result).toBe(true);
  });

  it("returns false when GITHUB_APP_ID is missing", () => {
    process.env.GITHUB_APP_ID = undefined;
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
    process.env.GITHUB_APP_WEBHOOK_SECRET = "secret123";
    process.env.GITHUB_APP_DISPATCH_REPO = "owner/repo";

    const result = isGitHubConfigured();

    expect(result).toBe(false);
  });

  it("returns false when GITHUB_APP_PRIVATE_KEY is missing", () => {
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY = undefined;
    process.env.GITHUB_APP_WEBHOOK_SECRET = "secret123";
    process.env.GITHUB_APP_DISPATCH_REPO = "owner/repo";

    const result = isGitHubConfigured();

    expect(result).toBe(false);
  });

  it("returns false when GITHUB_APP_WEBHOOK_SECRET is missing", () => {
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
    process.env.GITHUB_APP_WEBHOOK_SECRET = undefined;
    process.env.GITHUB_APP_DISPATCH_REPO = "owner/repo";

    const result = isGitHubConfigured();

    expect(result).toBe(false);
  });

  it("returns false when GITHUB_APP_DISPATCH_REPO is missing", () => {
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
    process.env.GITHUB_APP_WEBHOOK_SECRET = "secret123";
    process.env.GITHUB_APP_DISPATCH_REPO = undefined;

    const result = isGitHubConfigured();

    expect(result).toBe(false);
  });

  it("returns false when all env vars are missing", () => {
    process.env.GITHUB_APP_ID = undefined;
    process.env.GITHUB_APP_PRIVATE_KEY = undefined;
    process.env.GITHUB_APP_WEBHOOK_SECRET = undefined;
    process.env.GITHUB_APP_DISPATCH_REPO = undefined;

    const result = isGitHubConfigured();

    expect(result).toBe(false);
  });

  it("returns false when env vars are empty strings", () => {
    process.env.GITHUB_APP_ID = "";
    process.env.GITHUB_APP_PRIVATE_KEY = "";
    process.env.GITHUB_APP_WEBHOOK_SECRET = "";
    process.env.GITHUB_APP_DISPATCH_REPO = "";

    const result = isGitHubConfigured();

    expect(result).toBe(false);
  });
});

describe("isS3Configured", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns true when all required S3 env vars are set", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env.FILE_ATTACHMENTS_BUCKET = "my-bucket";

    const result = isS3Configured();

    expect(result).toBe(true);
  });

  it("returns false when AWS_ACCESS_KEY_ID is missing", () => {
    process.env.AWS_ACCESS_KEY_ID = undefined;
    process.env.AWS_SECRET_ACCESS_KEY =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env.FILE_ATTACHMENTS_BUCKET = "my-bucket";

    const result = isS3Configured();

    expect(result).toBe(false);
  });

  it("returns false when AWS_SECRET_ACCESS_KEY is missing", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = undefined;
    process.env.FILE_ATTACHMENTS_BUCKET = "my-bucket";

    const result = isS3Configured();

    expect(result).toBe(false);
  });

  it("returns false when FILE_ATTACHMENTS_BUCKET is missing", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env.FILE_ATTACHMENTS_BUCKET = undefined;

    const result = isS3Configured();

    expect(result).toBe(false);
  });

  it("returns false when all env vars are missing", () => {
    process.env.AWS_ACCESS_KEY_ID = undefined;
    process.env.AWS_SECRET_ACCESS_KEY = undefined;
    process.env.FILE_ATTACHMENTS_BUCKET = undefined;

    const result = isS3Configured();

    expect(result).toBe(false);
  });

  it("returns false when env vars are empty strings", () => {
    process.env.AWS_ACCESS_KEY_ID = "";
    process.env.AWS_SECRET_ACCESS_KEY = "";
    process.env.FILE_ATTACHMENTS_BUCKET = "";

    const result = isS3Configured();

    expect(result).toBe(false);
  });
});

describe("validateRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts body, signature, and eventType from request", async () => {
    const requestBody = JSON.stringify({ action: "completed" });
    const request = new Request("http://localhost", {
      method: "POST",
      body: requestBody,
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": "sha256=abcdef123456",
        "x-github-event": "workflow_run",
      },
    });

    mockHeaders.mockResolvedValue({
      get: (key: string) => {
        const headers = {
          "x-hub-signature-256": "sha256=abcdef123456",
          "x-github-event": "workflow_run",
        };
        return headers[key as keyof typeof headers] || null;
      },
    });

    const result = await validateRequest(request);

    expect(result.body).toBe(requestBody);
    expect(result.signature).toBe("sha256=abcdef123456");
    expect(result.eventType).toBe("workflow_run");
  });

  it("returns null signature when header is missing", async () => {
    const requestBody = JSON.stringify({ action: "completed" });
    const request = new Request("http://localhost", {
      method: "POST",
      body: requestBody,
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "workflow_run",
      },
    });

    mockHeaders.mockResolvedValue({
      get: (key: string) => {
        const headers = {
          "x-github-event": "workflow_run",
        };
        return headers[key as keyof typeof headers] || null;
      },
    });

    const result = await validateRequest(request);

    expect(result.body).toBe(requestBody);
    expect(result.signature).toBeNull();
    expect(result.eventType).toBe("workflow_run");
  });

  it("returns null eventType when header is missing", async () => {
    const requestBody = JSON.stringify({ action: "completed" });
    const request = new Request("http://localhost", {
      method: "POST",
      body: requestBody,
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": "sha256=abcdef123456",
      },
    });

    mockHeaders.mockResolvedValue({
      get: (key: string) => {
        const headers = {
          "x-hub-signature-256": "sha256=abcdef123456",
        };
        return headers[key as keyof typeof headers] || null;
      },
    });

    const result = await validateRequest(request);

    expect(result.body).toBe(requestBody);
    expect(result.signature).toBe("sha256=abcdef123456");
    expect(result.eventType).toBeNull();
  });

  it("handles empty request body", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: "",
      headers: {
        "x-hub-signature-256": "sha256=abcdef123456",
        "x-github-event": "ping",
      },
    });

    mockHeaders.mockResolvedValue({
      get: (key: string) => {
        const headers = {
          "x-hub-signature-256": "sha256=abcdef123456",
          "x-github-event": "ping",
        };
        return headers[key as keyof typeof headers] || null;
      },
    });

    const result = await validateRequest(request);

    expect(result.body).toBe("");
    expect(result.signature).toBe("sha256=abcdef123456");
    expect(result.eventType).toBe("ping");
  });
});

describe("findActionRunByCorrelationId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds action run with matching correlation ID in active status", async () => {
    const correlationId = "test-correlation-123";
    const mockActionRun = {
      id: "run-123",
      workstreamId: "ws-123",
      repositoryId: "repo-123",
      runId: BigInt(1_234_567_890),
      workflowName: "symphony-dispatch",
      status: "RUNNING",
      htmlUrl: "https://github.com/owner/repo/actions/runs/1234567890",
      triggerEvent: "workflow_dispatch",
      triggerData: { correlationId: "test-correlation-123" },
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

    const result = await findActionRunByCorrelationId(correlationId);

    expect(result).toEqual(mockActionRun);
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });

  it("queries only active statuses when activeOnly is true", async () => {
    const correlationId = "test-correlation-123";

    let capturedQuery: any;
    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        gitHubActionRun: {
          findMany: vi.fn((query: any) => {
            capturedQuery = query;
            return Promise.resolve([]);
          }),
        },
      };
      return callback(mockDb);
    });

    await findActionRunByCorrelationId(correlationId, true);

    expect(capturedQuery.where).toEqual({
      workflowName: "symphony-dispatch",
      status: { in: ["PENDING", "QUEUED", "RUNNING"] },
    });
  });

  it("queries all statuses when activeOnly is false", async () => {
    const correlationId = "test-correlation-123";

    let capturedQuery: any;
    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        gitHubActionRun: {
          findMany: vi.fn((query: any) => {
            capturedQuery = query;
            return Promise.resolve([]);
          }),
        },
      };
      return callback(mockDb);
    });

    await findActionRunByCorrelationId(correlationId, false);

    expect(capturedQuery.where).toEqual({
      workflowName: "symphony-dispatch",
    });
  });

  it("returns undefined when no action run has matching correlation ID", async () => {
    const correlationId = "nonexistent-correlation";
    const mockActionRun = {
      id: "run-123",
      workstreamId: "ws-123",
      repositoryId: "repo-123",
      runId: BigInt(1_234_567_890),
      workflowName: "symphony-dispatch",
      status: "RUNNING",
      htmlUrl: "https://github.com/owner/repo/actions/runs/1234567890",
      triggerEvent: "workflow_dispatch",
      triggerData: { correlationId: "different-correlation-id" },
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

    const result = await findActionRunByCorrelationId(correlationId);

    expect(result).toBeUndefined();
  });

  it("returns undefined when no action runs exist", async () => {
    const correlationId = "test-correlation-123";

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        gitHubActionRun: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      return callback(mockDb);
    });

    const result = await findActionRunByCorrelationId(correlationId);

    expect(result).toBeUndefined();
  });

  it("handles action run with null triggerData", async () => {
    const correlationId = "test-correlation-123";
    const mockActionRun = {
      id: "run-123",
      workstreamId: "ws-123",
      repositoryId: "repo-123",
      runId: BigInt(1_234_567_890),
      workflowName: "symphony-dispatch",
      status: "RUNNING",
      htmlUrl: "https://github.com/owner/repo/actions/runs/1234567890",
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

    const result = await findActionRunByCorrelationId(correlationId);

    expect(result).toBeUndefined();
  });

  it("handles action run with triggerData without correlationId field", async () => {
    const correlationId = "test-correlation-123";
    const mockActionRun = {
      id: "run-123",
      workstreamId: "ws-123",
      repositoryId: "repo-123",
      runId: BigInt(1_234_567_890),
      workflowName: "symphony-dispatch",
      status: "RUNNING",
      htmlUrl: "https://github.com/owner/repo/actions/runs/1234567890",
      triggerEvent: "workflow_dispatch",
      triggerData: { someOtherField: "value" },
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

    const result = await findActionRunByCorrelationId(correlationId);

    expect(result).toBeUndefined();
  });

  it("finds matching run among multiple action runs", async () => {
    const correlationId = "test-correlation-123";
    const mockActionRuns = [
      {
        id: "run-1",
        workstreamId: "ws-123",
        repositoryId: "repo-123",
        runId: BigInt(1),
        workflowName: "symphony-dispatch",
        status: "RUNNING",
        htmlUrl: "https://github.com/owner/repo/actions/runs/1",
        triggerEvent: "workflow_dispatch",
        triggerData: { correlationId: "other-correlation-1" },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "run-2",
        workstreamId: "ws-123",
        repositoryId: "repo-123",
        runId: BigInt(2),
        workflowName: "symphony-dispatch",
        status: "RUNNING",
        htmlUrl: "https://github.com/owner/repo/actions/runs/2",
        triggerEvent: "workflow_dispatch",
        triggerData: { correlationId: "test-correlation-123" },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "run-3",
        workstreamId: "ws-123",
        repositoryId: "repo-123",
        runId: BigInt(3),
        workflowName: "symphony-dispatch",
        status: "RUNNING",
        htmlUrl: "https://github.com/owner/repo/actions/runs/3",
        triggerEvent: "workflow_dispatch",
        triggerData: { correlationId: "other-correlation-3" },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        gitHubActionRun: {
          findMany: vi.fn().mockResolvedValue(mockActionRuns),
        },
      };
      return callback(mockDb);
    });

    const result = await findActionRunByCorrelationId(correlationId);

    expect(result).toEqual(mockActionRuns[1]);
  });

  it("orders results by createdAt desc and limits to 50", async () => {
    const correlationId = "test-correlation-123";

    let capturedQuery: any;
    mockWithDb.mockImplementation((callback: any) => {
      const mockDb = {
        gitHubActionRun: {
          findMany: vi.fn((query: any) => {
            capturedQuery = query;
            return Promise.resolve([]);
          }),
        },
      };
      return callback(mockDb);
    });

    await findActionRunByCorrelationId(correlationId);

    expect(capturedQuery.orderBy).toEqual({ createdAt: "desc" });
    expect(capturedQuery.take).toBe(50);
  });
});
