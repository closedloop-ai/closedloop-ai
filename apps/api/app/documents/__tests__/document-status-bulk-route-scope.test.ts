/**
 * ISS-9559: the bulk status route demands the scope the capability advertises.
 *
 * The capability tells a caller whether it may run a bulk status write. If the
 * route's own `requiredScopes` drifted from the table behind that answer, the
 * advertisement would be a guess. The route cannot import that table — an AST
 * test reads its scopes and understands only string literals — so this pins
 * what the route actually registers against a hand-written literal, and the
 * sibling capability test pins the table to the same one.
 */
import { describe, expect, it, vi } from "vitest";

const capturedRequiredScopes = vi.hoisted(() => [] as unknown[]);

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (_handler: unknown, options?: { requiredScopes?: unknown }) => {
    capturedRequiredScopes.push(options?.requiredScopes);
    return vi.fn();
  },
}));

vi.mock("@/app/documents/document-status-mutation-service", () => ({
  documentStatusMutationService: { batchUpdateStatus: vi.fn() },
}));
vi.mock("@/app/documents/blocked-dependent-unblock-service", () => ({
  blockedDependentUnblockService: {
    resolveBlocksForChangedArtifacts: vi.fn(),
  },
}));
vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: vi.fn(),
  userAuditActor: vi.fn(),
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchStatusChange: vi.fn(),
}));

import "../batch-update-status/route";

describe("POST /documents/batch-update-status authorization", () => {
  it("is registered demanding the write scope", () => {
    // Length first: an empty array would satisfy a `toEqual` against nothing,
    // which is what a route that stopped declaring scopes would produce.
    expect(capturedRequiredScopes).toHaveLength(1);
    expect(capturedRequiredScopes).toEqual([["write"]]);
  });
});
