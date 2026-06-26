import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
} from "@repo/api/src/types/branch-view";
import { StatusCheckRollupFailureReason } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import {
  normalizeFailureReason,
  normalizeProviderState,
  projectBranchStatusChecks,
  sanitizeProjectedUrl,
} from "./branch-status-checks";

// ---------------------------------------------------------------------------
// sanitizeProjectedUrl
// ---------------------------------------------------------------------------

describe("sanitizeProjectedUrl", () => {
  it.each([
    [
      "https URL",
      "https://github.com/checks/123",
      "https://github.com/checks/123",
    ],
    ["http URL", "http://example.com/status", "http://example.com/status"],
    [
      "https URL with path and query",
      "https://ci.example.com/build/42?ref=main",
      "https://ci.example.com/build/42?ref=main",
    ],
  ])("allows %s", (_label, input, expected) => {
    expect(sanitizeProjectedUrl(input)).toBe(expected);
  });

  it.each([
    ["null", null],
    ["empty string", ""],
    ["javascript: scheme", "javascript:alert(1)"],
    ["data: scheme", "data:text/html,<h1>hi</h1>"],
    ["relative path", "/checks/123"],
    ["bare word", "notaurl"],
    ["ftp: scheme", "ftp://ftp.example.com/file"],
  ])("rejects %s", (_label, input) => {
    expect(sanitizeProjectedUrl(input as string | null)).toBeNull();
  });

  it("rejects a URL exceeding 2048 characters", () => {
    const long = `https://example.com/${"a".repeat(2048)}`;
    expect(sanitizeProjectedUrl(long)).toBeNull();
  });

  it("accepts a URL exactly at the 2048-character limit", () => {
    // Build a URL that is exactly 2048 chars
    const base = "https://example.com/";
    const padding = "a".repeat(2048 - base.length);
    const url = `${base}${padding}`;
    expect(url.length).toBe(2048);
    expect(sanitizeProjectedUrl(url)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeProviderState
// ---------------------------------------------------------------------------

describe("normalizeProviderState", () => {
  it.each([
    [
      BranchViewChecksProviderState.Available,
      BranchViewChecksProviderState.Available,
    ],
    [
      BranchViewChecksProviderState.NoChecks,
      BranchViewChecksProviderState.NoChecks,
    ],
    [
      BranchViewChecksProviderState.ProviderUnavailable,
      BranchViewChecksProviderState.ProviderUnavailable,
    ],
  ])("passes through known value %s", (input, expected) => {
    expect(normalizeProviderState(input)).toBe(expected);
  });

  it.each([
    ["null", null],
    ["unknown string", "UNKNOWN_STATE"],
    ["empty string", ""],
  ])("returns null for %s", (_label, input) => {
    expect(normalizeProviderState(input as string | null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeFailureReason
// ---------------------------------------------------------------------------

describe("normalizeFailureReason", () => {
  it.each([
    [
      StatusCheckRollupFailureReason.InvalidInput,
      StatusCheckRollupFailureReason.InvalidInput,
    ],
    [
      StatusCheckRollupFailureReason.RateLimited,
      StatusCheckRollupFailureReason.RateLimited,
    ],
    [
      StatusCheckRollupFailureReason.PermissionDenied,
      StatusCheckRollupFailureReason.PermissionDenied,
    ],
    [
      StatusCheckRollupFailureReason.GraphqlError,
      StatusCheckRollupFailureReason.GraphqlError,
    ],
  ])("passes through known value %s", (input, expected) => {
    expect(normalizeFailureReason(input)).toBe(expected);
  });

  it.each([
    ["null", null],
    ["unknown string", "some_new_reason"],
    ["empty string", ""],
  ])("returns null for %s", (_label, input) => {
    expect(normalizeFailureReason(input as string | null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// projectBranchStatusChecks
// ---------------------------------------------------------------------------

type ProjectionInput = Parameters<typeof projectBranchStatusChecks>[0];

function makeInput(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    artifactId: "art-1",
    headSha: "abc123",
    checksDetailHeadSha: "abc123",
    checksDetailTotalCount: 1,
    checksDetailTruncated: false,
    checksDetailProviderState: BranchViewChecksProviderState.Available,
    checksDetailUnavailableReason: null,
    checksDetailUpdatedAt: new Date("2024-01-01T00:00:00Z"),
    statusChecks: [],
    ...overrides,
  };
}

describe("projectBranchStatusChecks", () => {
  it("returns undefined when headSha is null", () => {
    expect(
      projectBranchStatusChecks(makeInput({ headSha: null }))
    ).toBeUndefined();
  });

  it("returns undefined when checksDetailHeadSha is null", () => {
    expect(
      projectBranchStatusChecks(makeInput({ checksDetailHeadSha: null }))
    ).toBeUndefined();
  });

  it("returns undefined when headSha does not match checksDetailHeadSha (stale-head guard)", () => {
    expect(
      projectBranchStatusChecks(
        makeInput({ headSha: "abc123", checksDetailHeadSha: "stale999" })
      )
    ).toBeUndefined();
  });

  it("returns undefined when checksDetailUpdatedAt is null", () => {
    expect(
      projectBranchStatusChecks(makeInput({ checksDetailUpdatedAt: null }))
    ).toBeUndefined();
  });

  it("returns undefined when providerState is unknown/unrecognized", () => {
    expect(
      projectBranchStatusChecks(
        makeInput({ checksDetailProviderState: "GARBAGE" })
      )
    ).toBeUndefined();
  });

  it("returns empty items for ProviderUnavailable regardless of statusChecks", () => {
    const result = projectBranchStatusChecks(
      makeInput({
        checksDetailProviderState:
          BranchViewChecksProviderState.ProviderUnavailable,
        checksDetailUnavailableReason:
          StatusCheckRollupFailureReason.RateLimited,
        statusChecks: [
          {
            providerKey: "key1",
            headSha: "abc123",
            kind: BranchViewCheckKind.CheckRun,
            name: "CI",
            status: "completed",
            conclusion: "success",
            targetUrl: "https://ci.example.com/1",
            position: 0,
          },
        ],
      })
    );
    expect(result).toBeDefined();
    expect(result?.items).toHaveLength(0);
    expect(result?.providerState).toBe(
      BranchViewChecksProviderState.ProviderUnavailable
    );
    expect(result?.unavailableReason).toBe(
      StatusCheckRollupFailureReason.RateLimited
    );
  });

  it("filters out rows whose headSha does not match the detail head", () => {
    const result = projectBranchStatusChecks(
      makeInput({
        statusChecks: [
          {
            providerKey: "key-stale",
            headSha: "other-sha",
            kind: BranchViewCheckKind.CheckRun,
            name: "Stale",
            status: "completed",
            conclusion: "success",
            targetUrl: null,
            position: 0,
          },
          {
            providerKey: "key-current",
            headSha: "abc123",
            kind: BranchViewCheckKind.CheckRun,
            name: "Current",
            status: "completed",
            conclusion: "success",
            targetUrl: null,
            position: 1,
          },
        ],
      })
    );
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0].id).toBe("key-current");
  });

  it("filters out rows with unknown kind", () => {
    const result = projectBranchStatusChecks(
      makeInput({
        statusChecks: [
          {
            providerKey: "key1",
            headSha: "abc123",
            kind: "unknown_kind",
            name: "Weird",
            status: null,
            conclusion: null,
            targetUrl: null,
            position: 0,
          },
          {
            providerKey: "key2",
            headSha: "abc123",
            kind: BranchViewCheckKind.StatusContext,
            name: "Good",
            status: "pending",
            conclusion: null,
            targetUrl: null,
            position: 1,
          },
        ],
      })
    );
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0].id).toBe("key2");
  });

  it("sorts items by position ascending", () => {
    const result = projectBranchStatusChecks(
      makeInput({
        checksDetailTotalCount: 3,
        statusChecks: [
          {
            providerKey: "key-c",
            headSha: "abc123",
            kind: BranchViewCheckKind.CheckRun,
            name: "C",
            status: "completed",
            conclusion: "success",
            targetUrl: null,
            position: 10,
          },
          {
            providerKey: "key-a",
            headSha: "abc123",
            kind: BranchViewCheckKind.CheckRun,
            name: "A",
            status: "completed",
            conclusion: "success",
            targetUrl: null,
            position: 0,
          },
          {
            providerKey: "key-b",
            headSha: "abc123",
            kind: BranchViewCheckKind.StatusContext,
            name: "B",
            status: "pending",
            conclusion: null,
            targetUrl: null,
            position: 5,
          },
        ],
      })
    );
    expect(result?.items.map((i) => i.id)).toEqual(["key-a", "key-b", "key-c"]);
  });

  it("sanitizes targetUrl in projected items — drops javascript: URLs", () => {
    const result = projectBranchStatusChecks(
      makeInput({
        statusChecks: [
          {
            providerKey: "key1",
            headSha: "abc123",
            kind: BranchViewCheckKind.CheckRun,
            name: "Sneaky",
            status: "completed",
            conclusion: "failure",
            targetUrl: "javascript:alert(1)",
            position: 0,
          },
        ],
      })
    );
    expect(result?.items[0].targetUrl).toBeNull();
  });

  it("returns NoChecks projection with empty items when provider state is NoChecks", () => {
    const result = projectBranchStatusChecks(
      makeInput({
        checksDetailProviderState: BranchViewChecksProviderState.NoChecks,
        checksDetailTotalCount: 0,
        statusChecks: [],
      })
    );
    expect(result).toBeDefined();
    expect(result?.providerState).toBe(BranchViewChecksProviderState.NoChecks);
    expect(result?.unavailableReason).toBeNull();
    expect(result?.items).toHaveLength(0);
  });
});
