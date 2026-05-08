import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockGraphql = vi.fn();

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(() => async (_opts: unknown) => ({
    token: "test-token",
  })),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    graphql = mockGraphql;
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { queryStatusCheckRollup } from "../index";

const VALID_SHA = "a".repeat(40);
const INSTALLATION_ID = "12345";
const OWNER = "acme";
const REPO = "my-repo";

describe("queryStatusCheckRollup", () => {
  beforeAll(() => {
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-key";
    process.env.GITHUB_APP_WEBHOOK_SECRET = "test-secret";
    process.env.GITHUB_APP_CLIENT_ID = "test-client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
    process.env.GITHUB_APP_DISPATCH_REPO = "owner/dispatch";
    process.env.WEBAPP_ENV = "stage";
  });

  beforeEach(() => {
    mockGraphql.mockReset();
  });

  it("returns null when owner is empty", async () => {
    const result = await queryStatusCheckRollup(
      INSTALLATION_ID,
      "",
      REPO,
      VALID_SHA
    );

    expect(result).toBeNull();
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("returns null when repo is empty", async () => {
    const result = await queryStatusCheckRollup(
      INSTALLATION_ID,
      OWNER,
      "",
      VALID_SHA
    );

    expect(result).toBeNull();
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("returns null when commit SHA is not 40 characters", async () => {
    const result = await queryStatusCheckRollup(
      INSTALLATION_ID,
      OWNER,
      REPO,
      "abc123"
    );

    expect(result).toBeNull();
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("returns the rollup state on a successful query", async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: {
        object: {
          statusCheckRollup: { state: "SUCCESS" },
        },
      },
    });

    const result = await queryStatusCheckRollup(
      INSTALLATION_ID,
      OWNER,
      REPO,
      VALID_SHA
    );

    expect(result).toBe("SUCCESS");
    expect(mockGraphql).toHaveBeenCalledOnce();
  });

  it("returns null when statusCheckRollup is null (no checks configured)", async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: {
        object: {
          statusCheckRollup: null,
        },
      },
    });

    const result = await queryStatusCheckRollup(
      INSTALLATION_ID,
      OWNER,
      REPO,
      VALID_SHA
    );

    expect(result).toBeNull();
  });

  it("returns null when a rate limit error is thrown", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("API rate limit exceeded"));

    const result = await queryStatusCheckRollup(
      INSTALLATION_ID,
      OWNER,
      REPO,
      VALID_SHA
    );

    expect(result).toBeNull();
  });

  it("returns null when a 403 error is thrown", async () => {
    const error = Object.assign(new Error("Forbidden"), { status: 403 });
    mockGraphql.mockRejectedValueOnce(error);

    const result = await queryStatusCheckRollup(
      INSTALLATION_ID,
      OWNER,
      REPO,
      VALID_SHA
    );

    expect(result).toBeNull();
  });

  it("returns null when a generic error is thrown", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("Unexpected GraphQL failure"));

    const result = await queryStatusCheckRollup(
      INSTALLATION_ID,
      OWNER,
      REPO,
      VALID_SHA
    );

    expect(result).toBeNull();
  });
});
