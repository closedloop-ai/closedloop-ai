/**
 * Branch coverage for the private repository-snapshot, user, and nullable
 * shaping functions inside create-document.ts.  All shaping logic is private,
 * so we drive it through the public `registerCreateDocument` handler using the
 * shared tool-harness fixture.
 *
 * Covered arms:
 *   - readNullableNumberProp null branch (sortOrder = null)
 *   - readNullableUserProp null branch (assignee = null)
 *   - shapeRepositorySnapshot: missing / non-array repositories → undefined
 *   - shapeRepositorySnapshotEntry: null fullName → filtered out
 *   - shapeRepositorySnapshotEntry: empty fullName → filtered out
 *   - readRepositoryRole: unknown → omit key
 *   - readRepositoryRole: Primary → include key
 *   - readRepositoryRole: Additional → include key
 *   - readSnapshotSource: unknown → omit key
 *   - readSnapshotSource: valid → include key
 */

import {
  RepositoryRole,
  SnapshotSource,
} from "@repo/api/src/types/document.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerCreateDocument } from "../tools/create-document.js";
import {
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

const mockPost = vi.fn();
const apiClient = { post: mockPost } as unknown as ApiClient;
const handler = createToolHarness(registerCreateDocument, apiClient);

// The tool harness bypasses Zod validation; pass the minimum required fields.
const BASE_INPUT = {
  title: "Test Doc",
  type: "PRD",
  projectId: "PRO-1",
  content: "body text",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// readNullableNumberProp — null arm
// ---------------------------------------------------------------------------

it("includes sortOrder as null when the API returns an explicit null", async () => {
  mockPost.mockResolvedValueOnce({ sortOrder: null });

  const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
    string,
    unknown
  >;

  expect(output).toHaveProperty("sortOrder", null);
});

// ---------------------------------------------------------------------------
// readNullableUserProp — null arm
// ---------------------------------------------------------------------------

it("includes user-shaped keys as null when the API returns null (e.g. assignee)", async () => {
  mockPost.mockResolvedValueOnce({
    assignee: null,
    approver: null,
    createdBy: null,
  });

  const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
    string,
    unknown
  >;

  expect(output).toHaveProperty("assignee", null);
  expect(output).toHaveProperty("approver", null);
  expect(output).toHaveProperty("createdBy", null);
});

// ---------------------------------------------------------------------------
// shapeRepositorySnapshot — undefined when field absent or not an object
// ---------------------------------------------------------------------------

it("omits repositorySnapshot when the API returns no snapshot field", async () => {
  mockPost.mockResolvedValueOnce({});

  const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
    string,
    unknown
  >;

  expect(output).not.toHaveProperty("repositorySnapshot");
});

it("omits repositorySnapshot when its repositories property is not an array", async () => {
  mockPost.mockResolvedValueOnce({
    repositorySnapshot: { repositories: "not-an-array" },
  });

  const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
    string,
    unknown
  >;

  expect(output).not.toHaveProperty("repositorySnapshot");
});

// ---------------------------------------------------------------------------
// shapeRepositorySnapshotEntry — null / empty fullName → filter out
// ---------------------------------------------------------------------------

describe("shapeRepositorySnapshotEntry filtering", () => {
  it("filters out entries whose fullName is null, keeping valid entries", async () => {
    mockPost.mockResolvedValueOnce({
      repositorySnapshot: {
        repositories: [{ fullName: null }, { fullName: "owner/valid-repo" }],
      },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const snapshot = output.repositorySnapshot as {
      repositories: { fullName: string }[];
    };
    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]?.fullName).toBe("owner/valid-repo");
  });

  it("filters out entries whose fullName is an empty string", async () => {
    mockPost.mockResolvedValueOnce({
      repositorySnapshot: {
        repositories: [{ fullName: "" }, { fullName: "owner/another-repo" }],
      },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const snapshot = output.repositorySnapshot as {
      repositories: { fullName: string }[];
    };
    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]?.fullName).toBe("owner/another-repo");
  });
});

// ---------------------------------------------------------------------------
// readRepositoryRole — unknown / Primary / Additional
// ---------------------------------------------------------------------------

describe("readRepositoryRole", () => {
  it("omits the role key when the API value is not a recognised RepositoryRole", async () => {
    mockPost.mockResolvedValueOnce({
      repositorySnapshot: {
        repositories: [{ fullName: "o/r", role: "unknown-role" }],
      },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const snapshot = output.repositorySnapshot as {
      repositories: Record<string, unknown>[];
    };
    expect(snapshot.repositories[0]).not.toHaveProperty("role");
  });

  it("includes role when the API returns RepositoryRole.Primary", async () => {
    mockPost.mockResolvedValueOnce({
      repositorySnapshot: {
        repositories: [{ fullName: "o/r", role: RepositoryRole.Primary }],
      },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const snapshot = output.repositorySnapshot as {
      repositories: Record<string, unknown>[];
    };
    expect(snapshot.repositories[0]).toHaveProperty(
      "role",
      RepositoryRole.Primary
    );
  });

  it("includes role when the API returns RepositoryRole.Additional", async () => {
    mockPost.mockResolvedValueOnce({
      repositorySnapshot: {
        repositories: [{ fullName: "o/r2", role: RepositoryRole.Additional }],
      },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const snapshot = output.repositorySnapshot as {
      repositories: Record<string, unknown>[];
    };
    expect(snapshot.repositories[0]).toHaveProperty(
      "role",
      RepositoryRole.Additional
    );
  });
});

// ---------------------------------------------------------------------------
// readSnapshotSource — unknown / valid
// ---------------------------------------------------------------------------

describe("readSnapshotSource", () => {
  it("omits the source key when the API returns an unrecognised snapshot source", async () => {
    mockPost.mockResolvedValueOnce({
      repositorySnapshot: {
        repositories: [],
        source: "unrecognised-source",
      },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const snapshot = output.repositorySnapshot as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty("source");
  });

  it("includes source when the API returns a valid SnapshotSource value", async () => {
    mockPost.mockResolvedValueOnce({
      repositorySnapshot: {
        repositories: [],
        source: SnapshotSource.LoopSelection,
      },
    });

    const output = parseToolPayload(await handler(BASE_INPUT)) as Record<
      string,
      unknown
    >;

    const snapshot = output.repositorySnapshot as Record<string, unknown>;
    expect(snapshot).toHaveProperty("source", SnapshotSource.LoopSelection);
  });
});
